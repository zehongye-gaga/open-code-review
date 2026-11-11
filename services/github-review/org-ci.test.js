// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

// SPDX-License-Identifier: Apache-2.0
"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { OrgCI, identity } = require("./org-ci.js");
const { State } = require("./state.js");
const { ReviewService } = require("./service.js");
function input(extra = {}) {
  const p = { base_ref: "release/company", base_sha: "b".repeat(40), head_sha: "a".repeat(40), pull_number: 12, repository: "lexmount/example", ...extra };
  const str = JSON.stringify(p).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  return { schema: "ocr-ci/v1", ...p, request_id: "ocr-ci-" + crypto.createHash("sha256").update(str).digest("hex") };
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "org-ci-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statuses = [], p = input();
  const pr = { number: 12, state: "open", draft: true, head: { sha: p.head_sha }, base: { sha: p.base_sha, ref: p.base_ref, repo: { full_name: p.repository } } };
  const s = { state: new State(dir), workers: new Map(), commitStatusWrites: new Map(),
    writeCommitStatus: ReviewService.prototype.writeCommitStatus, log() {},
    config: { binary: __filename, provider: "test", model: "test", timeoutSeconds: 30, fetchTimeoutSeconds: 30, blockSeverity: "high", statusContext: "ocr-review",
      infrastructure: { orgCI: { enabled: true, totalSeconds: 7200, heartbeatSeconds: 300 }, agentDispatch: { clientId: "agent" } } },
    coordinates: () => ({ owner: "lexmount", repo: "example" }), repo: () => ({ name: p.repository, defaultProfile: "standard" }),
    eligible: (_repo, pull, job) => job.ciRequestId && pull.state === "open",
    github: { rest: { pulls: { get: async () => ({ data: pr }) }, repos: { createCommitStatus: async (args) => { statuses.push(args); } } } },
    accept: (repo, pull, options) => s.state.enqueue(repo, pull, options) };
  const enqueue = s.state.enqueue.bind(s.state);
  s.state.enqueue = (repo, pull, options = {}) => enqueue(repo, pull, { settings: require("./review-policy.js").bindPolicy(s,s.repo(repo),require("./options.js").resolveOptions(s.config, s.repo(repo))), ...options });
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
  s.github.rest.repos.createCommitStatus = async (args) => { assert.ok(require("./state-sqlite.js").readState(path.join(path.dirname(s.state.file), "state.db")).data.ciReceipts[p.request_id]); await original(args); };
  const r = await ci.submit(p, "direct"); assert.equal(r.durable, true); assert.equal(r.commit_status, null);
  assert.equal(statuses.length, 0); await ci.watchdog();
  await ci.submit(p, "agent"); assert.equal(ci.receipts[p.request_id].route, "direct"); assert.equal(statuses.length, 1);
});
test("pending status failure is retried without creating another receipt", async (t) => {
  const { ci, s, p } = fixture(t); const original = s.github.rest.repos.createCommitStatus;
  s.github.rest.repos.createCommitStatus = async () => { throw new Error("offline"); };
  assert.equal((await ci.submit(p, "direct")).durable, true);
  await ci.watchdog(); assert.equal(ci.view(ci.receipts[p.request_id]).status_published, false);
  s.github.rest.repos.createCommitStatus = original;
  assert.equal((await ci.submit(p, "direct")).status_published, false);
  await ci.watchdog(); assert.equal(ci.view(ci.receipts[p.request_id]).status_published, true); assert.equal(Object.keys(ci.receipts).length, 1);
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
test("n8n loss cannot fail a durably accepted receipt", async (t) => {
  const { ci, p, statuses } = fixture(t); await ci.submit(p, "direct");
  ci.receipts[p.request_id].heartbeatAt -= 301000; await ci.watchdog();
  assert.equal(statuses.at(-1).state, "pending"); assert.equal(ci.receipts[p.request_id].state, "accepted");
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
test("complete publication passes; partial and unverified skipped results fail", async (t) => {
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

test("unenrolled CI snapshots persist successful skips without GitHub or review work", async (t) => {
  const { ci, s, p, statuses } = fixture(t); s.repo = () => null;
  s.github.rest.pulls.get = async () => { throw Error("Skipped admission must not read GitHub"); };
  const ack = await ci.submit(p, "agent");
  assert.equal(ack.state, "skipped"); assert.equal(ack.outcome, "skipped");
  assert.equal(ack.reason, "repository_not_enabled"); assert.equal(ack.terminal, true);
  assert.equal(ack.durable, true); assert.equal(ack.acceptance, "accepted");
  assert.equal(ack.contract_version, 2); assert.equal(ack.job_id, null);
  assert.equal(ack.status_published, false); assert.equal(ack.commit_status, null);
  const sequence = ci.receipts[p.request_id].sequence;
  s.state = new State(path.dirname(s.state.file)); const restored = new OrgCI(s);
  assert.equal((await restored.submit(p, "direct")).state, "skipped");
  assert.equal(restored.receipts[p.request_id].sequence, sequence);
  assert.equal((await restored.status(p)).state, "skipped");
  assert.equal((await restored.tick(p)).state, "skipped");
  await restored.dispatch(restored.receipts[p.request_id]); await restored.watchdog();
  assert.equal(s.state.data.jobs.length, 0); assert.equal(statuses.length, 0);
  assert.equal(Object.keys(restored.receipts).length, 1);
  await assert.rejects(restored.submitReview({ ...p, request_id: "github:" + p.request_id }, { id: "agent" }), /terminal/);
});

test("enrolling a skipped repository admits the same snapshot once and retains skip history", async (t) => {
  const { ci, s, p } = fixture(t), repo = s.repo;
  s.repo = () => null; await ci.submit(p, "agent"); s.repo = repo;
  await Promise.all([ci.submit(p, "direct"), ci.submit(p, "direct")]);
  const r = ci.receipts[p.request_id];
  assert.equal(r.state, "accepted"); assert.equal(r.reason, undefined);
  assert.equal(r.admissionHistory.length, 1);
  assert.equal(r.admissionHistory[0].reason, "repository_not_enabled");
  await ci.dispatch(r);
  assert.equal(s.state.data.jobs.length, 1); assert.equal(r.jobId, s.state.data.jobs[0].id);
});

test("removing enrollment preserves existing job evidence and skip ACK requires persistence", async (t) => {
  const { ci, s, p } = fixture(t); await ci.submit(p, "direct"); await ci.dispatch(ci.receipts[p.request_id]);
  const jobId = ci.receipts[p.request_id].jobId; s.repo = () => null;
  assert.equal((await ci.submit(p, "agent")).job_id, jobId);
  assert.equal(s.state.data.jobs.length, 1);
  const next = input({ head_sha: "c".repeat(40) });
  s.state.save = () => { throw Object.assign(Error("Disk unavailable"), { persistence: true }); };
  await assert.rejects(ci.submit(next, "direct"), /Disk unavailable/);
  await assert.rejects(ci.submit(next, "direct"), /Disk unavailable/);
  await assert.rejects(ci.status(next), /Disk unavailable/);
  await assert.rejects(ci.tick(next), /Disk unavailable/);
});

test("status and heartbeat queries observe completed enrollment promotion under the receipt lock", async (t) => {
  const { ci, s, p, pr } = fixture(t), repo = s.repo;
  s.repo = () => null; await ci.submit(p, "direct"); s.repo = repo;
  let release, entered;
  const reading = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let first = true;
  s.github.rest.pulls.get = async () => {
    if (first) { first = false; entered(); await gate; }
    return { data: pr };
  };
  const promotion = await ci.submit(p, "direct");
  assert.equal(promotion.admission_pending, true);
  const verifying = ci.watchdog(); await reading;
  const status = ci.status(p), heartbeat = ci.tick(p);
  release();
  await verifying;
  for (const result of await Promise.all([status, heartbeat])) assert.equal(result.state, "accepted");
  assert.equal(ci.receipts[p.request_id].state, "accepted");
  assert.equal(ci.receipts[p.request_id].admissionHistory.length, 1);
});

test("HTTP skip ACK retains both credentials, client scope and direct-review authorization", async (t) => {
  const { s, p } = fixture(t), { createServer } = require("./server.js");
  const dir = path.dirname(s.state.file), file = name => path.join(dir, name);
  for (const name of ["ci", "dispatcher", "scoped", "agent"]) fs.writeFileSync(file(name), name);
  const service = new ReviewService({ config: { ...s.config, stateDirectory: dir,
    repositories: [{ name: p.repository, baseBranches: ["main"] }],
    infrastructure: { ...s.config.infrastructure, enabled: true, externalDispatch: true, dispatchEnabled: true,
      orgCI: { enabled: true, tokenFile: file("ci") }, clients: [
        { id: "dispatcher", role: "dispatcher", tokenFile: file("dispatcher"), repositories: ["lexmount/*"] },
        { id: "scoped", role: "dispatcher", tokenFile: file("scoped"), repositories: [p.repository] },
        { id: "agent", role: "agent", tokenFile: file("agent"), repositories: ["lexmount/*"] },
      ] } }, github: s.github, state: s.state, log() {} });
  service.github.rest.pulls.get = async () => { throw Error("Skip must not fetch PR"); };
  const server = createServer(service);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const body = input({ repository: "lexmount/not-enabled" });
  const send = (endpoint, value, authorization = "dispatcher", ciToken = "ci") => fetch(`http://127.0.0.1:${server.address().port}/v2/${endpoint}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${authorization}`,
      "x-ocr-ci-token": `Bearer ${ciToken}` }, body: JSON.stringify(value) });
  assert.equal((await send("ci_submit", { ...body, route: "agent" }, "wrong")).status, 401);
  assert.equal((await send("ci_submit", { ...body, route: "agent" }, "dispatcher", "wrong")).status, 401);
  assert.equal((await send("ci_submit", { ...body, route: "agent" }, "scoped")).status, 403);
  assert.equal((await send("ci_submit", { ...body, request_id: "wrong", route: "agent" })).status, 409);
  const response = await send("ci_submit", { ...body, route: "agent" });
  assert.equal(response.status, 202); assert.equal((await response.json()).state, "skipped");
  assert.equal((await send("ci_status", body)).status, 200);
  assert.equal((await send("ci_tick", body)).status, 200);
  assert.equal((await send("submit_review", { repository: body.repository, pull_number: body.pull_number,
    head_sha: body.head_sha, base_sha: body.base_sha }, "agent")).status, 403);
  await service.orgCI.watchdog(); await service.githubEvents.tick();
  assert.equal(service.state.data.jobs.length, 0);
  assert.equal(Object.keys(service.state.data.ciReceipts).length, 1);
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
  const ack = await submitted.json(); assert.equal(ack.status_published, false);
  assert.equal((await send("ci_tick", ack)).status, 200);
  await service.githubEvents.tick();
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
test("Agent-route receipt adopts a completed legacy task after background verification without dispatch", async (t) => {
  const { ci, s, p, pr, statuses } = fixture(t);
  const job = s.state.enqueue(p.repository, pr, { force: true });
  job.state = "complete"; job.progress = { complete: true }; job.result = { findings: 1, blocking: 1 };
  ci.agentDispatch = async () => { assert.fail("must not call Agent for existing snapshot"); };
  const ack = await ci.submit(p, "agent");
  assert.equal(ack.job_id, null); assert.equal(ack.admission_pending, true); assert.equal(ack.terminal, false);
  assert.equal(ack.commit_status, null); assert.equal(statuses.length, 0);
  await ci.watchdog(); assert.equal(ci.view(ci.receipts[p.request_id]).commit_status, "failure");
  assert.equal(ci.receipts[p.request_id].jobId, job.id);
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
test("feedback cleanup retains disabled history and removes only expired sent entries", async (t) => {
  const { s } = fixture(t); const { ReviewService } = require("./service.js");
  s.config.stateDirectory = path.dirname(s.state.file); s.config.retentionDays = 7;
  fs.mkdirSync(path.join(s.config.stateDirectory, "runs"));
  const old = new Date(Date.now() - 8 * 86400000).toISOString(), recent = new Date().toISOString();
  s.state.data.agentFeedback = [
    { id: "expired", state: "sent", sentAt: old }, { id: "recent", state: "sent", sentAt: recent },
    { id: "pending", state: "pending", createdAt: old }, { id: "failed", state: "failed", createdAt: old },
    { id: "disabled", state: "disabled", createdAt: old, disabledReason: "result_feedback_removed" }];
  ReviewService.prototype.cleanup.call(s);
  assert.deepEqual(s.state.data.agentFeedback.map((x) => x.id), ["recent", "pending", "failed", "disabled"]);
  assert.equal(require("./state-sqlite.js").readState(path.join(path.dirname(s.state.file), "state.db")).data.agentFeedback.length, 4);
});
test("reopened closed PR reaccepts the same receipt and dispatches only once", async (t) => {
  const { ci, s, p, pr, statuses } = fixture(t);
  await ci.submit(p, "direct"); pr.state = "closed"; await ci.refresh(ci.receipts[p.request_id]);
  assert.equal(ci.receipts[p.request_id].reason, "pr_closed");
  assert.equal((await ci.submit(p, "direct")).admission_pending, true);
  await ci.watchdog(); assert.equal(ci.receipts[p.request_id].reason, "pr_closed");
  pr.state = "open";
  await Promise.all([ci.submit(p, "direct"), ci.submit(p, "direct")]);
  await ci.watchdog();
  const r = ci.receipts[p.request_id]; assert.equal(r.state, "accepted"); assert.equal(r.reopenHistory.length, 1);
  await ci.watchdog();
  assert.equal(statuses.at(-1).state, "pending");
  await ci.dispatch(r); assert.equal(s.state.data.jobs.length, 1);
});
test("legacy closed receipt can reopen but changed snapshots and newer receipts cannot", async (t) => {
  for (const changed of [false, true]) {
    const { ci, p, pr } = fixture(t); await ci.submit(p, "direct");
    const r = ci.receipts[p.request_id]; ci.stop(r, "superseded", "pr_changed_or_closed");
    if (changed) pr.head.sha = "c".repeat(40);
    else ci.receipts.newer = { ...r, sequence:r.sequence + 1, request_id:"newer", admissionVerified:true };
    assert.equal((await ci.submit(p, "direct")).admission_pending, changed);
    await ci.watchdog(); assert.equal(r.state, "superseded"); assert.equal(r.jobId, undefined);
    if (!changed) {
      delete ci.receipts.newer; await ci.submit(p, "direct"); await ci.watchdog();
      assert.equal(r.state, "accepted");
    } else assert.equal(r.reason, "pr_snapshot_changed");
  }
});
test("cancelled OCR job is reused only after worker and dispatch shutdown", async (t) => {
  const { ci, s, p, pr } = fixture(t); await ci.submit(p, "direct"); await ci.dispatch(ci.receipts[p.request_id]);
  const r=ci.receipts[p.request_id], job=s.state.data.jobs[0]; job.snapshot={ retained:true };
  pr.state="closed"; await ci.refresh(r); pr.state="open";
  ci.dispatching.add(r.request_id); assert.equal((await ci.submit(p,"direct")).admission_pending,true);
  await ci.refresh(r,false); assert.match(r.pendingAdmission.lastError.message,/still stopping/); ci.dispatching.clear();
  s.workers.set(0,{job});r.pendingAdmission.nextAt=0;await ci.refresh(r,false);
  assert.equal(job.state,"cancelled");assert.ok(r.pendingAdmission);s.workers.clear();
  r.pendingAdmission.nextAt=0;await ci.refresh(r,false);
  assert.equal(r.jobId,job.id);assert.equal(job.state,"queued");assert.deepEqual(job.snapshot,{retained:true});
  await ci.dispatch(r);assert.equal(s.state.data.jobs.length,1);
});
test("snapshot changes are not resurrected when a branch returns to the old commit", async(t)=>{
 const {ci,p,pr}=fixture(t);await ci.submit(p,"direct");const r=ci.receipts[p.request_id];
 pr.head.sha="c".repeat(40);await ci.refresh(r);assert.equal(r.reason,"pr_snapshot_changed");
 pr.head.sha=p.head_sha;assert.equal((await ci.submit(p,"direct")).state,"superseded");
});

test("verified zero-item skip is terminal and never redispatched", async (t) => {
  const { ci, s, p, statuses } = fixture(t); await ci.submit(p, "direct"); await ci.dispatch(ci.receipts[p.request_id]);
  const job = s.state.data.jobs[0]; job.state = "complete";
  job.progress = { complete: false, skipped: true, selected: 0 };
  job.result = { findings: 0, blocking: 0, skipped: true, summaryURL: "https://example.test/review" };
  const view = await ci.status(p);
  assert.equal(view.state, "skipped"); assert.equal(view.terminal, true);
  assert.equal(view.reason, "no_reviewable_items"); assert.equal(view.commit_status, "success");
  assert.equal(statuses.at(-1).description, "OCR skipped: no reviewable items");
  await ci.tick(p); await ci.submit(p, "direct");
  assert.equal(s.state.data.jobs.length, 1); assert.equal(job.state, "complete");
});

test("completed backend result wins over expired receipt heartbeat and deadline", async (t) => {
  for (const skipped of [false, true]) {
    const {ci,s,p,statuses}=fixture(t); await ci.submit(p,"direct"); await ci.dispatch(ci.receipts[p.request_id]);
    const j=s.state.data.jobs[0];j.state="complete";j.progress={complete:!skipped,skipped,selected:skipped?0:1};
    j.result={skipped,findings:0,blocking:0,summaryURL:"https://example.test/review"};
    ci.receipts[p.request_id].heartbeatAt-=400000;ci.receipts[p.request_id].createdAt-=8000000;
    await ci.watchdog();assert.equal(statuses.at(-1).state,"success");assert.equal(j.attempt,0);
    assert.equal(ci.receipts[p.request_id].state,skipped?"skipped":"complete");
  }
});
test("lost tracker does not cancel an accepted backend job, but execution deadline still applies", async(t)=>{
  const {ci,s,p}=fixture(t);await ci.submit(p,"direct");await ci.dispatch(ci.receipts[p.request_id]);
  const r=ci.receipts[p.request_id],j=s.state.data.jobs[0];j.state="running";r.heartbeatAt-=400000;
  await ci.watchdog();assert.equal(j.state,"running");assert.equal(r.state,"running");
  r.createdAt-=8000000;await ci.watchdog();assert.equal(j.state,"cancelled");assert.equal(r.state,"failed");
  assert.equal(r.reason,"review_deadline_exceeded");
});

test("an unavailable PR API cannot prevent an active execution deadline",async(t)=>{
 const {ci,s,p}=fixture(t);await ci.submit(p,"direct");await ci.dispatch(ci.receipts[p.request_id]);
 ci.receipts[p.request_id].createdAt-=8000000;
 s.github.rest.pulls.get=async()=>{throw Error("GitHub unreachable");};
 await ci.watchdog();assert.equal(ci.receipts[p.request_id].reason,"review_deadline_exceeded");
 assert.equal(ci.receipts[p.request_id].published.state,"failure");
});

test("snapshot changes during Agent dispatch supersede receipts without execution alerts", async(t)=>{
 const {ci,s,p,pr}=fixture(t);s.config.infrastructure.orgCI.agentReady=true;
 await ci.submit(p,"agent");ci.agentDispatch=async()=>{pr.head.sha="c".repeat(40);throw new Error("Agent response lost");};
 await ci.dispatch(ci.receipts[p.request_id]);
 const r=ci.receipts[p.request_id];assert.equal(r.state,"superseded");assert.equal(r.reason,"pr_snapshot_changed");
 assert.equal(r.lastDispatchError.code,"PR_SNAPSHOT_CHANGED");
 assert.equal(require('./pr-alerts.js').events(s.state.data).length,0);assert.equal(s.state.data.jobs.length,0);
});
test("configuration conflicts remain failures rather than being silently superseded", async(t)=>{
 const {ci,s,p}=fixture(t);await ci.submit(p,"agent");
 ci.current=async()=>{throw Object.assign(new Error("Configuration conflict"),{status:409});};
 await ci.dispatch(ci.receipts[p.request_id]);assert.equal(ci.receipts[p.request_id].state,"failed");
 assert.equal(ci.receipts[p.request_id].reason,"dispatch_configuration_or_access_error");
});
test("App delivery acknowledgement binds a matching Policy receipt after its verification",async(t)=>{
 const {ci,s,p,pr}=fixture(t);await ci.submit(p,"agent");
 const job=s.state.enqueue(p.repository,pr,{force:true});
 const event={id:'app-event',repository:p.repository,number:p.pull_number,head:p.head_sha,base:p.base_sha,route:'agent'};
 require('./delivery.js').acknowledgeDelivery(s,event,job,{id:'agent'});
 assert.equal(ci.receipts[p.request_id].jobId,undefined);
 await ci.refresh(ci.receipts[p.request_id],false);
 assert.equal(ci.receipts[p.request_id].jobId,job.id);assert.equal(job.ciRequestId,p.request_id);
 ci.agentDispatch=async()=>{throw new Error('Must not contact Agent again');};
 await ci.dispatch(ci.receipts[p.request_id]);assert.equal(s.state.data.jobs.length,1);
});
test("refresh recovers a task missed by acknowledgement before heartbeat timeout",async(t)=>{
 const {ci,s,p,pr}=fixture(t);await ci.submit(p,"agent");
 const r=ci.receipts[p.request_id];r.heartbeatAt-=301000;
 const job=s.state.enqueue(p.repository,pr,{force:true});
 await ci.refresh(r);assert.equal(r.jobId,job.id);assert.equal(r.state,'queued');
 assert.equal(job.state,'queued');assert.equal(s.state.data.jobs.length,1);
});

test("backend scheduler recovers persisted admission without any n8n tick", async(t)=>{
 const {ci,s,p}=fixture(t);await ci.submit(p,"direct");
 s.state=new State(path.dirname(s.state.file));s.orgCI=new OrgCI(s);
 s.config.infrastructure.externalDispatch=true;
 const events=s.githubEvents=new (require('./events.js').GitHubEvents)(s);
 await Promise.all([events.tick(),events.tick()]);
 assert.equal(s.state.data.jobs.length,1);assert.equal(s.orgCI.receipts[p.request_id].jobId,s.state.data.jobs[0].id);
 assert.equal(s.orgCI.view(s.orgCI.receipts[p.request_id]).scheduler,'backend');
});
test("explicit Actions rerun reopens failed admission once and never revives superseded work",async(t)=>{
 const {ci,p}=fixture(t);await ci.submit(p,'direct');const r=ci.receipts[p.request_id];ci.stop(r,'failed','dispatch_retries_exhausted');
 await ci.submit(p,'direct');assert.equal(r.state,'failed');
 assert.equal((await ci.submit({...p,retry_key:'123:2'},'direct')).admission_pending,true);
 await ci.watchdog();assert.equal(r.state,'accepted');
 ci.stop(r,'failed','dispatch_retries_exhausted');await ci.submit({...p,retry_key:'123:2'},'direct');assert.equal(r.state,'failed');
 ci.stop(r,'superseded','pr_snapshot_changed');await ci.submit({...p,retry_key:'123:3'},'direct');assert.equal(r.state,'superseded');
});
test("Policy cannot adopt a weaker verdict threshold or a changed policy",async(t)=>{
 for(const change of [{options:{blockSeverity:'high'}},{policyVersion:'obsolete'}]){
  const {ci,s,p,pr}=fixture(t);const settings=require('./options.js').resolveOptions(s.config,s.repo(p.repository));
  const old=s.state.enqueue(p.repository,pr,{force:true,settings:{...settings,...change}});
  old.state='complete';old.progress={complete:true};old.result={findings:1,blocking:0};
  await ci.submit(p,'direct');await ci.dispatch(ci.receipts[p.request_id]);
  assert.notEqual(ci.receipts[p.request_id].jobId,old.id);assert.equal(s.state.data.jobs.length,2);
 }
});
test("both ingresses classify real configuration conflicts as failures",()=>{
 const {dispatchFailure}=require('./dispatch-control.js');
 assert.equal(dispatchFailure({status:409}).state,'failed');
 assert.equal(dispatchFailure({status:409,code:'PR_SNAPSHOT_CHANGED'}).state,'superseded');
 for(const status of [408,429,500,502,503])assert.equal(dispatchFailure({status}).retryable,true);
 for(const status of [400,401,403,404,409,422])assert.equal(dispatchFailure({status}).retryable,false);
});
test("App and CI share dispatch capacity and per-PR ownership",async(t)=>{
 const {ci,s,p}=fixture(t);s.config.dispatchConcurrency=1;s.config.infrastructure.externalDispatch=true;
 await ci.submit(p,'direct');const events=s.githubEvents=new(require('./events.js').GitHubEvents)(s);
 let release;const gate=new Promise(r=>release=r);let calls=0;
 ci.dispatch=async()=>{calls++;await gate;};
 const first=events.tick();await events.tick();assert.equal(calls,1);assert.equal(events.activeDispatches.size,1);
 release();await first;assert.equal(events.activeDispatches.size,0);
});
test("real Policy Python client accepts backend HTTP admission and all terminal projections",async(t)=>{
 const client=process.env.OCR_POLICY_CLIENT || path.resolve(__dirname,'../../../github-policy-public/ocr/ci_client.py');
 if(!fs.existsSync(client)){t.skip('Set OCR_POLICY_CLIENT to run the cross-repository contract test');return;}
 const {ci,s,p,pr}=fixture(t);const dir=path.dirname(s.state.file);
 const publish = s.github.rest.repos.createCommitStatus; let statusCalls = 0;
 s.github.rest.repos.createCommitStatus = async () => { statusCalls++; throw Error('GitHub status offline'); };
 const eventFile=path.join(dir,'event.json');fs.writeFileSync(eventFile,JSON.stringify({pull_request:pr}));
 const gateway=require('node:http').createServer(async(req,res)=>{
  try {let body='';for await(const chunk of req)body+=chunk;
   const input=JSON.parse(body);assert.equal(req.headers.authorization,'Bearer fixture');
   const view=req.url==='/ocr-ci-submit'?await ci.submit(input,'direct'):await ci.status(input);
   res.writeHead(202,{'content-type':'application/json'});res.end(JSON.stringify(view));
  }catch(e){res.writeHead(502);res.end('{}');}
 });
 await new Promise(r=>gateway.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>gateway.close(r)));
 const script="import importlib.util,sys,json; s=importlib.util.spec_from_file_location('client',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.BASE_URL=sys.argv[2];sys.exit(m.main())";
 await new Promise((resolve,reject)=>{
  const child=require('node:child_process').spawn('python3',['-c',script,client,`http://127.0.0.1:${gateway.address().port}/`],{env:{...process.env,GITHUB_EVENT_NAME:'pull_request_target',GITHUB_REPOSITORY:p.repository,GITHUB_EVENT_PATH:eventFile,OCR_CI_TOKEN:'fixture'}});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(output)));
 });
 assert.equal(s.state.data.jobs.length,0); assert.equal(statusCalls,0);
 s.github.rest.repos.createCommitStatus = publish;
 s.githubEvents=new(require('./events.js').GitHubEvents)(s);await s.githubEvents.tick();assert.equal(s.state.data.jobs.length,1);
 const j=s.state.data.jobs[0],r=ci.receipts[p.request_id],rows=[];
 for(const kind of ['complete','blocked','skipped','execution_failed','publication_failed','cancelled','superseded']){
  r.state='queued';delete r.finalStatus;delete r.reason;
  j.state=['execution_failed','publication_failed'].includes(kind)?'failed':['cancelled','superseded'].includes(kind)?kind:'complete';
  j.failurePhase=kind==='publication_failed'?'publication':'review';
  j.progress={complete:kind!=='skipped',skipped:kind==='skipped',selected:kind==='skipped'?0:1};
  j.result={findings:kind==='blocked'?1:0,blocking:kind==='blocked'?1:0,skipped:kind==='skipped',summaryURL:'https://example.test/review'};
  await ci.refresh(r);rows.push(ci.view(r));
 }
 const check="import importlib.util,sys,json;s=importlib.util.spec_from_file_location('client',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);rows=json.load(sys.stdin);[m.check_identity(r,{k:r[k] for k in ['repository','pull_number','head_sha','base_sha','base_ref']}) for r in rows];assert all(m.verdict(r)==0 for r in rows)";
 const result=require('node:child_process').spawnSync('python3',['-c',check,client],{input:JSON.stringify(rows),encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.equal(rows.find(r=>r.outcome==='skipped').commit_status,'success');
});

test("legacy false failures reconcile only with verified evidence and current snapshot",async(t)=>{
 for(const stale of [false,true]){
  const {ci,s,p,pr}=fixture(t);await ci.submit(p,'direct');await ci.dispatch(ci.receipts[p.request_id]);
  const r=ci.receipts[p.request_id],j=s.state.data.jobs[0];j.state='complete';
  j.progress={skipped:true,selected:0};j.result={skipped:true,findings:0,blocking:0,summaryURL:'https://example.test/review'};
  r.state='failed';r.reason='review_incomplete_or_failed';r.published={state:'failure'};
  if(stale)pr.head.sha='c'.repeat(40);
  await ci.watchdog();assert.equal(r.state,stale?'superseded':'skipped');assert.equal(r.published.state,stale?'failure':'success');
  assert.equal(r.reconciliation.previous.state,'failed');assert.equal(s.state.data.jobs.length,1);
 }
});


test("a retry key observed before failure cannot later reopen the receipt", async t => {
  for (const initial of [false, true]) {
    const { ci, p } = fixture(t);
    await ci.submit(initial ? { ...p, retry_key: "456:2" } : p, "direct");
    if (!initial) await ci.submit({ ...p, retry_key: "456:2" }, "direct");
    const receipt = ci.receipts[p.request_id];
    ci.stop(receipt, "failed", "dispatch_retries_exhausted");
    await ci.submit({ ...p, retry_key: "456:2" }, "direct");
    assert.equal(receipt.state, "failed");
    await ci.submit({ ...p, retry_key: "456:3" }, "direct");
    await ci.watchdog();
    assert.equal(receipt.state, "accepted");
  }
});

test("GitHub rate limits retry while genuine permission failures remain terminal", () => {
  const { dispatchFailure } = require("./dispatch-control.js");
  for (const response of [{ headers: { "retry-after": "60" } }, { headers: { "x-ratelimit-remaining": "0" } }, { data: { message: "API rate limit exceeded" } }]) {
    const result = dispatchFailure({ status: 403, response });
    assert.equal(result.retryable, true);
    assert.equal(result.reason, "github_rate_limited");
    assert.ok(result.retryAt > Date.now());
  }
  assert.equal(dispatchFailure({ status: 403 }).retryable, false);
  assert.equal(dispatchFailure({ status: 403, code: "REPOSITORY_NOT_ALLOWED" }).reason, "repository_not_allowed");
});

test("legacy executor hashes remain reusable only under the same effective policy", t => {
  const { s, p, pr } = fixture(t);
  const policy = require("./review-policy.js");
  const job = s.state.enqueue(p.repository, pr);
  delete job.settings.policySignature;
  job.settings.executorVersion = policy.legacyExecutorVersion(s.config.binary);
  assert.equal(policy.currentPolicy(s, job), true);
  s.config.model = "changed-model";
  assert.equal(policy.currentPolicy(s, job), false);
});

test("CI transient dispatch failures back off through eight attempts", async t => {
  const {ci,p}=fixture(t); await ci.submit(p,"direct");
  const r=ci.receipts[p.request_id];
  ci.submitReview=async()=>{throw Object.assign(new Error("unavailable"),{status:503});};
  for(let n=1;n<=8;n++) {
    r.nextDispatchAt=0; const before=Date.now(); await ci.dispatch(r);
    assert.equal(r.dispatchAttempts,n);
    assert.equal(r.state,n===8?"failed":"retrying");
    if(n<8) assert.ok(r.nextDispatchAt>=before+(n>=5?240000:30000*2**(n-1)));
  }
  assert.equal(r.reason,"dispatch_retries_exhausted");
});

test("durable ACK and duplicate do not wait for a hung background status request", async t => {
  for (const failed of [false, true]) {
  const { ci, s, p } = fixture(t);
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  s.github.rest.repos.createCommitStatus = async () => { started(); await blocked; };
  const ack = await ci.submit(p, "direct");
  assert.equal(ack.acceptance, "accepted"); assert.equal(ack.status_published, false);
  if (failed) ci.stop(ci.receipts[p.request_id], "failed", "dispatch_retries_exhausted");
  const watchdog = ci.watchdog(); await entered;
  try {
    s.github.rest.pulls.get = async () => { throw new Error("GitHub offline"); };
    const duplicate = await Promise.race([
      ci.submit(p, "agent"),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(Error("ACK blocked by watchdog")), 500); timer.unref(); }),
    ]);
    assert.equal(duplicate.task_id, ack.task_id); assert.equal(duplicate.durable, true);
    assert.equal(ci.receipts[p.request_id].route, "direct");
  } finally { release(); await watchdog; }
  }
});

test("failed persistence never returns a durable ACK, including repeated admission", async t => {
  for (const duplicate of [false, true]) {
    const { ci, s, p } = fixture(t);
    if (duplicate) await ci.submit(p, "direct");
    s.state.save = () => { throw Object.assign(Error("disk full"), { persistence: true }); };
    await assert.rejects(ci.submit(p, "direct"), { persistence: true });
    await assert.rejects(ci.submit(p, "direct"), { persistence: true });
  }
});

test("restart retries unpublished receipt without rerunning or duplicating its job", async t => {
  const { ci, s, p, statuses } = fixture(t);
  const original = s.github.rest.repos.createCommitStatus;
  s.github.rest.repos.createCommitStatus = async () => { throw Error("status unavailable"); };
  await ci.submit(p, "direct"); await ci.watchdog();
  await ci.dispatch(ci.receipts[p.request_id]);
  assert.equal(s.state.data.jobs.length, 1);
  const id = ci.receipts[p.request_id].jobId;
  s.state = new State(path.dirname(s.state.file)); const restarted = new OrgCI(s); s.orgCI = restarted;
  const ack = await restarted.submit(p, "direct"); assert.equal(ack.job_id, id);
  s.github.rest.repos.createCommitStatus = original;
  await restarted.watchdog(); await restarted.dispatch(restarted.receipts[p.request_id]);
  assert.equal(statuses.at(-1).state, "pending"); assert.equal(s.state.data.jobs.length, 1);
});

test("first admission persists before snapshot verification and background failure cannot create jobs", async t => {
  for (const changed of [false,true]) {
    const {ci,s,p,pr}=fixture(t);
    if(changed)pr.head.sha="c".repeat(40);
    else s.github.rest.pulls.get=async()=>{throw Error("GitHub unavailable");};
    const ack=await ci.submit(p,"direct");assert.equal(ack.admission_pending,true);assert.equal(ack.durable,true);
    await ci.watchdog();const r=ci.receipts[p.request_id];
    assert.equal(s.state.data.jobs.length,0);
    if(changed){assert.equal(r.state,"superseded");assert.equal(r.reason,"pr_snapshot_changed");}
    else{assert.equal(r.pendingAdmission.attempts,1);assert.match(r.pendingAdmission.lastError.message,/unavailable/);}
  }
});
