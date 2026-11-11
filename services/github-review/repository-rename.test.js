// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { ReviewService, configuration } = require("./service.js");
const { State } = require("./state.js");
const { createGitHub } = require("./github.js");
const { OrgCI } = require("./org-ci.js");
const { GitHubEvents } = require("./events.js");
const { Infrastructure } = require("./infrastructure.js");
const { AdmissionReconciliation, snapshot } = require("./admission-reconciliation.js");
const { sameRepository, sameSnapshot } = require("./repositories.js");
const previous = "lexmount/previous", current = "lexmount/current";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-rename-")), secret = path.join(dir, "secret");
  fs.writeFileSync(secret, "fixture-secret");
  const actor = { id: "dispatcher", role: "dispatcher", repositories: [previous], tokenFile: secret };
  const pr = { number: 1, state: "open", draft: false, head: { sha: "a".repeat(40) },
    base: { sha: "b".repeat(40), ref: "main", repo: { full_name: current } } };
  const calls = [], logs = [], clock = { now: 1000000 };
  const github = createGitHub({ token: "fixture-token", fetchImpl: async (url, options) => {
    calls.push({ url, ...options }); assert.equal(options.redirect, "error");
    const u = new URL(url); assert.ok(u.pathname.startsWith("/repos/" + current + "/"), url);
    let value;
    if (u.pathname.endsWith("/pulls/1")) value = pr;
    else if (u.pathname.endsWith("/pulls")) value = [pr];
    else if (u.pathname.includes("/statuses/")) value = {};
    else throw Error("Unexpected fixture request: " + url);
    return new Response(JSON.stringify(value), { status: 200 });
  } });
  const config = { stateDirectory: dir, binary: __filename, stateStorage: "sqlite",
    repositories: [{ name: previous, githubName: current, baseBranches: ["main"], agentFallback: true }],
    infrastructure: { enabled: true, externalDispatch: true, dispatchEnabled: true, clients: [actor],
      githubWebhookSecretFile: secret, orgCI: { enabled: true } },
    admissionReconciliation: { enabled: true, mode: "repair" } };
  const s = new ReviewService({ config, github, log: line => logs.push(JSON.parse(line)) });
  s.orgCI = new OrgCI(s); s.githubEvents = new GitHubEvents(s);
  const scan = new AdmissionReconciliation(s, () => clock.now);
  const envelope = (repository = current, id = "renamed-event") => {
    const raw = JSON.stringify({ action: "synchronize", repository: { full_name: repository }, pull_request: pr });
    return { event: "pull_request", delivery_id: id, route: "direct", raw_body: Buffer.from(raw).toString("base64"),
      signature: "sha256=" + crypto.createHmac("sha256", "fixture-secret").update(raw).digest("hex") };
  };
  t.after(() => { s.state.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { s, config, pr, calls, logs, actor, envelope, scan, clock, advance: () => { clock.now += 901000; } };
}

test("GitHub rename aliases are explicit, same-owner, case-insensitive and collision-free", t => {
  const { s, config, pr } = fixture(t);
  assert.equal(s.repo(current), s.repo(previous));
  assert.equal(s.repo(current.toUpperCase()), s.repo(previous));
  assert.equal(s.repo("lexmount/unconfigured"), null);
  assert.deepEqual(s.coordinates(previous), { owner: "lexmount", repo: "current" });
  assert.equal(s.eligible(previous, pr), true);
  assert.equal(s.eligible(previous, { ...pr, base: { ...pr.base, repo: { full_name: "lexmount/unconfigured" } } }), false);
  for (const githubName of [null, [], 1, "other/current", "https://evil.test", "lexmount/"]) {
    assert.throws(() => configuration({ ...config, repositories: [{ ...config.repositories[0], githubName }] }), /githubName/);
  }
  for (const name of [previous, current, current.toUpperCase()]) {
    assert.throws(() => configuration({ ...config, repositories: [...config.repositories, { name, baseBranches: ["main"] }] }), /unique/);
  }
  assert.throws(() => configuration({ ...config, gitea: {} }), /githubName/);
  assert.equal(sameRepository(s, previous, current), true);
  assert.equal(sameRepository(s, previous, "other/current"), false);
  assert.equal(sameSnapshot(s, { repository: previous }, { repository: current }), false);
});

test("signed renamed Webhook keeps durable ACK and shares the retained job with CI", async t => {
  const { s, pr, calls, actor, envelope } = fixture(t);
  const ack = await s.githubEvents.accept(envelope(), actor);
  assert.equal(ack.accepted, true); assert.equal(calls.length, 0);
  await s.githubEvents.tick();
  assert.equal(s.state.data.jobs.length, 1);
  const job = s.state.data.jobs[0]; assert.equal(job.repository, previous);
  const p = snapshot(current, pr), ciAck = await s.orgCI.submit(p, "direct");
  assert.equal(ciAck.repository, current); assert.equal(ciAck.request_id, p.request_id); assert.equal(ciAck.durable, true);
  await s.orgCI.dispatch(s.orgCI.receipts[p.request_id]);
  assert.equal(s.orgCI.receipts[p.request_id].jobId, job.id);
  assert.equal(s.state.data.jobs.length, 1);
  assert.equal(s.state.data.deliveries[0].repository, previous);
  await s.githubEvents.accept(envelope(), actor);
  assert.equal(s.state.data.deliveries.length, 1);
});

test("renamed CI receipt reuses a running session and suppresses old-name status writes", async t => {
  const { s, pr, calls } = fixture(t), old = snapshot(previous, pr);
  await s.orgCI.submit(old, "direct"); await s.orgCI.dispatch(s.orgCI.receipts[old.request_id]);
  const job = s.state.data.jobs[0]; job.state = "running"; job.attempt = 1;
  job.progress = { sessionId: "retained-session", complete: false }; s.state.save();
  const p = snapshot(current, pr); await s.orgCI.submit(p, "direct");
  await s.orgCI.dispatch(s.orgCI.receipts[p.request_id]);
  assert.equal(s.state.data.jobs.length, 1); assert.equal(job.state, "running");
  assert.equal(job.progress.sessionId, "retained-session"); assert.equal(job.attempt, 1);
  assert.equal(s.orgCI.receipts[p.request_id].jobId, job.id);
  const before = calls.filter(c => c.method === "POST").length;
  await s.orgCI.publish(s.orgCI.receipts[old.request_id], "success", "outdated owner");
  assert.equal(calls.filter(c => c.method === "POST").length, before);
  assert.equal(s.orgCI.receipts[old.request_id].published.suppressed, true);
});

test("renaming does not reuse an old review when the PR target changes", async t => {
  const { s, pr } = fixture(t), old = snapshot(previous, pr);
  await s.orgCI.submit(old, "direct"); await s.orgCI.dispatch(s.orgCI.receipts[old.request_id]);
  const oldJob = s.state.data.jobs[0]; pr.base.ref = "release/new-target";
  const p = snapshot(current, pr); await s.orgCI.submit(p, "direct");
  await s.orgCI.dispatch(s.orgCI.receipts[p.request_id]);
  assert.equal(oldJob.state, "cancelled"); assert.equal(s.state.data.jobs.length, 2);
  assert.notEqual(s.orgCI.receipts[p.request_id].jobId, oldJob.id);
  assert.equal(s.orgCI.receipts[old.request_id].reason, "new_snapshot");
});

test("a retired alias receipt cannot expire or cancel the new owner's running session", async t => {
  const { s, pr } = fixture(t), old = snapshot(previous, pr);
  await s.orgCI.submit(old, "direct"); await s.orgCI.dispatch(s.orgCI.receipts[old.request_id]);
  const job = s.state.data.jobs[0]; job.state = "running";
  const controller = new AbortController(); s.workers.set(0, { job, controller });
  const oldReceipt = s.orgCI.receipts[old.request_id]; oldReceipt.createdAt = Date.now() - 7300000;
  const p = snapshot(current, pr); await s.orgCI.submit(p, "direct");
  await s.orgCI.dispatch(s.orgCI.receipts[p.request_id]);
  assert.equal(oldReceipt.successorReceipt, p.request_id);
  assert.equal(oldReceipt.state, "superseded");
  await s.orgCI.refresh(oldReceipt);
  s.orgCI.stop(oldReceipt, "failed", "review_deadline_exceeded");
  assert.equal(oldReceipt.state, "superseded"); assert.equal(job.state, "running");
  assert.equal(controller.signal.aborted, false);
  assert.equal(job.ciRequestId, p.request_id);
});

test("cross-alias reopen waits for shutdown and resumes the retained job", async t => {
  const { s, pr } = fixture(t), old = snapshot(previous, pr);
  await s.orgCI.submit(old, "direct"); await s.orgCI.dispatch(s.orgCI.receipts[old.request_id]);
  const job = s.state.data.jobs[0]; job.state = "running";
  job.progress = { sessionId: "saved-native-session", complete: false };
  const controller = new AbortController(); s.workers.set(0, { job, controller });
  pr.state = "closed"; await s.orgCI.refresh(s.orgCI.receipts[old.request_id]);
  assert.equal(job.state, "cancelled"); assert.equal(controller.signal.aborted, true);
  pr.state = "open";
  const p = snapshot(current, pr); await s.orgCI.submit(p, "direct");
  const receipt = s.orgCI.receipts[p.request_id];
  assert.equal(receipt.pendingAdmission.kind, "reopen");
  await s.orgCI.dispatch(receipt);
  assert.ok(receipt.pendingAdmission.nextAt > Date.now()); assert.equal(job.state, "cancelled");
  s.workers.clear(); receipt.pendingAdmission.nextAt = 0;
  await s.orgCI.dispatch(receipt);
  assert.equal(receipt.pendingAdmission, undefined); assert.equal(s.state.data.jobs.length, 1);
  assert.equal(receipt.jobId, job.id); assert.equal(job.state, "queued");
  assert.equal(job.progress.sessionId, "saved-native-session"); assert.equal(job.ciRequestId, p.request_id);
});

test("scanner follows transferred ownership and reopens the same session through the retained name", async t => {
  const { s, pr, scan, advance } = fixture(t), old = snapshot(previous, pr), p = snapshot(current, pr);
  await s.orgCI.submit(old, "direct"); await s.orgCI.dispatch(s.orgCI.receipts[old.request_id]);
  const job = s.state.data.jobs[0]; job.progress = { sessionId: "saved-native-session", complete: false };
  await s.orgCI.submit(p, "direct"); await s.orgCI.dispatch(s.orgCI.receipts[p.request_id]);
  pr.state = "closed"; await s.orgCI.refresh(s.orgCI.receipts[p.request_id]);
  assert.equal(job.state, "cancelled"); assert.equal(scan.owner(old), null);
  pr.state = "open"; await scan.tick(); advance(); assert.equal((await scan.tick()).admitted, 1);
  const receipt = s.orgCI.receipts[old.request_id]; assert.equal(receipt.pendingAdmission.kind, "reopen");
  await s.orgCI.dispatch(receipt);
  assert.equal(job.state, "queued"); assert.equal(job.ciRequestId, old.request_id);
  assert.equal(job.progress.sessionId, "saved-native-session"); assert.equal(s.state.data.jobs.length, 1);
  assert.equal(scan.owner(old), "receipt"); assert.equal(s.orgCI.receipts[p.request_id].successorReceipt, old.request_id);
});

test("cross-alias reopen cannot resume a session after review policy changes", async t => {
  const { s, pr } = fixture(t), old = snapshot(previous, pr);
  await s.orgCI.submit(old, "direct"); await s.orgCI.dispatch(s.orgCI.receipts[old.request_id]);
  const job = s.state.data.jobs[0];
  pr.state = "closed"; await s.orgCI.refresh(s.orgCI.receipts[old.request_id]); pr.state = "open";
  job.settings.policySignature = "incompatible";
  const p = snapshot(current, pr); await s.orgCI.submit(p, "direct");
  await s.orgCI.dispatch(s.orgCI.receipts[p.request_id]);
  assert.equal(s.orgCI.receipts[p.request_id].state, "failed");
  assert.equal(job.state, "cancelled"); assert.equal(s.state.data.jobs.length, 1);
});

for (const first of [previous, current]) test("pending reopens share a session when verification starts with " + first, async t => {
  const { s, pr, scan } = fixture(t), old = snapshot(previous, pr), p = snapshot(current, pr);
  await s.orgCI.submit(old, "direct"); await s.orgCI.dispatch(s.orgCI.receipts[old.request_id]);
  const job = s.state.data.jobs[0]; job.state = "running";
  job.progress = { sessionId: "retained-session", complete: false };
  const closing = new AbortController(); s.workers.set(0, { job, controller: closing });
  pr.state = "closed"; await s.orgCI.refresh(s.orgCI.receipts[old.request_id]); pr.state = "open";
  await s.orgCI.submit(old, "direct"); await s.orgCI.dispatch(s.orgCI.receipts[old.request_id]);
  const oldReceipt = s.orgCI.receipts[old.request_id], oldGeneration = oldReceipt.admissionGeneration;
  assert.equal(oldReceipt.pendingAdmission.kind, "reopen");
  await s.orgCI.submit(p, "direct"); const newReceipt = s.orgCI.receipts[p.request_id];
  assert.equal(newReceipt.pendingAdmission.kind, "reopen"); assert.equal(newReceipt.jobId, job.id);
  await s.orgCI.dispatch(newReceipt);
  assert.equal(s.state.data.jobs.length, 1); assert.equal(job.state, "cancelled");
  s.workers.clear();
  oldReceipt.pendingAdmission.nextAt = 0; newReceipt.pendingAdmission.nextAt = 0;
  const ordered = first === previous ? [oldReceipt, newReceipt] : [newReceipt, oldReceipt];
  await s.orgCI.dispatch(ordered[0]);
  const running = new AbortController(); job.state = "running"; s.workers.set(0, { job, controller: running });
  await s.orgCI.dispatch(ordered[1]);
  assert.equal(s.state.data.jobs.length, 1); assert.equal(job.state, "running");
  assert.equal(job.progress.sessionId, "retained-session"); assert.equal(running.signal.aborted, false);
  assert.equal(oldReceipt.pendingAdmission, undefined); assert.equal(newReceipt.pendingAdmission, undefined);
  assert.equal(s.orgCI.view(oldReceipt).admission_pending, false);
  assert.ok(oldReceipt.admissionGeneration > oldGeneration);
  assert.equal(job.ciRequestId, p.request_id); assert.equal(scan.owner(old), "receipt");
  await s.orgCI.watchdog(); assert.equal(job.state, "running");
});

test("ownership transfer fences an older alias verification already waiting for GitHub", async t => {
  const { s, pr } = fixture(t), old = snapshot(previous, pr), p = snapshot(current, pr);
  await s.orgCI.submit(old, "direct"); await s.orgCI.dispatch(s.orgCI.receipts[old.request_id]);
  const job = s.state.data.jobs[0]; job.progress = { sessionId: "retained-session", complete: false };
  pr.state = "closed"; await s.orgCI.refresh(s.orgCI.receipts[old.request_id]); pr.state = "open";
  await s.orgCI.submit(old, "direct"); await s.orgCI.submit(p, "direct");
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const original = s.orgCI.current.bind(s.orgCI);
  s.orgCI.current = async receipt => {
    if (receipt.request_id === old.request_id) { entered(); await blocked; }
    return original(receipt);
  };
  const older = s.orgCI.dispatch(s.orgCI.receipts[old.request_id]);
  try { await started; await s.orgCI.dispatch(s.orgCI.receipts[p.request_id]); }
  finally { release(); await older; }
  assert.equal(s.orgCI.view(s.orgCI.receipts[old.request_id]).admission_pending, false);
  assert.equal(s.orgCI.verifyingAdmissions.size, 0); assert.equal(s.state.data.jobs.length, 1);
  assert.equal(job.ciRequestId, p.request_id); assert.equal(job.progress.sessionId, "retained-session");
  assert.equal(job.state, "queued");
});

test("scanner queries the new name while preserving the original baseline checkpoint", async t => {
  const { s, pr, scan, advance, config } = fixture(t);
  const old = snapshot(previous, pr); config.admissionReconciliation.initialBaseline = [old.request_id];
  const baselineScan = new AdmissionReconciliation(s, () => scan.now());
  await baselineScan.tick(); advance(); const summary = await baselineScan.tick();
  assert.equal(summary.errors, 0); assert.equal(summary.admitted, 0);
  assert.equal(s.state.data.admissionSnapshots[previous + "#1"].status, "baseline");
  assert.equal(Object.keys(s.orgCI.receipts).length, 0);
  const restart = new State(s.config.stateDirectory);
  assert.equal(restart.data.admissionSnapshots[previous + "#1"].request_id, old.request_id);
  restart.database.close();
});

test("scanner recognizes receipts under either name without replaying completed work", async t => {
  const { s, pr, scan, advance } = fixture(t);
  const p = snapshot(current, pr); await s.orgCI.submit(p, "direct");
  await s.orgCI.dispatch(s.orgCI.receipts[p.request_id]);
  const job = s.state.data.jobs[0]; job.state = "complete";
  job.progress = { complete: true }; job.result = { findings: 0, blocking: 0 };
  await scan.tick(); advance(); const summary = await scan.tick();
  assert.equal(summary.admitted, 0); assert.equal(summary.missing, 0); assert.equal(summary.errors, 0);
  assert.equal(s.state.data.jobs.length, 1); assert.equal(job.repository, previous);
  assert.equal(s.state.data.admissionSnapshots[previous + "#1"].owner, "receipt");
  pr.head.sha = "c".repeat(40); advance(); await scan.tick();
  advance(); assert.equal((await scan.tick()).admitted, 1);
  assert.equal(s.state.data.jobs.length, 1);
});

test("repository-not-enabled receipts cannot prevent recovery after a rename is enrolled", async t => {
  const { s, pr, scan, advance } = fixture(t), p = snapshot(current, pr);
  s.orgCI.receipts[p.request_id] = { ...p, state: "skipped", reason: "repository_not_enabled" };
  await scan.tick(); advance(); const summary = await scan.tick();
  assert.equal(summary.admitted, 1); assert.equal(summary.missing, 1);
  const receipt = Object.values(s.orgCI.receipts).find(r => r.repository === previous);
  assert.ok(receipt.pendingAdmission); assert.equal(s.state.data.jobs.length, 0);
});

test("an older skipped name does not hide an accepted receipt under the new name", async t => {
  const { s, pr, scan, advance } = fixture(t), old = snapshot(previous, pr), p = snapshot(current, pr);
  s.orgCI.receipts[old.request_id] = { ...old, state: "skipped", reason: "repository_not_enabled" };
  await s.orgCI.submit(p, "direct");
  await scan.tick(); advance(); const summary = await scan.tick();
  assert.equal(summary.admitted, 0); assert.equal(summary.missing, 0);
  assert.equal(s.state.data.admissionSnapshots[previous + "#1"].owner, "receipt");
});

test("alias preserves exact client scope without enrolling other repositories", async t => {
  const { s, actor, envelope } = fixture(t), api = new Infrastructure(s);
  assert.equal(api.authorize(current, actor).name, previous);
  assert.throws(() => api.authorize("lexmount/unconfigured", actor), /scope/);
  const unrelated = { ...actor, repositories: ["lexmount/unrelated"] };
  assert.throws(() => api.authorize(current, unrelated), /scope/);
  assert.throws(() => api.authorize(previous, unrelated), /scope/);
  await assert.rejects(s.githubEvents.accept(envelope("lexmount/unconfigured"), actor), /scope/);
  assert.equal((s.state.data.deliveries || []).length, 0);
});

test("monitor fetches the new GitHub name and retains history keys", async t => {
  const { config } = fixture(t), calls = [];
  config.token = "fixture-token";
  const result = await require("./monitor-data.js").githubPulls(config, async (_url, args) => {
    calls.push(JSON.parse(args.body));
    return new Response(JSON.stringify({ data: { repository: { pullRequests: {
      nodes: [{ number: 1 }], pageInfo: { hasNextPage: false } } }, rateLimit: { remaining: 99 } } }));
  });
  assert.equal(calls[0].variables.name, "current"); assert.equal(result.pulls[0].repository, previous);
});

test("old and new names serialize status writes for the same commit", async t => {
  const { s, pr } = fixture(t); let release, started;
  const blocked = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const writes = [];
  s.github.rest.repos.createCommitStatus = async args => {
    writes.push(args); if (writes.length === 1) { started(); await blocked; }
  };
  const first = s.writeCommitStatus(previous, pr.head.sha, "pending", "first");
  await entered;
  const second = s.writeCommitStatus(current, pr.head.sha, "success", "second");
  try {
    await new Promise(resolve => setImmediate(resolve)); assert.equal(writes.length, 1);
  } finally { release(); await Promise.all([first, second]); }
  assert.deepEqual(writes.map(w => w.repo), ["current", "current"]);
  assert.deepEqual(writes.map(w => w.state), ["pending", "success"]);
});

test("alias admission failures remain covered by the configured oncall policy", async t => {
  const { config } = fixture(t), directory = path.join(config.stateDirectory, "alerts");
  fs.mkdirSync(directory);
  const policy = path.join(directory, "policy.json"), webhookFile = path.join(directory, "hook");
  fs.writeFileSync(policy, JSON.stringify({ repositories: [{ name: previous.toUpperCase(), githubName: current.toUpperCase() }] }));
  fs.writeFileSync(webhookFile, "https://open.feishu.cn/open-apis/bot/v2/hook/1234-abcd");
  const { Alerts } = require("./pr-alerts.js"); let sends = 0;
  const alerts = new Alerts({ directory, webhookFile, repositoryPolicyFile: policy }, async () => {
    sends++; return { ok: true, json: async () => ({ code: 0 }) };
  });
  await alerts.collect({ jobs: [] }, 1);
  const failure = { id: 1, repository: current, number: 1, state: "failed", error: "execution_failed" };
  await alerts.collect({ jobs: [failure, { ...failure, id: 2, repository: "lexmount/unconfigured" }] }, 2);
  assert.equal(sends, 1); assert.equal(Object.keys(alerts.state.pending).length, 0);
});
