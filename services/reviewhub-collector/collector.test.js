// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { readState } = require("./database/state-source.js"),
  { normalize } = require("./normalize.js"),
  { collect, repositoryMetadata } = require("./collector.js");
const { validate } = require("./database/postgres.js"),
  { fixture } = require("./test-support.js");
const checksum = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("reads a consistent SQLite snapshot and increments through all pending revisions and tombstones", (t) => {
  const f = fixture(t),
    file = path.join(f.root, "state.db"),
    before = checksum(file);
  let input = readState(file);
  assert.equal(input.mode, "snapshot");
  assert.equal(input.state.jobs.length, 1);
  assert.equal(checksum(file), before);
  for (let i = 0; i < 25; i++) {
    f.value.sequence++;
    f.database.save(f.value);
  }
  input = readState(file, input.checkpoint, input.rows);
  assert.equal(input.mode, "incremental");
  assert.equal(input.checkpoint.revision, f.database.head.revision);
  f.value.jobs = [];
  f.database.save(f.value);
  input = readState(file, input.checkpoint, input.rows);
  assert.equal(input.state.jobs.length, 0);
  assert.equal(readState(file, input.checkpoint, input.rows).changedRows, 0);
});
test("resnapshots after history loss, epoch change or divergent commit without changing the source", (t) => {
  const f = fixture(t),
    file = path.join(f.root, "state.db"),
    first = readState(file);
  f.value.jobs[0].result.findings = 3;
  f.database.save(f.value);
  f.database.db.exec("DELETE FROM state_changes");
  assert.equal(
    readState(file, first.checkpoint, first.rows).state.jobs[0].result.findings,
    3
  );
  f.database.db.exec("UPDATE state_head SET epoch='replacement'");
  assert.equal(readState(file, first.checkpoint, first.rows).mode, "snapshot");
  const next = readState(file);
  f.database.db.exec(
    "UPDATE state_head SET token='diverged'; UPDATE state_commits SET token='diverged'"
  );
  assert.equal(readState(file, next.checkpoint, next.rows).mode, "snapshot");
  assert.throws(() => readState(file, {}, new Map(), 1), /budget/);
  assert.throws(() => readState(path.join(f.root, "missing.db")));
});
test("PG persistence mode collects real sessions and reports without writing a ledger, cache or audit SQLite", async (t) => {
  const f = fixture(t),
    published = [];
  const store = {
    sourceId: "test",
    publish: async (...args) => {
      published.push(structuredClone(args));
    }
  };
  const saved = { checkpoint: {}, records: new Map() };
  const before = checksum(path.join(f.root, "state.db"));
  const first = await collect({
    ...f,
    store,
    saved,
    resourcesReader: () => null
  });
  assert.equal(validate(first.batch), true, JSON.stringify(validate.errors));
  assert.equal(first.batch.runs[0].verdict, "blocked");
  assert.equal(first.batch.runs[0].publication, "published");
  assert.equal(first.batch.usage[0].totalTokens, 110);
  assert.equal(first.batch.usage[0].cacheReadTokens, 50);
  assert.equal(first.batch.findings[0].description, "Preserve the transaction");
  assert.equal(first.batch.repositories[0].enabled, null);
  assert.equal(first.batch.repositories[0].providerId, null);
  assert.equal(checksum(path.join(f.root, "state.db")), before);
  for (const file of ["ledger.json", "agent-usage.json", "audit.db"])
    assert.equal(fs.existsSync(path.join(f.root, file)), false);
  const again = await collect({
    ...f,
    store,
    saved: first.saved,
    now: f.now + 300000,
    resourcesReader: () => null
  });
  assert.deepEqual(again.batch.usage, first.batch.usage);
  assert.equal(again.saved.checkpoint.changedRows, 0);
  assert.equal(published.length, 2);
});
test("retains archived history and usage after source retention, and bootstraps an existing ledger only once", async (t) => {
  const f = fixture(t),
    store = { sourceId: "test", publish: async () => {} };
  const first = await collect({
    ...f,
    store,
    saved: { checkpoint: {}, records: new Map() },
    resourcesReader: () => null
  });
  const parts = {};
  for (const [key, value] of first.saved.records)
    if (key.startsWith("ledger:")) parts[key] = value;
  const ledger = {
    ...parts["ledger:meta"],
    jobs: {},
    sessions: {},
    artifacts: {}
  };
  for (const [key, value] of Object.entries(parts))
    for (const [prefix, name] of [
      ["ledger:job:", "jobs"],
      ["ledger:session:", "sessions"],
      ["ledger:artifact:", "artifacts"]
    ])
      if (key.startsWith(prefix))
        ledger[name][key.slice(prefix.length)] = value;
  const bootstrap = path.join(f.root, "old-ledger.json");
  fs.writeFileSync(bootstrap, JSON.stringify(ledger));
  f.value.jobs = [];
  f.database.save(f.value);
  fs.rmSync(f.directory, { recursive: true });
  fs.rmSync(f.options.analytics.sessionDirectory, { recursive: true });
  const after = await collect({
    ...f,
    options: { ...f.options, bootstrapLedger: bootstrap },
    store,
    saved: { checkpoint: {}, records: new Map() },
    now: f.now + 86400000,
    resourcesReader: () => null
  });
  assert.equal(after.batch.runs.length, 1);
  assert.equal(after.batch.runs[0].current, false);
  assert.equal(after.batch.usage[0].totalTokens, 110);
  fs.unlinkSync(bootstrap);
  await collect({
    ...f,
    options: { ...f.options, bootstrapLedger: bootstrap },
    store,
    saved: after.saved,
    now: f.now + 86400001,
    resourcesReader: () => null
  });
});
test("deduplicates session identities, keeps unknown usage null, separates cumulative Agent totals and excludes other organizations", () => {
  const now = Date.now(),
    at = new Date(now).toISOString(),
    config = {
      stateDirectory: "/nonexistent",
      organizations: ["company"],
      repositories: [{ name: "company/repo" }, { name: "personal/private" }]
    };
  const job = {
    id: "1",
    repository: "company/repo",
    number: 1,
    createdAt: at,
    updatedAt: at,
    state: "running"
  };
  const session = {
    id: "same",
    repository: job.repository,
    jobId: "1",
    number: 1,
    attribution: "report",
    usage: { totalTokens: 100 },
    days: { "2026-11-12": { totalTokens: 100 } },
    offset: 12
  };
  const batch = normalize({
    config,
    state: { jobs: [job] },
    ledger: {
      jobs: { 1: job },
      sessions: { a: session, b: { ...session } },
      artifacts: {}
    },
    agent: {
      sessions: {
        x: {
          id: "x",
          repository: job.repository,
          number: 1,
          totalTokens: 500,
          observedAt: at
        }
      }
    },
    sourceId: "test",
    intervalSeconds: 300,
    now
  });
  assert.equal(batch.repositories.length, 1);
  assert.equal(batch.usage.length, 2);
  assert.equal(batch.usage[0].totalTokens, 100);
  assert.equal(batch.runs[0].nativeTokens, 100);
  assert.equal(batch.usage[1].runId, null);
  assert.equal(batch.usage[1].timeBasis, "observed_total");
  const empty = normalize({
    config,
    state: { jobs: [job] },
    ledger: { jobs: { 1: job }, sessions: {}, artifacts: {} },
    sourceId: "test",
    intervalSeconds: 300,
    now
  });
  assert.equal(empty.runs[0].nativeTokens, null);
  assert.equal(empty.runs[0].findings, null);
});
test("repository rename retains the local identity and GitHub failure does not report successful access", async () => {
  const config = {
    stateDirectory: "/nonexistent",
    organizations: ["company"],
    repositories: [{ name: "company/old" }]
  };
  const base = {
    config,
    state: { jobs: [] },
    ledger: { jobs: {}, sessions: {}, artifacts: {} },
    sourceId: "test",
    intervalSeconds: 300
  };
  const first = normalize({
    ...base,
    metadata: { "company/old": { providerId: "42", name: "company/old" } }
  });
  const renamed = normalize({
    ...base,
    previousRepositories: first.repositories,
    metadata: { "company/old": { providerId: "42", name: "company/new" } }
  });
  assert.equal(renamed.repositories.length, 1);
  assert.equal(renamed.repositories[0].id, first.repositories[0].id);
  assert.equal(renamed.repositories[0].name, "company/new");
  const failed = await repositoryMetadata(
    config,
    {},
    Date.now(),
    async () => new Response("unavailable", { status: 503 })
  );
  assert.equal(failed.metadata["company/old"].access, "unknown");
  assert.ok(failed.warnings.includes("GITHUB_METADATA_UNAVAILABLE"));
  const cached = await repositoryMetadata(
    config,
    failed.metadata,
    Date.now(),
    async () => {
      throw Error("Must use cached metadata");
    }
  );
  assert.ok(cached.warnings.includes("GITHUB_METADATA_UNVERIFIED"));
});

test("missing native usage never turns into zero tokens", async (t) => {
  const f = fixture(t);
  const lines = fs
    .readFileSync(f.file, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  delete lines.find((row) => row.type === "llm_response").usage;
  fs.writeFileSync(
    f.file,
    lines.map((row) => JSON.stringify(row)).join("\n") + "\n"
  );
  const result = await collect({
    ...f,
    store: { sourceId: "test", publish: async () => {} },
    saved: { checkpoint: {}, records: new Map() },
    resourcesReader: () => null
  });
  assert.equal(result.batch.runs[0].nativeTokens, null);
  assert.equal(result.batch.usage[0].totalTokens, null);
  assert.equal(result.batch.usage[0].cacheReadTokens, null);
  assert.equal(result.batch.usage[0].completeness, "partial");
});

test("imports retained audit SQLite history read-only before continuing direct PG collection", async (t) => {
  const f = fixture(t),
    { AuditSQLite } = require("../github-review/audit-sqlite.js"),
    { Analytics } = require("../github-review/analytics.js");
  const analytics = new Analytics(
    f.config,
    { ...f.options.analytics, directory: f.root },
    { load: () => null, save: () => {} }
  );
  await analytics.collect(f.value.jobs, f.now);
  const file = path.join(f.root, "old-audit.db"),
    old = new AuditSQLite(file);
  old.importLedger(analytics.ledger);
  old.importAudit(f.value);
  old.close();
  const before = checksum(file);
  f.value.jobs = [];
  f.database.save(f.value);
  fs.rmSync(f.directory, { recursive: true });
  fs.rmSync(f.options.analytics.sessionDirectory, { recursive: true });
  const result = await collect({
    ...f,
    options: { ...f.options, bootstrapAuditDatabase: file },
    store: { sourceId: "test", publish: async () => {} },
    saved: { checkpoint: {}, records: new Map() },
    resourcesReader: () => null
  });
  assert.equal(result.batch.runs.length, 1);
  assert.equal(result.batch.usage[0].totalTokens, 110);
  assert.equal(checksum(file), before);
});
