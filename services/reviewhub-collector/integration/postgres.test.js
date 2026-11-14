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
const { collectActions } = require("../actions.js");
if (!process.env.TEST_DATABASE_URL || !process.env.REVIEWHUB_MIGRATIONS_DIR)
  throw Error(
    "Use a dedicated TEST_DATABASE_URL and the matching ReviewHub REVIEWHUB_MIGRATIONS_DIR",
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
    "CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const file of fs
    .readdirSync(process.env.REVIEWHUB_MIGRATIONS_DIR)
    .filter((f) => /^\d+_[a-z_]+\.sql$/.test(f))
    .sort()) {
    const sql = fs.readFileSync(
      path.join(process.env.REVIEWHUB_MIGRATIONS_DIR, file),
      "utf8",
    );
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)",
      [file, createHash("sha256").update(sql).digest("hex")],
    );
  }
  const open = () => {
    const store = new PostgresStore(url.toString(), schema);
    stores.push(store);
    return store;
  };
  return { client, open };
}
test("PG scope includes staged and paused repositories, retains history, survives restart and refuses malformed reads", async t => {
  const f = fixture(t), db = await database(t);
  f.config.repositories = [];
  let configuration = { repository: { id: "42", name: "company/repo", visibility: "private",
    defaultBranch: "main", observedAt: new Date().toISOString() }, revision: 1,
    policy: { enabled: true, baseBranches: ["main"] } };
  await db.client.query("INSERT INTO repository_enrollments(repository_id,organization,revision,configuration,sync_requested) VALUES('42','company',1,$1,false)", [configuration]);
  let store = db.open(), saved = await store.connect();
  const cycle = async () => {
    const result = await collect({ ...f, options: { ...f.options, repositorySource: "reviewhub" }, store, saved, resourcesReader: () => null });
    saved = result.saved; return result;
  };
  const staged = await cycle();
  assert.equal(staged.batch.repositories[0].id, "github:42");
  assert.equal(staged.batch.repositories[0].enabled, null);
  assert.equal(staged.batch.runs.length, 1);
  const id = staged.batch.runs[0].id;
  await db.client.query("UPDATE repository_enrollments SET state='applied',applied_revision=revision WHERE repository_id='42'");
  assert.equal((await cycle()).batch.repositories[0].enabled, true);
  configuration = { ...configuration, revision: 2, policy: { ...configuration.policy, enabled: false } };
  await db.client.query("UPDATE repository_enrollments SET revision=2,configuration=$1,state='pending' WHERE repository_id='42'", [configuration]);
  assert.equal((await cycle()).batch.repositories[0].enabled, null);
  await db.client.query("UPDATE repository_enrollments SET state='applied',applied_revision=revision WHERE repository_id='42'");
  await store.close(); store = db.open(); saved = await store.connect();
  const paused = await cycle();
  assert.equal(paused.batch.repositories[0].enabled, false);
  assert.equal(paused.batch.runs[0].id, id);
  assert.equal((await db.client.query("SELECT in_scope FROM audit_repositories WHERE id='github:42'")).rows[0].in_scope, true);
  const before = (await db.client.query("SELECT checkpoint FROM audit_sources")).rows;
  await db.client.query("UPDATE repository_enrollments SET configuration='{}'");
  await assert.rejects(cycle(), /contract/);
  assert.deepEqual((await db.client.query("SELECT checkpoint FROM audit_sources")).rows, before);
  assert.equal((await db.client.query("SELECT count(*)::int AS n FROM audit_runs")).rows[0].n, 1);
});
test("telemetry start persists excluded attempts across restart without changing review history", async (t) => {
  const f = fixture(t),
    db = await database(t),
    calls = [];
  let store = db.open(),
    saved = await store.connect(),
    first = true;
  const started = new Date(f.now - 120000).toISOString();
  const http = {
    json: async (route) => {
      calls.push(route);
      assert.ok(route.includes("/runs?"));
      return {
        total_count: first ? 1 : 0,
        workflow_runs: first
          ? [
              {
                id: 100,
                run_attempt: 1,
                name: "OCR Dispatch",
                created_at: started,
                updated_at: started,
              },
            ]
          : [],
      };
    },
  };
  const cycle = async (options) => {
    const result = await collect({
      ...f,
      options: { ...f.options, policy: options },
      store,
      saved,
      resourcesReader: () => null,
      actionsReader: (input) => collectActions({ ...input, http }),
    });
    saved = result.saved;
    return result;
  };
  const initial = await cycle({ enabled: true, maxRequestsPerCycle: 4 });
  assert.equal(initial.batch.clientAttempts[0].outcome, "pending");
  const histories = (
    await db.client.query("SELECT id,data FROM audit_runs ORDER BY id")
  ).rows;
  first = false;
  const options = {
    enabled: true,
    telemetrySince: new Date(f.now - 60000).toISOString(),
  };
  const updated = await cycle(options);
  assert.equal(updated.policy.beforeTelemetry, 1);
  assert.equal(updated.policy.pending, 0);
  assert.equal(
    (
      await db.client.query(
        "SELECT data->>'reason' reason FROM audit_client_attempts",
      )
    ).rows[0].reason,
    "before_telemetry_start",
  );
  await store.close();
  store = db.open();
  saved = await store.connect();
  const resumed = await cycle(options);
  assert.equal(resumed.batch.clientAttempts.length, 1);
  assert.equal(
    resumed.batch.clientAttempts[0].id,
    initial.batch.clientAttempts[0].id,
  );
  assert.equal(resumed.policy.pending, 0);
  assert.deepEqual(
    (await db.client.query("SELECT id,data FROM audit_runs ORDER BY id")).rows,
    histories,
  );
  assert.ok(calls.every((route) => route.includes("/runs?")));
});
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
      resourcesReader: () => null,
    });
    saved = result.saved;
    return result;
  };
  const first = await cycle();
  await cycle();
  assert.equal(
    (await db.client.query("SELECT count(*)::int n FROM audit_runs")).rows[0].n,
    1,
  );
  assert.equal(
    (
      await db.client.query(
        "SELECT sum((data->>'totalTokens')::int)::int n FROM audit_usage",
      )
    ).rows[0].n,
    110,
  );
  const checkpoint = (
    await db.client.query("SELECT checkpoint FROM audit_sources")
  ).rows[0].checkpoint;
  await db.client.query(
    "CREATE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$",
  );
  await db.client.query(
    "CREATE TRIGGER reject_audit BEFORE UPDATE ON audit_sources FOR EACH ROW EXECUTE FUNCTION reject_audit()",
  );
  f.value.jobs[0].title = "Changed PR title";
  f.database.save(f.value);
  await assert.rejects(cycle(), /injected/);
  assert.deepEqual(
    (await db.client.query("SELECT checkpoint FROM audit_sources")).rows[0]
      .checkpoint,
    checkpoint,
  );
  assert.equal(
    (await db.client.query("SELECT data->>'title' title FROM audit_runs"))
      .rows[0].title,
    null,
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
    resourcesReader: () => null,
  });
  assert.equal(
    (await db.client.query("SELECT data->>'title' title FROM audit_runs"))
      .rows[0].title,
    "Changed PR title",
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
    resourcesReader: () => null,
  });
  assert.equal(
    (
      await db.client.query(
        "SELECT (data->>'current')::boolean current FROM audit_runs",
      )
    ).rows[0].current,
    false,
  );
  assert.equal(
    (await db.client.query("SELECT count(*)::int n FROM audit_findings"))
      .rows[0].n,
    1,
  );
  assert.equal(
    (await db.client.query("SELECT count(*)::int n FROM audit_usage")).rows[0]
      .n,
    1,
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
    null,
  );
  const result = await collect({
    ...f,
    store: one,
    saved,
    resourcesReader: () => null,
  });
  const invalid = {
    ...result.batch,
    runs: [...result.batch.runs, ...result.batch.runs],
  };
  await assert.rejects(one.publish(invalid, {}, new Map()), /Duplicate/);
  assert.equal(
    (await db.client.query("SELECT count(*)::int n FROM audit_runs")).rows[0].n,
    1,
  );
  await one.failure("COLLECTION_FAILED");
  assert.equal(
    (await db.client.query("SELECT error FROM audit_sources")).rows[0].error,
    "COLLECTION_FAILED",
  );
  await one.publish(
    result.batch,
    result.saved.checkpoint,
    result.saved.records,
  );
  assert.equal(
    (await db.client.query("SELECT error FROM audit_sources")).rows[0].error,
    null,
  );
  const empty = {
    ...result.batch,
    repositories: [],
    runs: [],
    events: [],
    findings: [],
    usage: [],
    resources: [],
  };
  await one.publish(empty, result.saved.checkpoint, result.saved.records);
  assert.equal(
    (await db.client.query("SELECT in_scope FROM audit_repositories")).rows[0]
      .in_scope,
    false,
  );
  assert.equal(
    (await db.client.query("SELECT count(*)::int n FROM audit_runs")).rows[0].n,
    1,
  );
  await one.publish(
    result.batch,
    result.saved.checkpoint,
    result.saved.records,
  );
  assert.equal(
    (await db.client.query("SELECT in_scope FROM audit_repositories")).rows[0]
      .in_scope,
    true,
  );
});
test("schema incompatibility fails closed, invalid normalized input never commits", async (t) => {
  const f = fixture(t),
    db = await database(t);
  await db.client.query(
    "DELETE FROM schema_migrations WHERE version='004_audit.sql'",
  );
  const missing = db.open();
  await assert.rejects(missing.connect(), /migration/);
  await missing.close();
  await db.client.query(
    "INSERT INTO schema_migrations(version,checksum) VALUES('004_audit.sql','test')",
  );
  const store = db.open(),
    saved = await store.connect();
  const result = await collect({
    ...f,
    store,
    saved,
    resourcesReader: () => null,
  });
  await assert.rejects(
    store.publish({ ...result.batch, version: 2 }, {}, new Map()),
    /Invalid normalized/,
  );
  assert.equal(
    (await db.client.query("SELECT count(*)::int n FROM audit_runs")).rows[0].n,
    1,
  );
});

test("explicit allowlist removal hides all audit rows and preserves renamed identity through restart and re-enrollment", async (t) => {
  const f = fixture(t),
    db = await database(t);
  let store = db.open(),
    saved = await store.connect();
  const original = f.config.repositories[0];
  const cycle = async () => {
    const result = await collect({
      ...f,
      store,
      saved,
      resourcesReader: () => null,
    });
    saved = result.saved;
    return result;
  };
  const first = await cycle(),
    repositoryId = first.batch.repositories[0].id;
  const rows = async (table, visible = false) => {
    const where = visible
      ? " WHERE EXISTS (SELECT 1 FROM audit_repositories allowed WHERE allowed.source_id=scoped.source_id AND allowed.id=scoped.repository_id AND allowed.in_scope)"
      : "";
    return (
      await db.client.query(
        `SELECT id,data FROM ${table} scoped${where} ORDER BY id`,
      )
    ).rows;
  };
  const initial = {};
  for (const table of [
    "audit_runs",
    "audit_events",
    "audit_findings",
    "audit_usage",
  ]) {
    initial[table] = await rows(table);
    assert.ok(initial[table].length > 0, table);
  }

  f.config.repositories = [{ ...original, githubName: "company/renamed" }];
  const renamed = await cycle();
  assert.equal(renamed.batch.repositories[0].id, repositoryId);
  assert.equal(renamed.batch.repositories[0].name, "company/renamed");
  assert.ok(renamed.batch.repositories[0].aliases.includes(original.name));
  for (const table of Object.keys(initial)) {
    const current = await rows(table);
    assert.deepEqual(
      current.map((r) => r.id),
      initial[table].map((r) => r.id),
    );
    initial[table] = current;
  }

  f.config.repositories = [{ name: "company/other" }];
  await db.client.query(
    "CREATE FUNCTION reject_scope_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected scope failure'; END $$",
  );
  await db.client.query(
    "CREATE TRIGGER reject_scope_change BEFORE UPDATE ON audit_sources FOR EACH ROW EXECUTE FUNCTION reject_scope_change()",
  );
  const checkpoint = saved.checkpoint;
  await assert.rejects(cycle(), /injected scope failure/);
  assert.equal(
    (
      await db.client.query(
        "SELECT in_scope FROM audit_repositories WHERE id=$1",
        [repositoryId],
      )
    ).rows[0].in_scope,
    true,
  );
  assert.deepEqual(
    (await db.client.query("SELECT checkpoint FROM audit_sources")).rows[0]
      .checkpoint,
    checkpoint,
  );
  await db.client.query("DROP TRIGGER reject_scope_change ON audit_sources");
  await cycle();
  const hidden = await cycle();
  assert.deepEqual(
    hidden.batch.repositories.map((r) => r.name),
    ["company/other"],
  );
  for (const table of Object.keys(initial)) {
    assert.equal((await rows(table)).length, initial[table].length, table);
    assert.deepEqual(await rows(table, true), [], table);
  }
  assert.equal(
    (
      await db.client.query(
        "SELECT in_scope FROM audit_repositories WHERE id=$1",
        [repositoryId],
      )
    ).rows[0].in_scope,
    false,
  );
  assert.ok(saved.records.has("repository:" + repositoryId));

  f.config.repositories = [{ name: "company/renamed" }];
  await store.close();
  store = db.open();
  saved = await store.connect();
  const restored = await cycle();
  assert.equal(restored.batch.repositories[0].id, repositoryId);
  assert.equal(restored.batch.repositories[0].name, "company/renamed");
  for (const table of Object.keys(initial)) {
    assert.deepEqual(await rows(table, true), initial[table], table);
    assert.equal((await rows(table)).length, initial[table].length, table);
  }

  f.config.repositories = [{ name: "company/other" }];
  await cycle();
  f.config.repositories = [{ name: "company/renamed" }];
  await cycle();
  for (const table of Object.keys(initial))
    assert.deepEqual(await rows(table, true), initial[table], table);
  await cycle();
  assert.equal(
    (
      await db.client.query(
        "SELECT count(*)::int n FROM audit_repositories WHERE in_scope",
      )
    ).rows[0].n,
    1,
  );
});

test("operational signals and resource metrics are idempotent, retain identity and remove stale presence", async (t) => {
  const f = fixture(t),
    db = await database(t),
    store = db.open();
  const resourcesReader = () => ({
    cpu: { busy: 75, iowait: 4 },
    memoryTotalBytes: 1000,
    memoryAvailableBytes: 200,
    volumes: [{ label: "data", totalBytes: 1000, availableBytes: 100 }],
  });
  let saved = await store.connect();
  let result = await collect({ ...f, store, saved, resourcesReader });
  saved = result.saved;
  const original = (await db.client.query("SELECT * FROM audit_alert_signals"))
    .rows[0];
  assert.equal(original.data.state, "succeeded");
  assert.equal(original.current, true);
  const metrics = (
    await db.client.query(
      "SELECT data FROM monitor_samples WHERE component='review_host'",
    )
  ).rows.map((r) => r.data);
  assert.equal(
    metrics.find((r) => r.dimension === "host").values.cpu_percent,
    75,
  );
  assert.equal(
    metrics.find((r) => r.dimension === "data").values.disk_percent,
    90,
  );
  f.job.state = "failed";
  f.job.failurePhase = "publication";
  f.job.error = "publication_failed";
  f.job.updatedAt = new Date(f.now + 1000).toISOString();
  f.database.save(f.value);
  result = await collect({
    ...f,
    now: f.now + 1000,
    store,
    saved,
    resourcesReader,
  });
  saved = result.saved;
  const failed = (await db.client.query("SELECT * FROM audit_alert_signals"))
    .rows;
  assert.equal(failed.length, 1);
  assert.equal(failed[0].id, original.id);
  assert.equal(failed[0].data.stage, "publication");
  const firstWrite = await store.publish(
    result.batch,
    result.saved.checkpoint,
    result.saved.records,
  );
  const secondWrite = await store.publish(
    result.batch,
    result.saved.checkpoint,
    result.saved.records,
  );
  assert.ok(secondWrite.rows <= firstWrite.rows);
  assert.ok(secondWrite.ms >= 0);
  f.value.jobs = [];
  f.database.save(f.value);
  await collect({ ...f, now: f.now + 2000, store, saved, resourcesReader });
  assert.equal(
    (await db.client.query("SELECT current FROM audit_alert_signals")).rows[0]
      .current,
    false,
  );
  assert.ok(
    (
      await db.client.query(
        "SELECT count(*)::int n FROM monitor_samples WHERE component='collector'",
      )
    ).rows[0].n > 0,
  );
});

for (const terminal of ["complete", "failed"]) {
  test(`context retry evidence survives ${terminal} collection and writer restart`, async (t) => {
    const f = fixture(t),
      db = await database(t);
    const first = {
      attempt: 1,
      maxAttempts: 3,
      from: 200000,
      to: 400000,
      at: new Date(f.now - 2000).toISOString(),
      directory: f.directory,
      reason: "prompt tokens (162461) exceed 80% of max_tokens(200000)",
      artifacts: [path.join(f.directory, "result.json"), f.file],
    };
    f.job.state = "queued";
    f.job.contextRetries = [first];
    f.database.save(f.value);
    let store = db.open(),
      saved = await store.connect();
    let result = await collect({
      ...f,
      store,
      saved,
      resourcesReader: () => null,
    });
    saved = result.saved;
    const initial = (
      await db.client.query("SELECT data FROM audit_alert_signals")
    ).rows[0].data;
    assert.equal(initial.state, "queued");
    assert.equal(initial.retryEvents.length, 1);
    f.job.contextRetries.push({
      ...first,
      attempt: 2,
      from: 400000,
      to: 800000,
      at: new Date(f.now - 1000).toISOString(),
      reason: "second original\ncontext failure",
    });
    f.job.state = terminal;
    f.job.attempt = 3;
    f.job.updatedAt = new Date(f.now + 1000).toISOString();
    if (terminal === "failed") {
      f.job.error = "Native review incomplete; inspect job artifacts";
      f.job.failureDiagnostics = {
        message: "third original\ncontext failure",
        artifacts: first.artifacts,
      };
    }
    f.database.save(f.value);
    result = await collect({
      ...f,
      now: f.now + 1000,
      store,
      saved,
      resourcesReader: () => null,
    });
    const settled = (
      await db.client.query("SELECT data,collected_at FROM audit_alert_signals")
    ).rows[0];
    assert.equal(settled.data.retryEvents.length, 2);
    assert.equal(settled.data.retryEvents[0].id, initial.retryEvents[0].id);
    assert.notEqual(
      settled.data.retryEvents[0].id,
      settled.data.retryEvents[1].id,
    );
    assert.equal(
      settled.data.state,
      terminal === "complete" ? "succeeded" : "failed",
    );
    assert.equal(
      settled.data.failureDiagnostic?.message,
      terminal === "failed" ? "third original\ncontext failure" : undefined,
    );
    if (terminal === "failed")
      assert.deepEqual(
        settled.data.failureDiagnostic.artifacts,
        first.artifacts,
      );
    await store.close();
    store = db.open();
    saved = await store.connect();
    await collect({
      ...f,
      now: f.now + 2000,
      store,
      saved,
      resourcesReader: () => null,
    });
    const repeated = (
      await db.client.query("SELECT data,collected_at FROM audit_alert_signals")
    ).rows;
    assert.equal(repeated.length, 1);
    assert.deepEqual(repeated[0].data, settled.data);
    assert.equal(
      repeated[0].collected_at.getTime(),
      settled.collected_at.getTime(),
    );
  });
}
