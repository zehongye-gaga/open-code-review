// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { AuditSQLite } = require("./audit-sqlite.js");
const { createAuditServer } = require("./audit-sqlite-server.js");
const { emptyUsage, runRows } = require("./analytics-summary.js");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-sqlite-")), file = path.join(root, "session.jsonl");
  fs.writeFileSync(file, "");
  const stat = fs.statSync(file), row = { id: "s", repository: "org/repo", number: 1, jobId: "1", cwd: root,
    identity: `${stat.dev}:${stat.ino}`, offset: 0, scannedSize: 0, days: {}, phaseDays: {}, phases: {},
    usage: emptyUsage(), unreadableRecords: 0, startedAt: "2026-10-30T00:00:00Z", resumed: true };
  const ledger = { version: 2, timeZone: "Asia/Shanghai", collectedAt: "2026-10-30T00:00:00Z", jobs: {
    "1": { id: "1", repository: "org/repo", number: 1, state: "running", attempt: 2, createdAt: "2026-10-30T00:00:00Z" },
    "2": { id: "2", repository: "org/other", number: 1, state: "failed", attempt: 1, createdAt: "2026-10-29T00:00:00Z" },
  }, sessions: { [file]: row } };
  const database = path.join(root, "audit.db"), store = new AuditSQLite(database); store.importLedger(ledger);
  t.after(() => { try { store.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, ledger, database, store };
}
const event = (tokens = 100) => JSON.stringify({ type: "llm_response", timestamp: "2026-10-30T00:01:00Z",
  taskType: "main_task", usage: { prompt_tokens: tokens, completion_tokens: 10 }, duration_ms: 20 });

test("incremental ingestion survives partial lines, repeated reads and restart without double counting", async (t) => {
  const f = fixture(t), text = event(); fs.appendFileSync(f.file, text.slice(0, 40));
  await f.store.ingestSession(f.file); assert.equal(f.store.daily({ start: "2026-10-30", end: "2026-10-30" }).length, 0);
  fs.appendFileSync(f.file, text.slice(40) + "\n"); await f.store.ingestSession(f.file);
  assert.equal(f.store.runs("org/repo", 1)[0].usage.totalTokens, 110);
  assert.deepEqual(await f.store.ingestSession(f.file), { bytes: 0, changed: false });
  f.store.close(); f.store = new AuditSQLite(f.database);
  assert.equal((await f.store.ingestSession(f.file)).bytes, 0);
  fs.appendFileSync(f.file, event(20) + "\n"); await f.store.ingestSession(f.file);
  const run = f.store.runs("org/repo", 1)[0]; assert.equal(run.usage.totalTokens, 140); assert.equal(run.resumed, 1);
  assert.equal(run.partialUsage, true); assert.equal(f.store.daily({ start: "2026-10-30", end: "2026-10-30", repository: "org/other" }).length, 0);
});

test("failed transaction rolls back usage and cursor together", async (t) => {
  const f = fixture(t); fs.appendFileSync(f.file, event() + "\n");
  const put = f.store.putSession.bind(f.store);
  f.store.putSession = (...args) => { put(...args); throw Error("injected write failure"); };
  await assert.rejects(f.store.ingestSession(f.file), /injected/);
  assert.equal(f.store.runs("org/repo", 1)[0].usage.totalTokens, 0);
  f.store.putSession = put; await f.store.ingestSession(f.file);
  assert.equal(f.store.runs("org/repo", 1)[0].usage.totalTokens, 110);
});

test("source rotation and oversized incomplete lines do not reset or duplicate accounting", async (t) => {
  const f = fixture(t); fs.appendFileSync(f.file, event() + "\n"); await f.store.ingestSession(f.file);
  fs.writeFileSync(f.file, ""); await assert.rejects(f.store.ingestSession(f.file), /truncated/);
  assert.equal(f.store.runs("org/repo", 1)[0].usage.totalTokens, 110);
  fs.unlinkSync(f.file); fs.writeFileSync(f.file, event() + "\n"); await assert.rejects(f.store.ingestSession(f.file), /replaced/);
  const g = fixture(t); fs.appendFileSync(g.file, event() + "\n");
  await assert.rejects(g.store.ingestSession(g.file, 16), /batch/);
  assert.equal(g.store.runs("org/repo", 1)[0].usage.totalTokens, 0);
});

test("import is idempotent and SQL run results match existing retry and coverage accounting", (t) => {
  const f = fixture(t), row = f.ledger.sessions[f.file];
  row.endedAt = "2026-10-30T00:02:00Z"; row.nativeSeconds = 120; row.usage.totalTokens = 10; row.usage.errors = 1;
  row.days = { "2026-10-30": row.usage }; row.phaseDays = { "2026-10-30": { main_task: row.usage } };
  f.store.transaction(() => f.store.putSession(f.file, row));
  assert.equal(f.store.transaction(() => f.store.putSession(f.file, row)), 0);
  assert.deepEqual(f.store.runs("org/repo", 1), runRows(f.ledger).filter((r) => r.repository === "org/repo"));
  assert.throws(() => f.store.importLedger(f.ledger), /already imported/);
  assert.throws(() => f.store.runs("org/repo", 1, 100000), /pagination/);
});

test("read-only connection sees atomic commits, and API rejects writes and unbounded queries", async (t) => {
  const f = fixture(t), reader = new AuditSQLite(f.database, { readOnly: true });
  t.after(() => reader.close());
  assert.throws(() => reader.meta("secret", "write"), /readonly/);
  f.store.importAudit({ jobs: Object.values(f.ledger.jobs) });
  const server = createAuditServer(reader); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + "/healthz", { method: "POST" })).status, 405);
  assert.equal((await fetch(base + "/api/audit?limit=9999")).status, 400);
  assert.equal((await fetch(base + "/api/usage/daily?start=2026-02-30&end=2026-03-01")).status, 400);
  const response = await fetch(base + "/api/analytics/pr?repository=org%2Frepo&number=1");
  assert.equal(response.status, 200); assert.equal((await response.json()).runs.length, 1);
  assert.equal((await (await fetch(base + "/api/audit?repository=org%2Fother")).json()).rows.length, 1);
});

test("bounded collector advances its durable scan cursor and reports missing sources", async (t) => {
  const f = fixture(t), { collectRegisteredSessions } = require("./audit-sqlite-collect.js");
  const missing = f.file + ".missing";
  f.store.transaction(() => f.store.putSession(missing, { ...f.ledger.sessions[f.file], id: "missing" }));
  fs.appendFileSync(f.file, event() + "\n");
  const first = await collectRegisteredSessions(f.store, { maxFiles: 1 });
  assert.equal(first.scanned, 1); assert.equal(first.changed, 1); assert.equal(first.remaining, 1);
  const second = await collectRegisteredSessions(f.store, { maxFiles: 1 });
  assert.equal(second.missing, 1); assert.equal(second.remaining, 0);
  assert.equal(f.store.meta("sessionScanCursor"), "");
  const third = await collectRegisteredSessions(f.store, { maxFiles: 1 });
  assert.equal(third.bytes, 0); assert.equal(third.changed, 0);
});

test("the validated descriptor is used and path replacement during reading is rejected", async (t) => {
  const f = fixture(t), { ingest } = require("./analytics.js");
  fs.appendFileSync(f.file, event() + "\n");
  let readTokens;
  f.store.readSession = async (...args) => {
    fs.renameSync(f.file, f.file + ".old"); fs.writeFileSync(f.file, event(1000) + "\n");
    const bytes = await ingest(...args); readTokens = args[1].usage.totalTokens; return bytes;
  };
  await assert.rejects(f.store.ingestSession(f.file), /changed during/);
  assert.equal(readTokens, 110);
  assert.equal(f.store.runs("org/repo", 1)[0].usage.totalTokens, 0);
});

test("an older overlapping collection cannot overwrite a newer committed cursor", async (t) => {
  const f = fixture(t), { ingest } = require("./analytics.js");
  fs.appendFileSync(f.file, event() + "\n");
  f.store.readSession = async (...args) => {
    const bytes = await ingest(...args);
    fs.appendFileSync(f.file, event(20) + "\n");
    const other = new AuditSQLite(f.database);
    try { await other.ingestSession(f.file); } finally { other.close(); }
    return bytes;
  };
  await assert.rejects(f.store.ingestSession(f.file), /Concurrent session update/);
  assert.equal(f.store.runs("org/repo", 1)[0].usage.totalTokens, 140);
  f.store.readSession = ingest;
  assert.equal((await f.store.ingestSession(f.file)).bytes, 0);
});

test("advancing a formerly expired session reactivates only retained-day usage", async (t) => {
  const f = fixture(t), row = f.ledger.sessions[f.file];
  f.store.now = () => Date.parse("2026-10-30T03:00:00Z");
  row.expired = true; row.lastEventAt = "2026-01-01T00:00:00Z";
  row.days["2026-01-01"] = { ...emptyUsage(), totalTokens: 999 };
  row.phaseDays["2026-01-01"] = { main_task: row.days["2026-01-01"] };
  f.store.transaction(() => f.store.putSession(f.file, row));
  fs.appendFileSync(f.file, event() + "\n"); await f.store.ingestSession(f.file);
  const run = f.store.runs("org/repo", 1)[0];
  assert.equal(run.sessions, 1); assert.equal(run.usage.totalTokens, 110);
  assert.equal(f.store.daily({ start: "2026-01-01", end: "2026-01-01" }).length, 0);
});

test("real ingress replaces its synthetic history row without creating duplicates on later snapshots", (t) => {
  const f = fixture(t), jobs = Object.values(f.ledger.jobs);
  f.store.importAudit({ jobs }); assert.equal(f.store.counts().audit, 2);
  const delivery = { id: "delivery-1", jobId: "1", repository: "org/repo", number: 1, createdAt: jobs[0].createdAt };
  f.store.importAudit({ jobs, deliveries: { "delivery-1": delivery } });
  assert.equal(f.store.counts().audit, 2); assert.equal(f.store.audits("org/repo")[0].ingress, "webhook");
  f.store.importAudit({ jobs }); assert.equal(f.store.counts().audit, 2);
});

test("unclaimed initialization never overwrites an empty foreign or future-version database", (t) => {
  const f = fixture(t), { DatabaseSync } = require("node:sqlite");
  for (const setting of ["application_id=123", "user_version=2"]) {
    const file = path.join(f.root, setting + ".db"), db = new DatabaseSync(file);
    db.exec(`PRAGMA ${setting}`); db.close();
    assert.throws(() => new AuditSQLite(file), /Unsupported/);
    const check = new DatabaseSync(file, { readOnly: true });
    assert.equal(Object.values(check.prepare(`PRAGMA ${setting.split("=")[0]}`).get())[0], Number(setting.split("=")[1])); check.close();
  }
});
