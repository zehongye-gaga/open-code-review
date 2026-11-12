// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  { randomUUID, createHash } = require("node:crypto");
const { Client } = require("pg"),
  { PostgresStore } = require("../database/postgres.js"),
  { collect } = require("../collector.js"),
  { fixture } = require("../test-support.js");
if (!process.env.TEST_DATABASE_URL || !process.env.REVIEWHUB_MIGRATIONS_DIR)
  throw Error(
    "Use a dedicated TEST_DATABASE_URL and the matching ReviewHub REVIEWHUB_MIGRATIONS_DIR"
  );
async function database(t) {
  const schema = "collector_test_" + randomUUID().replaceAll("-", ""),
    admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set("options", "-c search_path=" + schema);
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  const stores = [];
  t.after(async () => {
    for (const store of stores) await store.close();
    await client.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await client.query(
    "CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())"
  );
  for (const file of fs
    .readdirSync(process.env.REVIEWHUB_MIGRATIONS_DIR)
    .filter((f) => /^\d+_[a-z_]+\.sql$/.test(f))
    .sort()) {
    const sql = fs.readFileSync(
      path.join(process.env.REVIEWHUB_MIGRATIONS_DIR, file),
      "utf8"
    );
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)",
      [file, createHash("sha256").update(sql).digest("hex")]
    );
  }
  const open = () => {
    const store = new PostgresStore(url.toString(), schema);
    stores.push(store);
    return store;
  };
  return { client, open };
}
test("commits SQLite-derived audit data and cursor atomically, replays after restart, and preserves history", async (t) => {
  const f = fixture(t),
    db = await database(t),
    store = db.open();
  let saved = await store.connect();
  const cycle = async (now = f.now) => {
    const result = await collect({
      ...f,
      now,
      store,
      saved,
      resourcesReader: () => null
    });
    saved = result.saved;
    return result;
  };
  const first = await cycle();
  await cycle();
  assert.equal(
    (await db.client.query("SELECT count(*)::int n FROM audit_runs")).rows[0].n,
    1
  );
  assert.equal(
    (
      await db.client.query(
        "SELECT sum((data->>'totalTokens')::int)::int n FROM audit_usage"
      )
    ).rows[0].n,
    110
  );
  const checkpoint = (
    await db.client.query("SELECT checkpoint FROM audit_sources")
  ).rows[0].checkpoint;
  await db.client.query(
    "CREATE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$"
  );
  await db.client.query(
    "CREATE TRIGGER reject_audit BEFORE UPDATE ON audit_sources FOR EACH ROW EXECUTE FUNCTION reject_audit()"
  );
  f.value.jobs[0].title = "Changed PR title";
  f.database.save(f.value);
  await assert.rejects(cycle(), /injected/);
  assert.deepEqual(
    (await db.client.query("SELECT checkpoint FROM audit_sources")).rows[0]
      .checkpoint,
    checkpoint
  );
  assert.equal(
    (await db.client.query("SELECT data->>'title' title FROM audit_runs"))
      .rows[0].title,
    null
  );
  await db.client.query("DROP TRIGGER reject_audit ON audit_sources");
  await store.close();
  const resumed = db.open(),
    loaded = await resumed.connect();
  assert.deepEqual(loaded.checkpoint, checkpoint);
  const next = await collect({
    ...f,
    store: resumed,
    saved: loaded,
    resourcesReader: () => null
  });
  assert.equal(
    (await db.client.query("SELECT data->>'title' title FROM audit_runs"))
      .rows[0].title,
    "Changed PR title"
  );
  assert.equal(next.batch.runs[0].id, first.batch.runs[0].id);
  f.value.jobs = [];
  f.database.save(f.value);
  fs.rmSync(f.directory, { recursive: true });
  fs.rmSync(f.options.analytics.sessionDirectory, { recursive: true });
  await collect({
    ...f,
    store: resumed,
    saved: next.saved,
    now: f.now + 86400000,
    resourcesReader: () => null
  });
  assert.equal(
    (
      await db.client.query(
        "SELECT (data->>'current')::boolean current FROM audit_runs"
      )
    ).rows[0].current,
    false
  );
  assert.equal(
    (await db.client.query("SELECT count(*)::int n FROM audit_findings"))
      .rows[0].n,
    1
  );
  assert.equal(
    (await db.client.query("SELECT count(*)::int n FROM audit_usage")).rows[0]
      .n,
    1
  );
});
test("one source has one writer; contender cannot mark it failed; rollback rejects duplicate identity", async (t) => {
  const f = fixture(t),
    db = await database(t),
    one = db.open(),
    saved = await one.connect(),
    two = db.open();
  await assert.rejects(two.connect(), /Another collector/);
  await two.failure("COLLECTION_FAILED");
  assert.equal(
    (await db.client.query("SELECT error FROM audit_sources")).rows[0].error,
    null
  );
  const result = await collect({
    ...f,
    store: one,
    saved,
    resourcesReader: () => null
  });
  const invalid = {
    ...result.batch,
    runs: [...result.batch.runs, ...result.batch.runs]
  };
  await assert.rejects(one.publish(invalid, {}, new Map()), /Duplicate/);
  assert.equal(
    (await db.client.query("SELECT count(*)::int n FROM audit_runs")).rows[0].n,
    1
  );
  await one.failure("COLLECTION_FAILED");
  assert.equal(
    (await db.client.query("SELECT error FROM audit_sources")).rows[0].error,
    "COLLECTION_FAILED"
  );
  await one.publish(
    result.batch,
    result.saved.checkpoint,
    result.saved.records
  );
  assert.equal(
    (await db.client.query("SELECT error FROM audit_sources")).rows[0].error,
    null
  );
  const empty = {
    ...result.batch,
    repositories: [],
    runs: [],
    events: [],
    findings: [],
    usage: [],
    resources: []
  };
  await one.publish(empty, result.saved.checkpoint, result.saved.records);
  assert.equal(
    (await db.client.query("SELECT in_scope FROM audit_repositories")).rows[0]
      .in_scope,
    false
  );
  assert.equal(
    (await db.client.query("SELECT count(*)::int n FROM audit_runs")).rows[0].n,
    1
  );
  await one.publish(
    result.batch,
    result.saved.checkpoint,
    result.saved.records
  );
  assert.equal(
    (await db.client.query("SELECT in_scope FROM audit_repositories")).rows[0]
      .in_scope,
    true
  );
});
test("schema incompatibility fails closed, invalid normalized input never commits", async (t) => {
  const f = fixture(t),
    db = await database(t);
  await db.client.query(
    "DELETE FROM schema_migrations WHERE version='004_audit.sql'"
  );
  const missing = db.open();
  await assert.rejects(missing.connect(), /migration/);
  await missing.close();
  await db.client.query(
    "INSERT INTO schema_migrations(version,checksum) VALUES('004_audit.sql','test')"
  );
  const store = db.open(),
    saved = await store.connect();
  const result = await collect({
    ...f,
    store,
    saved,
    resourcesReader: () => null
  });
  await assert.rejects(
    store.publish({ ...result.batch, version: 2 }, {}, new Map()),
    /Invalid normalized/
  );
  assert.equal(
    (await db.client.query("SELECT count(*)::int n FROM audit_runs")).rows[0].n,
    1
  );
});
