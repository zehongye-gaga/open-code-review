// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { ReviewService } = require("./service.js"), { createServer } = require("./server.js");
const { OrgCI, requestId } = require("./org-ci.js"), { State } = require("./state.js");
const { readState } = require("./state-sqlite.js");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function wait(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Background operation did not start")), 2000); })]); }
  finally { clearTimeout(timer); }
}
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ci-ack-")), statuses = [], calls = [];
  const token = path.join(directory, "gateway"), ciToken = path.join(directory, "ci"), binary = path.join(directory, "ocr");
  fs.writeFileSync(token, "gateway-fixture"); fs.writeFileSync(ciToken, "ci-fixture"); fs.writeFileSync(binary, "fixture");
  const pr = { number: 1, state: "open", draft: false, head: { sha: "a".repeat(40) },
    base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "lexmount/example" } } };
  const github = { getToken: async () => "fixture", rest: {
    pulls: { get: async args => { calls.push(args); return { data: pr }; } },
    repos: { createCommitStatus: async value => { statuses.push(value); } },
  } };
  const service = new ReviewService({ config: { binary, stateDirectory: directory,
    repositories: [{ name: "lexmount/example", baseBranches: ["main"] }],
    infrastructure: { enabled: true, externalDispatch: true, dispatchEnabled: true,
      clients: [{ id: "n8n", role: "dispatcher", repositories: ["lexmount/example"], tokenFile: token }],
      orgCI: { enabled: true, tokenFile: ciToken } } }, github, log() {} });
  const server = createServer(service);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); service.state.database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const snapshot = (extra = {}) => {
    const p = { repository: "lexmount/example", pull_number: 1, head_sha: pr.head.sha, base_sha: pr.base.sha, base_ref: pr.base.ref, ...extra };
    return { ...p, schema: "ocr-ci/v1", request_id: requestId(p), route: "direct" };
  };
  const post = async (payload, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v2/ci_submit`, { method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer gateway-fixture", "x-ocr-ci-token": "Bearer ci-fixture", ...headers },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(2000) });
    return { status: response.status, body: await response.json() };
  };
  return { service, ci: service.orgCI, directory, github, pr, snapshot, post, calls, statuses,
    read: () => readState(path.join(directory, "state.db")).data };
}

test("CI HTTP ACK commits pending verification and never waits for the GitHub lookup or its lock", { timeout: 6000 }, async t => {
  const f = await fixture(t), blocked = deferred(), entered = deferred(); let reads = 0, work;
  f.github.rest.pulls.get = async () => { reads++; entered.resolve(); await blocked.promise; return { data: f.pr }; };
  const input = f.snapshot();
  try {
    const first = await f.post(input);
    assert.equal(first.status, 202); assert.equal(first.body.durable, true); assert.equal(first.body.admission_pending, true);
    assert.equal(first.body.acceptance, "accepted"); assert.equal(reads, 0);
    assert.equal(f.read().ciReceipts[input.request_id].pendingAdmission.kind, "new");
    work = f.ci.watchdog(); await wait(entered.promise);
    const replay = await f.post(input);
    assert.equal(replay.status, 202); assert.equal(replay.body.task_id, first.body.task_id);
    const fresh = await f.post(f.snapshot({ head_sha: "c".repeat(40) }));
    assert.equal(fresh.status, 202); assert.equal(fresh.body.admission_pending, true);
    assert.equal(reads, 1); assert.equal(f.read().jobs.length, 0);
  } finally { blocked.resolve(); await work; }
});

for (const route of ["direct", "agent"]) {
  for (const native of [false, true]) {
    test(`CI ${route} ACK respects target branches with native stack = ${native}`, async t => {
      const f = await fixture(t);
      f.pr.base.ref = "feature/parent"; f.pr.body = "Stacked on #9";
      if (native) f.pr.stack = { id: 2891204, base: { ref: "main" }, position: 2, size: 2 };
      f.ci.config.agentReady = true;
      let agents = 0;
      f.ci.agentDispatch = async (_service, event) => {
        agents++;
        const r = f.ci.receipts[event.ciRequestId];
        return f.ci.submitReview({ ...r, request_id: `github:${r.request_id}` }, { id: "org-ci-dispatcher" });
      };
      const input = { ...f.snapshot(), route };
      const ack = await f.post(input);
      assert.equal(ack.status, 202); assert.equal(ack.body.durable, true);
      assert.equal(f.calls.length, 0); assert.equal(f.statuses.length, 0);
      const receipt = f.ci.receipts[input.request_id];
      await f.ci.dispatch(receipt); await f.ci.watchdog();
      assert.equal(f.read().jobs.length, native ? 1 : 0);
      assert.equal(agents, native && route === "agent" ? 1 : 0);
      if (native) {
        assert.equal(f.read().jobs[0].baseRef, "feature/parent");
        assert.equal(receipt.state, "queued");
      } else {
        assert.equal(receipt.state, "skipped"); assert.equal(receipt.reason, "target_branch_not_allowed");
        assert.equal(f.ci.view(receipt).outcome, "skipped");
        assert.equal(f.statuses.at(-1).state, "success");
        assert.match(f.statuses.at(-1).description, /skipped/);
      }
    });
  }
}
test("a branch skip can join a native stack and later resume the same cancelled job", async t => {
  const f = await fixture(t); f.pr.base.ref = "feature/parent";
  const input = f.snapshot(); await f.post(input);
  const r = f.ci.receipts[input.request_id]; await f.ci.dispatch(r);
  assert.equal(r.state, "skipped");
  f.pr.stack = { id: 2891204, base: { ref: "main" } };
  assert.equal((await f.post(input)).body.admission_pending, true);
  await f.ci.dispatch(r);
  const job = f.service.state.data.jobs[0]; assert.equal(job.state, "queued");
  delete f.pr.stack;
  await f.ci.publishJobStatus(job, "success", "old result"); await f.ci.watchdog();
  assert.equal(r.state, "skipped"); assert.equal(job.state, "cancelled");
  assert.equal(f.statuses.at(-1).state, "success");
  assert.match(f.statuses.at(-1).description, /skipped/);
  f.pr.stack = { id: 2891204, base: { ref: "main" } };
  await f.post(input); await f.ci.dispatch(r);
  assert.equal(f.service.state.data.jobs.length, 1); assert.equal(job.state, "queued");
  assert.equal(r.jobId, job.id); assert.equal(r.reopenHistory.length, 2);
});
test("watchdog skips a CI job whose native stack now targets an excluded branch", async t => {
  const f = await fixture(t); f.pr.base.ref = "feature/parent";
  f.pr.stack = { id: 2891204, base: { ref: "main" } };
  const input = f.snapshot(); await f.post(input);
  const r = f.ci.receipts[input.request_id]; await f.ci.dispatch(r);
  f.pr.stack.base.ref = "release";
  await f.ci.watchdog();
  assert.equal(r.reason, "target_branch_not_allowed");
  assert.equal(f.service.state.data.jobs[0].state, "cancelled");
  assert.equal(f.statuses.at(-1).state, "success");
});
test("legacy receipt repair cannot restore a review verdict for an excluded stack", async t => {
  const f = await fixture(t); f.pr.base.ref = "feature/parent";
  f.pr.stack = { id: 2891204, base: { ref: "main" } };
  const input = f.snapshot(); await f.post(input);
  const r = f.ci.receipts[input.request_id]; await f.ci.dispatch(r);
  const job = f.service.state.data.jobs[0];
  job.state = "complete"; job.progress = { complete: true }; job.result = { blocking: 1 };
  r.state = "failed"; r.reason = "n8n_tracking_stalled"; r.finalStatus = "failure";
  delete f.pr.stack;
  await f.ci.watchdog();
  assert.equal(r.reconciliation.result, "skipped");
  assert.equal(r.reason, "target_branch_not_allowed");
  assert.equal(f.statuses.at(-1).state, "success");
  assert.match(f.statuses.at(-1).description, /skipped/);
});
test("a verified branch skip owns status over the previous target on the same head", async t => {
  const f = await fixture(t), old = f.snapshot();
  await f.post(old); await f.ci.dispatch(f.ci.receipts[old.request_id]);
  f.pr.base.ref = "feature/parent";
  const input = f.snapshot(); await f.post(input);
  const r = f.ci.receipts[input.request_id]; await f.ci.dispatch(r); await f.ci.watchdog();
  assert.equal(r.admissionVerified, true); assert.equal(r.reason, "target_branch_not_allowed");
  assert.equal(f.service.state.data.jobs.length, 1);
  assert.equal(f.service.state.data.jobs[0].state, "cancelled");
  assert.equal(f.statuses.at(-1).state, "success");
  assert.match(f.statuses.at(-1).description, /skipped/);
  const writes = f.statuses.length;
  await f.ci.publish(f.ci.receipts[old.request_id], "failure", "stale target");
  assert.equal(f.statuses.length, writes);
});
for (const change of ["closed", "head", "access"]) {
  test(`failed re-verification of a branch skip cannot retain success: ${change}`, async t => {
    const f = await fixture(t); f.pr.base.ref = "feature/parent";
    const input = f.snapshot(); await f.post(input);
    const r = f.ci.receipts[input.request_id]; await f.ci.dispatch(r); await f.ci.watchdog();
    r.finalStatus = "success";
    await f.post(input);
    if (change === "closed") f.pr.state = "closed";
    else if (change === "head") f.pr.head.sha = "c".repeat(40);
    else f.github.rest.pulls.get = async () => { throw Object.assign(Error("forbidden"), { status: 403 }); };
    await f.ci.watchdog();
    assert.equal(r.state, change === "access" ? "failed" : "superseded");
    assert.equal(f.statuses.at(-1).state, "failure");
    assert.equal(f.service.state.data.jobs.length, 0);
  });
}
for (const change of ["model", "executor"]) {
  test(`joining a stack cannot reuse incompatible completed work: ${change}`, async t => {
    const f = await fixture(t); f.pr.base.ref = "feature/parent";
    f.pr.stack = { id: 2891204, base: { ref: "main" } };
    const input = f.snapshot(); await f.post(input);
    const r = f.ci.receipts[input.request_id]; await f.ci.dispatch(r);
    const job = f.service.state.data.jobs[0];
    job.state = "complete"; job.progress = { complete: true }; job.result = { blocking: 0 };
    delete f.pr.stack; await f.ci.watchdog(); assert.equal(r.state, "skipped");
    if (change === "model") f.service.config.model = "changed-model";
    else fs.appendFileSync(f.service.config.binary, "new-executor");
    f.pr.stack = { id: 2891204, base: { ref: "main" } };
    await f.post(input); await f.ci.watchdog();
    assert.equal(r.state, "failed"); assert.equal(r.lastAdmission.lastError.code, "REOPEN_UNAVAILABLE");
    assert.equal(f.statuses.at(-1).state, "failure");
    assert.equal(f.service.state.data.jobs.length, 1); assert.equal(job.state, "complete");
  });
}

test("CI HTTP ingress rejects bad credentials, coordinates and failed commits without upstream calls", async t => {
  const f = await fixture(t), input = f.snapshot();
  assert.equal((await f.post(input, { "x-ocr-ci-token": "Bearer wrong" })).status, 401);
  assert.equal((await f.post(input, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await f.post({ ...input, request_id: "ocr-ci-wrong" })).status, 409);
  assert.equal((await f.post({ ...input, retry_key: "invalid" })).status, 400);
  assert.equal(Object.keys(f.read().ciReceipts || {}).length, 0); assert.equal(f.calls.length, 0);
  f.service.state.database.db.exec("CREATE TRIGGER reject_ci BEFORE INSERT ON state_changes BEGIN SELECT RAISE(ABORT,'commit failed'); END");
  await assert.rejects(f.ci.submit(input, "direct"), error => error.persistence && /commit failed/.test(error.message));
  assert.equal(Object.keys(f.read().ciReceipts || {}).length, 0); assert.equal(f.calls.length, 0);
});

test("explicit retry ACK remains available while snapshot verification blocks and replays cannot reset it twice", { timeout: 6000 }, async t => {
  const f = await fixture(t), input = f.snapshot(), blocked = deferred(), entered = deferred(); let work;
  await f.post(input); const receipt = f.ci.receipts[input.request_id];
  f.ci.stop(receipt, "failed", "dispatch_retries_exhausted");
  f.github.rest.pulls.get = async () => { entered.resolve(); await blocked.promise; return { data: f.pr }; };
  try {
    const ack = await f.post({ ...input, retry_key: "123:2" });
    assert.equal(ack.status, 202); assert.equal(ack.body.admission_pending, true);
    assert.equal(f.read().ciReceipts[input.request_id].pendingAdmission.kind, "retry");
    work = f.ci.watchdog(); await wait(entered.promise);
    const replay = await f.post({ ...input, retry_key: "123:2" });
    assert.equal(replay.status, 202); assert.equal(replay.body.task_id, ack.body.task_id);
  } finally { blocked.resolve(); await work; }
  assert.equal(receipt.state, "accepted"); assert.equal(receipt.retryHistory.length, 1);
  f.ci.stop(receipt, "failed", "dispatch_retries_exhausted");
  await f.post({ ...input, retry_key: "123:2" }); assert.equal(receipt.pendingAdmission, undefined);
});

test("reopen ACK survives restart and resumes the original cancelled job without losing its session", { timeout: 6000 }, async t => {
  const f = await fixture(t), input = f.snapshot();
  await f.post(input); await f.ci.dispatch(f.ci.receipts[input.request_id]);
  const job = f.service.state.data.jobs[0]; job.snapshot = { fingerprint: "retained" }; job.progress = { sessionId: "existing-session" };
  f.pr.state = "closed"; await f.ci.refresh(f.ci.receipts[input.request_id]);
  assert.equal(job.state, "cancelled"); f.pr.state = "open";
  const blocked = deferred(), entered = deferred(); let work, reads = 0;
  f.github.rest.pulls.get = async () => { reads++; entered.resolve(); await blocked.promise; return { data: f.pr }; };
  const ack = await f.post(input); assert.equal(ack.status, 202); assert.equal(reads, 0);
  assert.equal(f.read().ciReceipts[input.request_id].pendingAdmission.kind, "reopen");
  f.service.state.database.close(); f.service.state = new State(f.directory); f.service.orgCI = new OrgCI(f.service);
  const ci = f.service.orgCI, receipt = ci.receipts[input.request_id];
  try {
    work = ci.watchdog(); await wait(entered.promise);
    assert.equal((await f.post(input)).body.admission_pending, true);
    assert.equal(f.service.state.data.jobs[0].state, "cancelled");
  } finally { blocked.resolve(); await work; }
  await ci.dispatch(receipt);
  const saved = f.read(); assert.equal(saved.jobs.length, 1); assert.equal(saved.jobs[0].id, job.id);
  assert.equal(saved.jobs[0].state, "queued"); assert.equal(saved.jobs[0].progress.sessionId, "existing-session");
  assert.deepEqual(saved.jobs[0].snapshot, { fingerprint: "retained" }); assert.equal(receipt.reopenHistory.length, 1);
});

test("unverified and rejected target changes cannot cancel a valid job or own its GitHub status", async t => {
  const f = await fixture(t), input = f.snapshot();
  await f.post(input); const valid = f.ci.receipts[input.request_id]; await f.ci.dispatch(valid); await f.ci.refresh(valid);
  const job = f.service.state.data.jobs[0], statuses = f.statuses.length;
  const stale = f.snapshot({ base_ref: "wrong-target" }); await f.post(stale);
  const rejected = f.ci.receipts[stale.request_id];
  assert.equal(valid.state, "queued"); assert.equal(job.state, "queued"); assert.equal(rejected.admissionVerified, false);
  await f.ci.dispatch(rejected); await f.ci.refresh(rejected);
  assert.equal(rejected.state, "superseded"); assert.equal(job.state, "queued"); assert.equal(f.statuses.length, statuses);
  job.state = "complete"; job.progress = { complete: true }; job.result = { findings: 0, blocking: 0 };
  await f.ci.refresh(valid); assert.equal(f.statuses.at(-1).state, "success"); assert.equal(f.service.state.data.jobs.length, 1);
});

test("a verified replacement supersedes older work and a late old lookup cannot undo it", { timeout: 6000 }, async t => {
  const f = await fixture(t), input = f.snapshot(), old = JSON.parse(JSON.stringify(f.pr));
  const blocked = deferred(), entered = deferred(); let work, first = true;
  await f.post(input); const receipt = f.ci.receipts[input.request_id];
  f.github.rest.pulls.get = async () => {
    if (first) { first = false; entered.resolve(); await blocked.promise; return { data: old }; }
    return { data: f.pr };
  };
  let replacement;
  try {
    work = f.ci.dispatch(receipt); await wait(entered.promise);
    f.pr.head.sha = "c".repeat(40); const next = f.snapshot(); await f.post(next); replacement = f.ci.receipts[next.request_id];
    await f.ci.dispatch(replacement);
    assert.equal(receipt.state, "superseded"); assert.equal(replacement.admissionVerified, true);
  } finally { blocked.resolve(); await work; }
  assert.equal(f.service.state.data.jobs.length, 1); assert.equal(f.service.state.data.jobs[0].head, f.pr.head.sha);
  assert.equal(replacement.state, "queued"); assert.equal(receipt.pendingAdmission, undefined);
});

test("late snapshot rejection cannot erase a newer retry intent on the same receipt", { timeout: 6000 }, async t => {
  const f = await fixture(t), input = f.snapshot(), blocked = deferred(), entered = deferred(); let work, first = true;
  await f.post(input); const receipt = f.ci.receipts[input.request_id]; await f.ci.refresh(receipt, false);
  const closed = JSON.parse(JSON.stringify(f.pr)); closed.state = "closed";
  f.github.rest.pulls.get = async () => {
    if (first) { first = false; entered.resolve(); await blocked.promise; return { data: closed }; }
    return { data: f.pr };
  };
  try {
    work = f.ci.watchdog(); await wait(entered.promise);
    f.ci.stop(receipt, "failed", "dispatch_retries_exhausted");
    const ack = await f.post({ ...input, retry_key: "321:2" });
    assert.equal(ack.status, 202); assert.equal(ack.body.admission_pending, true);
  } finally { blocked.resolve(); await work; }
  assert.equal(receipt.pendingAdmission.kind, "retry");
  await f.ci.dispatch(receipt); assert.equal(receipt.state, "queued"); assert.equal(f.service.state.data.jobs.length, 1);
});

test("verification retries persist their backoff and stop after eight attempts including restart", async t => {
  const f = await fixture(t), input = f.snapshot(); let attempts = 0;
  f.github.rest.pulls.get = async () => { attempts++; throw Object.assign(Error("GitHub unavailable"), { status: 503 }); };
  await f.post(input);
  for (let n = 1; n <= 8; n++) {
    const r = f.service.orgCI.receipts[input.request_id]; r.pendingAdmission.nextAt = 0;
    await f.service.orgCI.dispatch(r);
    const saved = f.read().ciReceipts[input.request_id]; assert.equal(attempts, n);
    if (n < 8) {
      assert.equal(saved.pendingAdmission.attempts, n); assert.ok(saved.pendingAdmission.nextAt > Date.now());
      if (n === 2) {
        f.service.state.database.close(); f.service.state = new State(f.directory); f.service.orgCI = new OrgCI(f.service);
        await f.service.orgCI.dispatch(f.service.orgCI.receipts[input.request_id]); assert.equal(attempts, n);
      }
    } else { assert.equal(saved.state, "failed"); assert.equal(saved.reason, "admission_retries_exhausted"); assert.equal(saved.lastAdmission.attempts, 8); }
  }
  await f.service.orgCI.dispatch(f.service.orgCI.receipts[input.request_id]); assert.equal(attempts, 8);
  assert.equal(f.read().jobs.length, 0);
  assert.equal(require("./pr-alerts.js").events(f.read())[0].reason, "admission_retries_exhausted");
});

test("rate limits retry, access denial fails, and expired admission stops without another lookup", async t => {
  for (const limited of [false, true]) {
    const f = await fixture(t), input = f.snapshot();
    f.github.rest.pulls.get = async () => { throw Object.assign(Error("GitHub denied"), { status: 403,
      ...(limited ? { response: { headers: { "retry-after": "60" } } } : {}) }); };
    await f.post(input); const r = f.ci.receipts[input.request_id]; await f.ci.dispatch(r);
    if (limited) assert.ok(r.pendingAdmission.nextAt >= Date.now() + 59000);
    else { assert.equal(r.reason, "repository_access_failed"); assert.equal(r.state, "failed"); }
  }
  const f = await fixture(t), input = f.snapshot(); await f.post(input);
  const r = f.ci.receipts[input.request_id]; r.createdAt -= 7201000; r.pendingAdmission.nextAt = Date.now() + 86400000;
  await f.ci.watchdog(); assert.equal(r.reason, "admission_deadline_exceeded"); assert.equal(f.calls.length, 0);
});

test("restart after the eighth started attempt cannot perform a ninth verification", async t => {
  const f = await fixture(t), input = f.snapshot(); await f.post(input);
  f.ci.receipts[input.request_id].pendingAdmission.attempts = 8; f.service.state.save();
  f.service.state.database.close(); f.service.state = new State(f.directory); f.service.orgCI = new OrgCI(f.service);
  const r = f.service.orgCI.receipts[input.request_id]; await f.service.orgCI.dispatch(r);
  assert.equal(r.reason, "admission_retries_exhausted"); assert.equal(f.calls.length, 0);
  assert.equal(r.lastAdmission.attempts, 8);
});

test("reopen commits its verification result and runnable job together", async t => {
  const f = await fixture(t), input = f.snapshot(); await f.post(input);
  const r = f.ci.receipts[input.request_id]; await f.ci.dispatch(r);
  f.pr.state = "closed"; await f.ci.refresh(r); f.pr.state = "open"; await f.post(input);
  const original = f.service.state.save.bind(f.service.state); let runnable = 0;
  f.service.state.save = () => {
    original(); const saved = f.read(), job = saved.jobs[0], receipt = saved.ciReceipts[input.request_id];
    if (job.state === "queued") {
      runnable++; assert.equal(receipt.pendingAdmission, undefined); assert.equal(receipt.admissionVerified, true);
    }
  };
  await f.ci.refresh(r); assert.ok(runnable > 0); assert.equal(f.read().jobs.length, 1);
});

test("Agent callbacks cannot submit work before verification or across a newer admission generation", { timeout: 6000 }, async t => {
  const f = await fixture(t), input = f.snapshot(); await f.post(input);
  const args = { ...input, request_id: "github:" + input.request_id }, actor = { id: "org-ci-dispatcher" };
  await assert.rejects(f.ci.submitReview(args, actor), /awaiting verification/);
  const r = f.ci.receipts[input.request_id]; await f.ci.refresh(r, false);
  const blocked = deferred(), entered = deferred(); let first = true, result;
  f.github.rest.pulls.get = async () => {
    if (first) { first = false; entered.resolve(); await blocked.promise; }
    return { data: f.pr };
  };
  try {
    result = f.ci.submitReview(args, actor).then(value => ({ value }), error => ({ error })); await wait(entered.promise);
    f.ci.stop(r, "failed", "dispatch_retries_exhausted"); await f.post({ ...input, retry_key: "456:2" });
  } finally { blocked.resolve(); }
  assert.match((await result).error.message, /admission changed/); assert.equal(f.read().jobs.length, 0);
  await f.ci.dispatch(r); assert.equal(f.read().jobs.length, 1);
});

test("a late status response cannot mark a newer pending retry as published", { timeout: 6000 }, async t => {
  const f = await fixture(t), input = f.snapshot(); await f.post(input);
  const r = f.ci.receipts[input.request_id]; f.ci.stop(r, "failed", "dispatch_retries_exhausted");
  const blocked = deferred(), entered = deferred(); let work;
  f.github.rest.repos.createCommitStatus = async value => { entered.resolve(); await blocked.promise; f.statuses.push(value); };
  try {
    work = f.ci.watchdog(); await wait(entered.promise);
    const response = await f.post({ ...input, retry_key: "789:2" });
    assert.equal(response.status, 202); assert.equal(response.body.status_published, false);
    assert.equal(response.body.admission_pending, true);
  } finally { blocked.resolve(); await work; }
  assert.equal(r.published, undefined); assert.equal(r.pendingAdmission.kind, "retry");
  await f.ci.dispatch(r); await f.ci.refresh(r); assert.equal(f.statuses.at(-1).state, "pending");
});

test("failed reopen verification can be explicitly retried with the same native session", async t => {
  const f = await fixture(t), input = f.snapshot(); await f.post(input);
  const r = f.ci.receipts[input.request_id]; await f.ci.dispatch(r);
  const job = f.service.state.data.jobs[0]; job.snapshot = { fingerprint:"retained" }; job.progress = { sessionId:"resume-original" };
  f.pr.state="closed";await f.ci.refresh(r);f.pr.state="open";await f.post(input);
  f.github.rest.pulls.get=async()=>{throw Object.assign(Error("unavailable"),{status:503});};
  for(let n=0;n<8;n++){r.pendingAdmission.nextAt=0;await f.ci.dispatch(r);}
  assert.equal(r.state,"failed");assert.equal(r.lastAdmission.kind,"reopen");assert.equal(job.state,"cancelled");
  f.github.rest.pulls.get=async()=>({data:f.pr});
  const retry=await f.post({...input,retry_key:"901:2"});assert.equal(retry.status,202);assert.equal(retry.body.admission_pending,true);
  assert.equal(r.pendingAdmission.kind,"reopen");await f.ci.dispatch(r);
  assert.equal(job.state,"queued");assert.equal(job.progress.sessionId,"resume-original");
  assert.equal(f.read().jobs.length,1);assert.equal(r.jobId,job.id);assert.equal(r.reopenHistory[0].previousState,"failed");
});

test("newer pending or rejected unverified receipts cannot prevent a valid reopen", async t => {
  for(const rejected of [false,true]) {
    const f=await fixture(t),input=f.snapshot();await f.post(input);
    const r=f.ci.receipts[input.request_id];await f.ci.dispatch(r);
    f.pr.state="closed";await f.ci.refresh(r);f.pr.state="open";
    const invalid=f.snapshot({base_ref:"wrong"});await f.post(invalid);
    const newer=f.ci.receipts[invalid.request_id];
    if(rejected)await f.ci.dispatch(newer);
    assert.equal(newer.admissionVerified,false);
    assert.equal((await f.post(input)).body.admission_pending,true);await f.ci.dispatch(r);
    assert.equal(r.state,"queued");assert.equal(r.admissionVerified,true);assert.equal(r.reopenHistory.length,1);
    assert.equal(f.read().jobs.length,1);assert.equal(f.read().jobs[0].state,"queued");
  }
});

test("a delayed reopen keeps ingress ordering and cannot supersede a later pending snapshot", {timeout:6000},async t=>{
  const f=await fixture(t),input=f.snapshot();await f.post(input);
  const r=f.ci.receipts[input.request_id];await f.ci.dispatch(r);
  f.pr.state="closed";await f.ci.refresh(r);f.pr.state="open";await f.post(input);
  const sequence=r.pendingAdmission.sequence,old=JSON.parse(JSON.stringify(f.pr)),entered=deferred(),blocked=deferred();let first=true,work,newer;
  f.github.rest.pulls.get=async()=>{
    if(first){first=false;entered.resolve();await blocked.promise;return {data:old};}
    return {data:f.pr};
  };
  try{
    work=f.ci.dispatch(r);await wait(entered.promise);
    f.pr.head.sha="c".repeat(40);const next=f.snapshot();await f.post(next);newer=f.ci.receipts[next.request_id];
    assert.ok(newer.sequence>sequence);
  }finally{blocked.resolve();await work;}
  assert.equal(r.sequence,sequence);assert.ok(newer.pendingAdmission);assert.equal(newer.state,"accepted");
  await f.ci.dispatch(newer);assert.equal(newer.state,"queued");assert.equal(r.state,"superseded");
  assert.equal(f.read().jobs.length,2);assert.equal(f.read().jobs.at(-1).head,f.pr.head.sha);
});

test("rejected CI verification cannot overwrite a native job or Webhook-only status owner",async t=>{
  for(const owner of ["job","delivery"]) {
    const f=await fixture(t);
    if(owner==="job") {
      const job=f.service.state.enqueue("lexmount/example",f.pr,{force:true});job.state="complete";
      job.progress={complete:true};job.result={findings:0,blocking:0};f.service.state.save();
    } else {
      f.service.state.data.deliveries=[{id:"app-owner",repository:"lexmount/example",head:f.pr.head.sha,admitted:true,state:"pending"}];f.service.state.save();
    }
    await f.service.writeCommitStatus("lexmount/example",f.pr.head.sha,owner==="job"?"success":"pending","existing owner");
    const before=f.statuses.length,input=f.snapshot({base_ref:"wrong-target"});await f.post(input);
    const r=f.ci.receipts[input.request_id];await f.ci.dispatch(r);await f.ci.refresh(r);
    assert.equal(r.state,"superseded");assert.equal(r.published.suppressed,true);assert.equal(f.statuses.length,before);
  }
});
