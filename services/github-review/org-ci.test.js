// SPDX-License-Identifier: Apache-2.0
"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { OrgCI, identity } = require("./org-ci.js");
const { State } = require("./state.js");
function input(extra = {}) {
  const p = { base_ref: "release/company", base_sha: "b".repeat(40), head_sha: "a".repeat(40), pull_number: 12, repository: "lexmount/example", ...extra };
  const str = JSON.stringify(p).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  return { schema: "ocr-ci/v1", ...p, request_id: "ocr-ci-" + crypto.createHash("sha256").update(str).digest("hex") };
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "org-ci-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statuses = [], p = input();
  const pr = { number: 12, state: "open", draft: true, head: { sha: p.head_sha }, base: { sha: p.base_sha, ref: p.base_ref, repo: { full_name: p.repository } } };
  const s = { state: new State(dir), workers: new Map(), log() {},
    config: { binary: __filename, provider: "test", model: "test", timeoutSeconds: 30, fetchTimeoutSeconds: 30, blockSeverity: "high", statusContext: "ocr-review",
      infrastructure: { orgCI: { enabled: true, totalSeconds: 7200, heartbeatSeconds: 300 }, agentDispatch: { clientId: "agent" } } },
    coordinates: () => ({ owner: "lexmount", repo: "example" }), repo: () => ({ name: p.repository, defaultProfile: "standard" }),
    eligible: (_repo, pull, job) => job.ciRequestId && pull.state === "open",
    github: { rest: { pulls: { get: async () => ({ data: pr }) }, repos: { createCommitStatus: async (args) => { statuses.push(args); } } } },
    accept: (repo, pull, options) => s.state.enqueue(repo, pull, options) };
  const ci = new OrgCI(s); s.orgCI = ci;
  return { s, ci, statuses, p, pr };
}
test("canonical identity includes Unicode base ref and rejects mismatches", () => {
  assert.equal(identity(input({ base_ref: "release/\u4e2d\ud83d\ude00" })).base_ref, "release/\u4e2d\ud83d\ude00");
  assert.throws(() => identity({ ...input(), head_sha: "c".repeat(40) }), /snapshot/);
});
test("receipt persists before pending publication; duplicates retain route", async (t) => {
  const { ci, s, p, statuses } = fixture(t);
  const original = s.github.rest.repos.createCommitStatus;
  s.github.rest.repos.createCommitStatus = async (args) => { assert.ok(JSON.parse(fs.readFileSync(s.state.file)).ciReceipts[p.request_id]); await original(args); };
  const r = await ci.submit(p, "direct"); assert.equal(r.durable, true); assert.equal(r.commit_status, "pending");
  await ci.submit(p, "agent"); assert.equal(ci.receipts[p.request_id].route, "direct"); assert.equal(statuses.length, 1);
});
test("pending status failure is retried without creating another receipt", async (t) => {
  const { ci, s, p } = fixture(t); const original = s.github.rest.repos.createCommitStatus;
  s.github.rest.repos.createCommitStatus = async () => { throw new Error("offline"); };
  await assert.rejects(ci.submit(p, "direct")); assert.equal(ci.view(ci.receipts[p.request_id]).status_published, false);
  s.github.rest.repos.createCommitStatus = original;
  assert.equal((await ci.submit(p, "direct")).status_published, true); assert.equal(Object.keys(ci.receipts).length, 1);
});
test("concurrent dispatch and retries create one job with medium floor", async (t) => {
  const { ci, s, p } = fixture(t); await ci.submit(p, "direct");
  await Promise.all([ci.dispatch(ci.receipts[p.request_id]), ci.dispatch(ci.receipts[p.request_id])]);
  assert.equal(s.state.data.jobs.length, 1); assert.equal(s.state.data.jobs[0].settings.options.blockSeverity, "medium");
  assert.equal(s.state.data.jobs[0].ciRequestId, p.request_id);
});
test("restart retains receipt and queued job identity", async (t) => {
  const { ci, s, p } = fixture(t); await ci.submit(p, "direct"); await ci.dispatch(ci.receipts[p.request_id]);
  s.state = new State(path.dirname(s.state.file)); const next = new OrgCI(s);
  await next.submit(p, "direct"); await next.dispatch(next.receipts[p.request_id]); assert.equal(s.state.data.jobs.length, 1);
});
test("n8n loss is failed by independent watchdog", async (t) => {
  const { ci, p, statuses } = fixture(t); await ci.submit(p, "direct");
  ci.receipts[p.request_id].heartbeatAt -= 301000; await ci.watchdog();
  assert.equal(statuses.at(-1).state, "failure"); assert.equal(ci.receipts[p.request_id].reason, "n8n_tracking_stalled");
});
test("deadline failure survives GitHub outage and status retries", async (t) => {
  const { ci, s, p, statuses } = fixture(t); await ci.submit(p, "direct");
  ci.receipts[p.request_id].createdAt -= 7201000;
  const original = s.github.rest.repos.createCommitStatus;
  s.github.rest.repos.createCommitStatus = async () => { throw new Error("offline"); };
  await ci.watchdog(); assert.equal(ci.receipts[p.request_id].state, "failed");
  s.github.rest.repos.createCommitStatus = original; await ci.watchdog(); assert.equal(statuses.at(-1).state, "failure");
});
test("changed PR invalidates receipt and cancels job", async (t) => {
  const { ci, s, p, pr, statuses } = fixture(t); await ci.submit(p, "direct"); await ci.dispatch(ci.receipts[p.request_id]);
  pr.head.sha = "c".repeat(40); await ci.status(p);
  assert.equal(s.state.data.jobs[0].state, "cancelled"); assert.equal(statuses.at(-1).state, "failure");
});
test("complete publication passes, partial or skipped never does", async (t) => {
  for (const kind of ["complete", "partial", "skipped", "blocking"]) {
    const { ci, s, p, statuses } = fixture(t); await ci.submit(p, "direct"); await ci.dispatch(ci.receipts[p.request_id]);
    const job = s.state.data.jobs[0]; job.state = "complete"; job.progress = { complete: kind !== "partial" };
    job.result = { findings: 2, blocking: kind === "blocking" ? 1 : 0, skipped: kind === "skipped" };
    const view = await ci.status(p); assert.equal(view.terminal, true);
    assert.equal(statuses.at(-1).state, kind === "complete" ? "success" : "failure");
    assert.equal(statuses.at(-1).description, kind === "complete" ? "OCR complete: 2 finding(s)" : kind === "blocking" ? "OCR found 1 blocking finding(s)" : "OCR failed: review_incomplete_or_failed");
  }
});
test("late Agent submission and unauthorized actor are rejected", async (t) => {
  const { ci, p } = fixture(t); await ci.submit(p, "agent");
  const args = { ...p, request_id: "github:" + p.request_id };
  await assert.rejects(ci.submitReview(args, { id: "other" }), /actor/);
  ci.stop(ci.receipts[p.request_id], "failed", "expired");
  await assert.rejects(ci.submitReview(args, { id: "agent" }), /terminal/);
});
test("staged gateway cannot receive live tasks", async (t) => {
  const { ci, s, p } = fixture(t); s.config.infrastructure.orgCI.enabled = false;
  await assert.rejects(ci.submit(p, "direct"), /staged/); assert.equal(s.state.data.jobs.length, 0);
});

test("crash between enqueue and receipt update recovers the same job", async (t) => {
  const { ci, s, p } = fixture(t); await ci.submit(p, "direct"); await ci.dispatch(ci.receipts[p.request_id]);
  delete ci.receipts[p.request_id].jobId; s.state.save();
  await ci.submitReview({ ...p, request_id: "github:" + p.request_id }, { id: "org-ci-dispatcher" });
  assert.equal(s.state.data.jobs.length, 1); assert.equal(ci.receipts[p.request_id].jobId, s.state.data.jobs[0].id);
});
test("HTTP gateway enforces both credentials and supports submit/query/track", async (t) => {
  const { s, p } = fixture(t);
  const { ReviewService } = require("./service.js"), { createServer } = require("./server.js");
  const dir = path.dirname(s.state.file), tokenFile = path.join(dir, "ci.token"); fs.writeFileSync(tokenFile, "ci-secret");
  const service = new ReviewService({ config: { ...s.config, stateDirectory: dir,
    repositories: [{ name: p.repository, baseBranches: ["main"] }],
    infrastructure: { ...s.config.infrastructure, enabled: true, externalDispatch: true, dispatchEnabled: false,
      orgCI: { ...s.config.infrastructure.orgCI, tokenFile } } }, github: s.github, state: s.state, log() {} });
  const server = createServer(service, { apiToken: "dispatcher" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const send = (endpoint, body, extra = {}) => fetch(`http://127.0.0.1:${server.address().port}/v2/${endpoint}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer dispatcher", "x-ocr-ci-token": "Bearer ci-secret", ...extra }, body: JSON.stringify(body) });
  assert.equal((await send("ci_submit", { ...p, route: "direct" }, { "x-ocr-ci-token": "wrong" })).status, 401);
  assert.equal((await send("ci_submit", { ...p, route: "direct" }, { authorization: "wrong" })).status, 401);
  const submitted = await send("ci_submit", { ...p, route: "direct" }); assert.equal(submitted.status, 202);
  const ack = await submitted.json(); assert.equal(ack.status_published, true);
  assert.equal((await send("ci_tick", ack)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(service.state.data.jobs.length, 1);
  const job = service.state.data.jobs[0]; job.state = "complete"; job.progress = { complete: true }; job.result = { blocking: 0 };
  const result = await (await send("ci_status", p)).json(); assert.equal(result.commit_status, "success"); assert.equal(result.terminal, true);
});

test("Agent failure falls back and late Agent reuses the same snapshot", async (t) => {
  const { ci, s, p } = fixture(t); ci.config.agentReady = true;
  ci.agentDispatch = async () => { throw new Error("offline"); };
  await ci.submit(p, "agent"); await ci.dispatch(ci.receipts[p.request_id]);
  assert.equal(ci.receipts[p.request_id].dispatchMethod, "direct_fallback");
  await ci.submitReview({ ...p, request_id: "github:" + p.request_id }, { id: "agent" });
  assert.equal(s.state.data.jobs.length, 1);
});
test("CI adopts legacy task and legacy ingress reuses CI task", async (t) => {
  const { ci, s, p, pr } = fixture(t);
  const old = s.state.enqueue(p.repository, pr, { force: true, deduplicateSnapshot: true });
  await ci.submit(p, "direct"); await ci.dispatch(ci.receipts[p.request_id]);
  assert.equal(ci.receipts[p.request_id].jobId, old.id);
  assert.equal(old.ciRequestId, p.request_id);
  const again = s.state.enqueue(p.repository, pr, { force: true, deduplicateSnapshot: true });
  assert.equal(again.id, old.id); assert.equal(s.state.data.jobs.length, 1);
});
test("Agent-route receipt immediately adopts a completed legacy task without dispatch", async (t) => {
  const { ci, s, p, pr, statuses } = fixture(t);
  const job = s.state.enqueue(p.repository, pr, { force: true });
  job.state = "complete"; job.progress = { complete: true }; job.result = { findings: 1, blocking: 1 };
  ci.agentDispatch = async () => { assert.fail("must not call Agent for existing snapshot"); };
  const ack = await ci.submit(p, "agent");
  assert.equal(ack.job_id, job.id); assert.equal(ack.terminal, true);
  assert.equal(ack.commit_status, "failure"); assert.equal(statuses.length, 1);
  assert.equal(ci.receipts[p.request_id].dispatchMethod, "reused_existing");
  assert.equal(ci.receipts[p.request_id].fallbackReason, undefined);
  await ci.dispatch(ci.receipts[p.request_id]); assert.equal(s.state.data.jobs.length, 1);
});
test("task arriving during Agent call is reused even when Agent acknowledgement fails", async (t) => {
  const { ci, s, p, pr } = fixture(t); ci.config.agentReady = true;
  await ci.submit(p, "agent");
  ci.agentDispatch = async () => { s.state.enqueue(p.repository, pr, { force: true }); throw new Error("ACK lost"); };
  await ci.dispatch(ci.receipts[p.request_id]);
  assert.equal(s.state.data.jobs.length, 1);
  assert.equal(ci.receipts[p.request_id].jobId, s.state.data.jobs[0].id);
  assert.equal(ci.receipts[p.request_id].dispatchMethod, "reused_existing");
  assert.equal(ci.receipts[p.request_id].fallbackReason, undefined);
});
test("receipt cannot adopt a different base, preview, or cancelled task", async (t) => {
  for (const kind of ["base", "preview", "cancelled"]) {
    const { ci, s, p, pr } = fixture(t);
    const job = s.state.enqueue(p.repository, pr, { force: true });
    if (kind === "base") job.base = "c".repeat(40);
    if (kind === "preview") job.settings = { preview: true };
    if (kind === "cancelled") job.state = "cancelled";
    const ack = await ci.submit(p, "agent"); assert.equal(ack.job_id, null);
  }
});
test("feedback cleanup removes only sent entries older than retention", async (t) => {
  const { s } = fixture(t); const { ReviewService } = require("./service.js");
  s.config.stateDirectory = path.dirname(s.state.file); s.config.retentionDays = 7;
  fs.mkdirSync(path.join(s.config.stateDirectory, "runs"));
  const old = new Date(Date.now() - 8 * 86400000).toISOString(), recent = new Date().toISOString();
  s.state.data.agentFeedback = [
    { id: "expired", state: "sent", sentAt: old }, { id: "recent", state: "sent", sentAt: recent },
    { id: "pending", state: "pending", createdAt: old }, { id: "failed", state: "failed", createdAt: old }];
  ReviewService.prototype.cleanup.call(s);
  assert.deepEqual(s.state.data.agentFeedback.map((x) => x.id), ["recent", "pending", "failed"]);
  assert.equal(JSON.parse(fs.readFileSync(s.state.file)).agentFeedback.length, 3);
});
