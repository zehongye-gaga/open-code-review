// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { Monitor } = require("./monitor-data.js");
const { MonitorSQLite } = require("./monitor-sqlite.js");
const { createMonitorServer } = require("./monitor.js");
const { encoded } = require("./analytics.js");
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-sqlite-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = Date.now(); const at = new Date(now).toISOString();
  const options = { ocrConfig: path.join(root, "config.json"), sqlite: { database: path.join(root, "audit.db") },
    analytics: { directory: path.join(root, "analytics"), sessionDirectory: path.join(root, "sessions"), timeZone: "UTC", retentionDays: 90 } };
  write(options.ocrConfig, { stateDirectory: root, repositories: [{ name: "org/repo" }] });
  write(path.join(root, "state.json"), { version: 1, jobs: [] });
  const monitor = new Monitor(options, { now: () => now, unit: async () => ({ state: "active" }),
    health: async () => ({ ok: true, reachable: true, lastPoll: at }), resources: () => ({ volumes: [] }),
    github: async () => ({ pulls: [], remaining: 50 }) });
  await monitor.refreshGitHub(); await monitor.collect();
  const writer = new MonitorSQLite(options, { readOnly: false, now: () => now });
  writer.publish(monitor, { 24: { latest: now, stale: false, points: [] } });
  const reader = new MonitorSQLite(options, { now: () => now });
  t.after(() => { reader.close(); writer.close(); });
  return { root, options, at, monitor, writer, reader, advance: (ms) => { now += ms; } };
}

test("SQLite dashboard discovers new jobs and sessions through the existing collector and survives restart", async (t) => {
  const f = await fixture(t), workspace = path.join(f.root, "repositories/org/repo");
  const directory = path.join(f.root, "runs/ocr-pr-test"), file = path.join(f.options.analytics.sessionDirectory, encoded(workspace), "session.jsonl");
  write(path.join(directory, "metadata.json"), { number: 7, head: "head", base: "base", merge_base: "base",
    telemetry: { repository: "org/repo", jobId: "1", workspace, preparedAt: f.at } });
  write(path.join(f.root, "state.json"), { version: 1, jobs: [{ id: "1", repository: "org/repo", number: 7, head: "head", base: "base", directory, workspace,
    state: "running", attempt: 1, createdAt: f.at, startedAt: f.at, updatedAt: f.at }] });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [{ type: "session_start", cwd: workspace, sessionId: "session", timestamp: f.at, diffTo: "head", diffFrom: "base" },
    { type: "llm_response", timestamp: f.at, usage: { prompt_tokens: 100, completion_tokens: 10 } }].map(JSON.stringify).join("\n") + "\n");
  await f.monitor.collect(); f.writer.publish(f.monitor);
  assert.equal(f.reader.analyticsPull("org/repo", 7).runs[0].usage.totalTokens, 110);
  for (const repository of ["", "org/repo"]) {
    const { storage, ...actual } = f.reader.snapshot(repository);
    assert.deepEqual(actual, JSON.parse(JSON.stringify(f.monitor.snapshot(repository)))); assert.equal(storage.engine, "sqlite");
  }
  await f.monitor.collect(); f.writer.publish(f.monitor);
  assert.equal(f.reader.analyticsPull("org/repo", 7).runs[0].usage.totalTokens, 110);
  const reopened = new MonitorSQLite(f.options); t.after(() => reopened.close());
  assert.equal(reopened.analyticsPull("org/repo", 7).runs[0].usage.totalTokens, 110);
  delete f.monitor.analytics.ledger.jobs["1"]; f.monitor.analytics.ledger.sessions = {};
  f.writer.publish(f.monitor);
  assert.equal(f.reader.analyticsPull("org/repo", 7).runs.length, 0);
  assert.equal(f.writer.store.counts().usage_days, 0);
});

test("failed publication keeps the entire previous generation and collectors can resume", async (t) => {
  const f = await fixture(t), before = f.reader.snapshot();
  f.monitor.local.collectedAt = "2099-01-01T00:00:00Z";
  f.monitor.analytics.ledger.jobs.bad = { id: "bad", repository: "invalid", number: 1 };
  assert.throws(() => f.writer.publish(f.monitor), /identity/);
  assert.deepEqual(f.reader.snapshot(), before);
  delete f.monitor.analytics.ledger.jobs.bad;
  f.writer.publish(f.monitor); assert.equal(f.reader.snapshot().collectedAt, "2099-01-01T00:00:00Z");
});

test("stopped collector expires health, GitHub, Agent and resource freshness without losing data", async (t) => {
  const f = await fixture(t);
  f.monitor.agentUsage.value = { sessions: {}, collectedAt: f.at }; f.writer.publish(f.monitor);
  f.advance(181000);
  const snapshot = f.reader.snapshot();
  assert.equal(snapshot.stale, true); assert.equal(snapshot.github.stale, true);
  assert.equal(snapshot.services.ocr.healthy, false); assert.equal(snapshot.agentUsage.stale, true);
  assert.equal(f.reader.resourceSnapshot(24).stale, true);
  assert.throws(() => f.reader.resourceSnapshot(3), (e) => e.status === 400);
});

test("HTTP status, PR, resources and health work without access to source configuration or files", async (t) => {
  const f = await fixture(t); fs.unlinkSync(f.options.ocrConfig);
  const server = createMonitorServer(f.reader);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const route of ["/", "/healthz", "/api/status", "/api/status?repository=org/repo", "/api/analytics/pr?repository=org/repo&number=7", "/api/resources?hours=24"]) {
    assert.equal((await fetch(url + route)).status, 200, route);
  }
  assert.equal((await fetch(url + "/api/status?repository=missing/repo")).status, 404);
  f.advance(46000); assert.equal((await fetch(url + "/healthz")).status, 503);
  f.writer.store.db.exec("DROP TABLE dashboard_snapshots");
  for (const route of ["/healthz", "/api/status", "/api/analytics/pr?repository=org/repo&number=7"]) assert.equal((await fetch(url + route)).status, 503);
});

test("consistent online backup opens as a standalone dashboard database", async (t) => {
  const f = await fixture(t);
  const file = await require("./monitor-sqlite-backup.js").backupMonitor(f.options.sqlite.database, path.join(f.root, "backups"));
  const restored = new MonitorSQLite({ ...f.options, sqlite: { database: file } });
  try { assert.deepEqual(restored.snapshot().analytics, f.reader.snapshot().analytics); }
  finally { restored.close(); }
});

test("failed analytics collection cannot publish its partially mutated ledger", async (t) => {
  const f = await fixture(t), previous = f.reader.snapshot().analytics;
  f.monitor.analytics.ledger.jobs["10"] = { id: "10", repository: "org/repo", number: 10, state: "running", createdAt: f.at };
  f.monitor.local.analytics.error = true;
  f.writer.publish(f.monitor);
  assert.deepEqual(f.reader.snapshot().analytics, { ...previous, error: true });
  assert.equal(f.reader.analyticsPull("org/repo", 10).runs.length, 0);
  f.monitor.local.analytics.error = false; f.writer.publish(f.monitor);
  assert.equal(f.reader.analyticsPull("org/repo", 10).runs.length, 1);
});

test("corrupt daily backup is repaired and overlapping backups use private independent files", async (t) => {
  const f = await fixture(t), directory = path.join(f.root, "backups"), { backupMonitor } = require("./monitor-sqlite-backup.js");
  fs.mkdirSync(directory, { mode: 0o755 });
  const target = path.join(directory, `audit-${new Date().toISOString().slice(0, 10)}.db`);
  fs.writeFileSync(target, "corrupt");
  await Promise.all([backupMonitor(f.options.sqlite.database, directory), backupMonitor(f.options.sqlite.database, directory)]);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(directory), [path.basename(target)]);
  const restored = new MonitorSQLite({ ...f.options, sqlite: { database: target } });
  try { assert.equal(restored.snapshot().ready, true); } finally { restored.close(); }
});

test("ledger write failure retains coherent last successful summaries and SQL detail", async (t) => {
  const f = await fixture(t), before = f.reader.snapshot().analytics;
  write(path.join(f.root, "state.json"), { version: 1, jobs: [{ id: "11", repository: "org/repo", number: 11, state: "running", createdAt: f.at }] });
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === f.monitor.analytics.file) throw Object.assign(Error("disk full"), { code: "ENOSPC" }); return rename(from, to); };
  try { await f.monitor.collect(); } finally { fs.renameSync = rename; }
  assert.equal(f.monitor.local.analytics.error, true);
  assert.ok(f.monitor.analytics.ledger.jobs["11"]);
  f.writer.publish(f.monitor);
  assert.deepEqual(f.reader.snapshot().analytics, { ...before, error: true });
  assert.equal(f.reader.analyticsPull("org/repo", 11).runs.length, 0);
});

test("restart restores raw GitHub data and rejoins current local job state", async (t) => {
  const f = await fixture(t);
  f.monitor.remote.pulls = [{ repository: "org/repo", number: 7, headRefOid: "head", baseRefName: "main", isDraft: false,
    title: "PR", url: "https://github.com/org/repo/pull/7", updatedAt: f.at }];
  f.writer.publish(f.monitor);
  assert.equal(f.reader.snapshot().pulls[0].ocr.jobState, null);
  f.monitor.remote = { pulls: [], updatedAt: null, error: false };
  f.writer.restoreGitHub(f.monitor);
  f.monitor.remote.error = true;
  f.monitor.local.ocrJobs = [{ repository: "org/repo", number: 7, head: "head", state: "complete", attempt: 2, findings: 3, updatedAt: f.at }];
  f.writer.publish(f.monitor);
  const actual = f.reader.snapshot();
  assert.equal(actual.github.updatedAt, f.at); assert.equal(actual.github.error, true);
  assert.equal(actual.pulls[0].ocr.jobState, "complete"); assert.equal(actual.pulls[0].ocr.attempt, 2);
  assert.equal(actual.pulls[0].ocr.findings, 3);
});
