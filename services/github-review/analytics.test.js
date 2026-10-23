// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Analytics, encoded } = require("./analytics.js");
const { dayKey, weekKey, runRows } = require("./analytics-summary.js");
const { Monitor } = require("./monitor-data.js");

const now = Date.parse("2026-10-12T03:00:00Z");
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const coverage = { selected: [{ item_id: "file1" }, { item_id: "file2" }], completed: [{ item_id: "file1" }], reused: [{ item_id: "file2" }], failed: [], waived: [] };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-analytics-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { stateDirectory: root, repositories: [{ name: "org/repo" }] };
  const options = { directory: path.join(root, "ledger"), sessionDirectory: path.join(root, "sessions"), retentionDays: 90, timeZone: "Asia/Shanghai" };
  return { root, config, options, collector: new Analytics(config, options), jobs: [] };
}

function invocation(f, { id, jobId = "1", number = 10, head = `${number}-head`, slot = 0, start = "2026-10-12T01:00:00Z",
  end = "2026-10-12T01:01:00Z", tokens = 100, resumed = false, outcome = "complete", findings = 2, attempt = 1 }) {
  const workspace = path.join(f.root, slot ? `worker-repositories/${slot}` : "repositories", "org/repo");
  fs.mkdirSync(workspace, { recursive: true });
  const directory = path.join(f.root, "runs", `ocr-pr-${id}`), base = "base";
  const job = { id: jobId, repository: "org/repo", number, head, base, state: end ? outcome === "complete" ? "complete" : "failed" : "running",
    directory, workspace, createdAt: "2026-10-11T14:00:00Z", startedAt: start, updatedAt: end || start, attempt,
    progress: { sessionId: id } };
  const existing = f.jobs.findIndex((j) => j.id === jobId);
  if (existing >= 0) f.jobs[existing] = job; else f.jobs.push(job);
  write(path.join(directory, "metadata.json"), { number, head, base, merge_base: base,
    background: "private source and credentials", telemetry: { repository: "org/repo", jobId, workspace, preparedAt: start, attempt } });
  if (end) write(path.join(directory, "result.json"), { status: outcome, session_id: id,
    summary: { total_tokens: 999999 }, comments: Array.from({ length: findings }, () => ({ severity: "high", content: "private finding" })),
    manifest: { run_id: id, input: { resolved_head: head, resolved_base: base }, terminal_state: outcome, coverage } });
  const events = [
    { type: "session_start", cwd: workspace, sessionId: id, timestamp: start, diffTo: head, diffFrom: base, ...(resumed ? { resumedFrom: "previous-private-session" } : {}) },
    { type: "llm_request", timestamp: start, taskType: "main_task", messages: ["private source"] },
    { type: "llm_response", timestamp: end || start, taskType: "main_task", usage: { prompt_tokens: tokens, completion_tokens: 10, cache_read_tokens: tokens / 2, cache_write_tokens: 5 }, duration_ms: 1000, content: "private output" },
    { type: "tool_call", timestamp: end || start, taskType: "main_task", ok: false, arguments: "private arguments" },
  ];
  if (outcome === "failed") events.push({ type: "llm_error", timestamp: end, taskType: "main_task", error: "private error" });
  if (end) events.push({ type: "session_end", timestamp: end, duration_seconds: 60, run_manifest: { terminal_state: outcome, coverage } });
  const file = path.join(f.options.sessionDirectory, encoded(workspace), `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { file, events, job, directory };
}

test("calendar days use the configured zone and weeks start on Monday across year boundaries", () => {
  assert.equal(dayKey("2026-10-11T15:59:59Z", "Asia/Shanghai"), "2026-10-11");
  assert.equal(dayKey("2026-10-11T16:00:00Z", "Asia/Shanghai"), "2026-10-12");
  assert.equal(weekKey("2027-01-01"), "2026-12-28");
  assert.equal(weekKey("2026-10-12"), "2026-10-12");
});

test("counts failed attempts and resumed usage once, even after restart and publication retry", async (t) => {
  const f = fixture(t);
  invocation(f, { id: "first", outcome: "failed", start: "2026-10-11T15:58:00Z", end: "2026-10-11T15:59:00Z", tokens: 100 });
  const resumed = invocation(f, { id: "second", resumed: true, tokens: 200, attempt: 3 });
  let result = await f.collector.collect(f.jobs, now);
  assert.equal(result.periods.retained.usage.totalTokens, 320);
  assert.equal(result.periods.today.usage.totalTokens, 210);
  assert.equal(result.periods.week.usage.totalTokens, 210);
  assert.equal(result.periods.retained.findings, 2);
  assert.equal(result.periods.retained.severities.high, 2);
  assert.equal(result.periods.retained.completed, 1);
  assert.equal(result.periods.retained.usage.errors, 1);
  assert.equal(result.periods.retained.usage.cacheWriteTokens, 10);
  assert.equal(result.periods.retained.resumed, 1);
  assert.equal(result.pulls[0].retries, 2);
  assert.equal(result.pulls[0].usage.totalTokens, 320);
  assert.equal(result.pulls[0].nativeSeconds, 120);
  assert.equal(result.pulls[0].latest.findings, 2);
  assert.equal(result.periods.retained.coverage.reused, 1);
  const duplicate = path.join(f.root, "runs", "ocr-pr-publication");
  fs.cpSync(resumed.directory, duplicate, { recursive: true });
  f.jobs[0].directory = duplicate;
  f.collector = new Analytics(f.config, f.options);
  result = await f.collector.collect(f.jobs, now);
  assert.equal(result.periods.retained.usage.totalTokens, 320);
  assert.equal(result.periods.retained.findings, 2);
  const output = JSON.stringify(result) + fs.readFileSync(f.collector.file, "utf8");
  for (const secret of ["private source", "private finding", "private output", "private error", "private arguments", "previous-private-session"]) {
    assert.equal(output.includes(secret), false, secret);
  }
});

test("keeps history after service retention deletes artifacts, sessions and completed jobs", async (t) => {
  const f = fixture(t); invocation(f, { id: "retained" });
  const first = await f.collector.collect(f.jobs, now);
  fs.rmSync(path.join(f.root, "runs"), { recursive: true }); fs.rmSync(f.options.sessionDirectory, { recursive: true });
  const fresh = new Analytics(f.config, f.options);
  const later = await fresh.collect([], now + 8 * 86400000);
  assert.equal(later.periods.retained.findings, first.periods.retained.findings);
  assert.equal(later.periods.retained.usage.totalTokens, 110);
  assert.equal(later.pulls.length, 1);
  const expired = await fresh.collect([], now + 100 * 86400000);
  assert.equal(expired.pulls.length, 0);
  assert.equal(expired.periods.retained.usage.totalTokens, 0);
});

test("reads appends without double counting partial lines and recovers truncated files", async (t) => {
  const f = fixture(t), { file, events } = invocation(f, { id: "partial", end: null });
  const content = events.map((e) => JSON.stringify(e));
  fs.writeFileSync(file, content.slice(0, 2).join("\n") + "\n" + content[2].slice(0, 80));
  let result = await f.collector.collect(f.jobs, now);
  assert.equal(result.periods.today.usage.totalTokens, 0);
  fs.appendFileSync(file, content[2].slice(80) + "\n" + content[3] + "\n");
  result = await f.collector.collect(f.jobs, now);
  assert.equal(result.periods.today.usage.totalTokens, 110);
  assert.equal(result.incompleteSessions, 1);
  assert.equal(result.pulls[0].latest.findings, null);
  result = await new Analytics(f.config, f.options).collect(f.jobs, now);
  assert.equal(result.periods.today.usage.totalTokens, 110);
  fs.writeFileSync(file, content[0] + "\n");
  result = await f.collector.collect(f.jobs, now);
  assert.equal(result.periods.today.usage.totalTokens, 0);
});

test("attributes all worker slots to their own jobs", async (t) => {
  const f = fixture(t);
  for (let slot = 0; slot < 4; slot++) invocation(f, { id: `slot-${slot}`, jobId: String(slot), number: slot + 1, slot, tokens: (slot + 1) * 100 });
  const result = await f.collector.collect(f.jobs, now);
  assert.equal(result.periods.today.completed, 4);
  assert.equal(result.periods.today.usage.totalTokens, 1040);
  assert.deepEqual(result.pulls.map((p) => p.usage.totalTokens).sort((a, b) => a - b), [110, 210, 310, 410]);
  assert.equal(result.unattributedSessions, 0);
  assert.equal(runRows(f.collector.ledger).every((r) => r.sessions === 1), true);
});

test("retains final findings and marks missing usage when session logs are absent", async (t) => {
  const f = fixture(t); const { file } = invocation(f, { id: "missing-session" });
  fs.rmSync(file);
  const result = await f.collector.collect(f.jobs, now);
  assert.equal(result.periods.today.findings, 2);
  assert.equal(result.periods.today.severities.high, 2);
  assert.equal(result.unmatchedJobs, 1);
  assert.equal(result.pulls[0].latest.findings, 2);
  assert.equal(runRows(f.collector.ledger)[0].partialUsage, true);
});

test("simultaneous PRs with identical commit ranges are disambiguated by workspace", async (t) => {
  const f = fixture(t);
  invocation(f, { id: "same-1", jobId: "1", number: 1, head: "same", slot: 0, tokens: 100, end: null });
  invocation(f, { id: "same-2", jobId: "2", number: 2, head: "same", slot: 1, tokens: 200, end: null });
  await f.collector.collect(f.jobs, now);
  const rows = runRows(f.collector.ledger);
  assert.equal(rows.find((r) => r.number === 1).usage.totalTokens, 110);
  assert.equal(rows.find((r) => r.number === 2).usage.totalTokens, 210);
});

test("backfills legacy artifact metadata without misattributing a newer rerun", async (t) => {
  const f = fixture(t), { directory } = invocation(f, { id: "legacy" });
  const file = path.join(directory, "metadata.json"), meta = JSON.parse(fs.readFileSync(file)); delete meta.telemetry;
  write(file, meta); fs.utimesSync(file, new Date("2026-10-12T01:00:00Z"), new Date("2026-10-12T01:00:00Z"));
  f.jobs.push({ ...f.jobs[0], id: "2", state: "queued", directory: null, createdAt: "2026-10-12T02:00:00Z", progress: null });
  const result = await f.collector.collect(f.jobs, now);
  assert.equal(result.pulls[0].reviews, 2);
  assert.equal(runRows(f.collector.ledger).find((r) => r.id === "1").usage.totalTokens, 110);
  assert.equal(runRows(f.collector.ledger).find((r) => r.id === "2").usage.totalTokens, 0);
});

test("repairs attribution when the artifact is observed before its job snapshot", async (t) => {
  const f = fixture(t); invocation(f, { id: "late-job" });
  const first = await f.collector.collect([], now);
  assert.equal(first.pulls[0].reviews, 0);
  await f.collector.collect(f.jobs, now);
  const row = runRows(f.collector.ledger)[0];
  assert.equal(row.usage.totalTokens, 110);
  assert.equal(row.coverage.reused, 1);
});

test("calendar retention trims PR and phase usage even when an expired log is touched", async (t) => {
  const f = fixture(t); f.options.retentionDays = 7; f.collector = new Analytics(f.config, f.options);
  const { file, events } = invocation(f, { id: "boundary", start: "2026-10-05T15:59:00Z", end: "2026-10-05T16:01:00Z" });
  const earlier = { ...events[2], timestamp: "2026-10-05T15:59:00Z" };
  fs.writeFileSync(file, [events[0], earlier, ...events.slice(1)].map((e) => JSON.stringify(e)).join("\n") + "\n");
  let result = await f.collector.collect(f.jobs, now);
  assert.equal(result.periods.retained.usage.totalTokens, 110);
  assert.equal(result.pulls[0].usage.totalTokens, 110);
  assert.equal(result.phases.main_task.totalTokens, 110);
  const future = now + 10 * 86400000; fs.utimesSync(file, new Date(future), new Date(future));
  result = await f.collector.collect([], future);
  assert.equal(result.pulls.length, 0);
  assert.deepEqual(result.phases, {});
  assert.equal(result.periods.retained.usage.totalTokens, 0);
});

test("findings-only history remains visible before the earliest token record", async (t) => {
  const f = fixture(t), old = invocation(f, { id: "old", jobId: "old", start: "2026-10-10T01:00:00Z", end: "2026-10-10T01:01:00Z" });
  fs.rmSync(old.file); invocation(f, { id: "new", jobId: "new" });
  const result = await f.collector.collect(f.jobs, now);
  assert.equal(result.observedSince, "2026-10-10");
  assert.equal(result.daily.find((d) => d.key === "2026-10-10").findings, 2);
});

test("reloads a durable ledger larger than the untrusted artifact size limit", (t) => {
  const f = fixture(t);
  // Whitespace keeps this a valid JSON ledger without inventing unsupported fields.
  fs.writeFileSync(f.collector.file, JSON.stringify(f.collector.ledger) + " ".repeat(33 * 1024 * 1024));
  const restarted = new Analytics(f.config, f.options);
  assert.equal(restarted.ledger.version, 2);
});

test("monitor retains analytics and flags failure when the durable ledger cannot be written", async (t) => {
  const f = fixture(t); invocation(f, { id: "monitor" });
  const configFile = path.join(f.root, "config.json"); write(configFile, f.config);
  write(path.join(f.root, "state.json"), { version: 1, jobs: f.jobs });
  const monitor = new Monitor({ ocrConfig: configFile, analytics: f.options }, {
    now: () => now, unit: async () => ({ state: "active" }), health: async () => ({ ok: true }), resources: () => ({}),
  });
  await monitor.collect(); assert.equal(monitor.snapshot().analytics.error, false);
  assert.equal(monitor.analyticsPull("org/repo", 10).runs[0].usage.totalTokens, 110);
  const output = JSON.stringify(monitor.snapshot()); assert.equal(output.includes(f.root), false);
  fs.mkdirSync(monitor.analytics.file + ".tmp");
  await monitor.collect(); assert.equal(monitor.snapshot().analytics.error, true);
  assert.equal(monitor.snapshot().analytics.periods.today.usage.totalTokens, 110);
});

test("rejects corrupt ledgers and time zone changes instead of resetting accumulated counters", (t) => {
  const f = fixture(t);
  assert.throws(() => new Analytics(f.config, { ...f.options, timeZone: "invalid" }), /Invalid time zone/);
  write(f.collector.file, { version: 1, timeZone: "UTC", sessions: {}, jobs: {}, artifacts: {} });
  assert.throws(() => new Analytics(f.config, f.options), /Invalid analytics ledger/);
});
