// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { prUsage } = require("./pr-usage.js");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-usage-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "runs"));
  const job = { id: 1, repository: "org/repo", number: 6, head: "b".repeat(40), base: "a".repeat(40),
    state: "complete", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:10Z", progress: { complete: true } };
  const service = { config: { stateDirectory: root, retentionDays: 90 }, state: { data: { jobs: [job] } } };
  function report(name, tokens, extra = {}) {
    const dir = path.join(root, "runs", name); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({ head: job.head, base: job.base, number: job.number, telemetry: { jobId: String(job.id) } }));
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ session_id: "same-session", summary: { input_tokens: tokens, output_tokens: 5, total_tokens: tokens + 5, cache_read_tokens: tokens, cache_write_tokens: 0 }, manifest: { elapsed_ms: 1000 }, ...extra }));
    return dir;
  }
  return { root, job, service, report };
}
test("PR usage adds resume invocations once, discovers historical attempts and paginates without changing totals", async t => {
  const h = fixture(t); const old = h.report("old", 10), latest = h.report("latest", 20, { resume: {} });
  h.job.directory = latest; h.job.progress.directory = latest; h.job.budgetRetries = [{ directory: old }, { directory: latest }];
  const r = (await prUsage(h.service, "org/repo", 6));
  assert.equal(r.native.total_tokens, 40); assert.equal(r.native.execution_ms, 2000); assert.equal(r.native.report_count, 2);
  assert.equal(r.jobs[0].wall_ms, 10000); assert.equal(r.jobs[0].reports.filter(x => x.resumed).length, 1);
  assert.equal(r.agent.tokens, null); assert.equal((await prUsage(h.service, "org/repo", 6, 1)).native.total_tokens, 40);
  assert.deepEqual((await prUsage(h.service, "org/repo", 7)).jobs, []);
});
test("missing and malformed reports remain unknown; running jobs cannot look like final billing", async t => {
  const h = fixture(t); h.job.state = "running"; h.job.directory = h.report("partial", 0, { summary: {} });
  const r = (await prUsage(h.service, "org/repo", 6));
  assert.equal(r.native.total_tokens, null); assert.equal(r.native.missing_token_reports, 1);
  assert.equal(r.jobs[0].usage_pending_or_missing, true);
  fs.writeFileSync(path.join(h.job.directory, "result.json"), "{");
  assert.equal((await prUsage(h.service, "org/repo", 6)).native.report_count, 0);
});
test("report path escapes and wrong snapshots cannot be attributed", async t => {
  const h = fixture(t); const dir = h.report("bad", 999);
  fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({ number: 7, head: h.job.head, base: h.job.base, telemetry: { jobId: 1 } }));
  h.job.directory = dir; assert.equal((await prUsage(h.service, "org/repo", 6)).native.total_tokens, null);
  const outside = path.join(h.root, "outside"); fs.mkdirSync(outside); fs.copyFileSync(path.join(dir, "result.json"), path.join(outside, "result.json"));
  fs.symlinkSync(outside, path.join(h.root, "runs", "escape")); h.job.directory = path.join(h.root, "runs", "escape");
  assert.equal((await prUsage(h.service, "org/repo", 6)).native.total_tokens, null);
});
test("Agent counters are separate and stale cache is explicit", async t => {
  const h = fixture(t); h.service.config.prUsage = { agentUsageFile: path.join(h.root, "agent.json") };
  fs.writeFileSync(h.service.config.prUsage.agentUsageFile, JSON.stringify({ collectedAt: "2020-01-01T00:00:00Z", sessions: {
    one: { repository: "org/repo", number: 6, inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    other: { repository: "other/repo", number: 6, inputTokens: 999, outputTokens: 999, totalTokens: 1998 } } }));
  const r = (await prUsage(h.service, "org/repo", 6)); assert.equal(r.agent.tokens.total_tokens, 120); assert.equal(r.agent.stale, true);
  assert.equal(r.native.total_tokens, null);
});

test("archived documentation fallback reports retain their incurred tokens", async t => {
  const h = fixture(t); const dir = h.report("fallback", 10);
  fs.copyFileSync(path.join(dir, "result.json"), path.join(dir, "documentation-skipped-result.json"));
  const r = (await prUsage(h.service, "org/repo", 6));
  assert.equal(r.native.total_tokens, 30); assert.equal(r.native.report_count, 2);
});

test("conflicting ownership and escaped metadata are excluded", async t => {
  const h = fixture(t), dir = h.report("conflict", 999);
  h.job.directory = dir;
  const meta = { head: h.job.head, base: h.job.base, number: 6, telemetry: { jobId: 2, repository: "org/repo" } };
  fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(meta));
  assert.equal((await prUsage(h.service, "org/repo", 6)).native.total_tokens, null);
  meta.telemetry.jobId = 1; meta.telemetry.repository = "private/other";
  fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(meta));
  assert.equal((await prUsage(h.service, "org/repo", 6)).native.total_tokens, null);
  meta.telemetry.repository = "org/repo";
  fs.writeFileSync(path.join(h.root, "outside.json"), JSON.stringify(meta));
  fs.unlinkSync(path.join(dir, "metadata.json")); fs.symlinkSync(path.join(h.root, "outside.json"), path.join(dir, "metadata.json"));
  assert.equal((await prUsage(h.service, "org/repo", 6)).native.total_tokens, null);
});
