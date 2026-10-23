// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { auditRows, repositoryUsage, cpuSample } = require("./monitor-audit.js");
test("audit preserves both ingress receipts without duplicating a historical job and trusts creator over legacy fallback", () => {
  const rows = auditRows({ jobs: [{ id: 1, repository: "Org/Repo", requestedBy: "insightflow-agent", state: "complete", updatedAt: "2026-10-23T10:00:00Z", settings: { options: { token: "SECRET" } } }],
    deliveries: [{ id: "a", jobId: 1, repository: "Org/Repo", route: "agent", body: "SECRET" }],
    ciReceipts: { b: { request_id: "b", jobId: 1, route: "agent", dispatchMethod: "direct_fallback", fallbackReason: "SECRET", createdAt: 1792751935881 } } });
  assert.equal(rows.length, 2); assert.ok(rows.every((r) => r.actualRoute === "agent"));
  assert.ok(rows[1].stages.some((s) => s.stage === "accepted")); assert.ok(!JSON.stringify(rows).includes("SECRET"));
});
test("audit retains failed dispatch without job and unknown reused creators", () => {
  const rows = auditRows({ jobs: [{ id: 1, requestedBy: "other" }], deliveries: [{ id: "a", state: "failed", repository: "Org/Repo" }], ciReceipts: [{ jobId: 1, dispatchMethod: "reused_existing" }] });
  assert.equal(rows.length, 2); assert.equal(rows.find((r) => r.id === "a").state, "failed");
  assert.equal(rows.find((r) => r.jobId).actualRoute, "unknown");
});
test("repository rollup sums unique analytics PR rows, including failed session consumption", () => {
  const rows = repositoryUsage([{ repository: "Org/A", reviews: 2, sessions: 2, failed: 1, usage: { totalTokens: 120, inputTokens: 100, outputTokens: 20, cacheReadTokens: 70 } }, { repository: "org/a", reviews: 1, sessions: 1, usage: { totalTokens: 30 } }, { repository: "org/b" }]);
  assert.equal(rows[0].totalTokens, 150); assert.equal(rows[0].reviews, 3); assert.equal(rows[0].cacheReadTokens, 70); assert.equal(rows[1].sessions, 0);
});
test("CPU samples exclude guest double counting and handle warmup", () => {
  const first = cpuSample("cpu 100 0 50 800 30 10 10 0 100 0"); assert.equal(first.usage, null);
  const second = cpuSample("cpu 120 0 60 860 35 12 13 0 120 0", first.counter);
  assert.equal(second.usage.busy, 35); assert.equal(second.usage.system, 15); assert.equal(second.usage.iowait, 5);
  assert.equal(cpuSample(null).usage, null);
});
