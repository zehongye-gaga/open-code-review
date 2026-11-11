// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { ReviewService, configuration } = require("./service.js");
const { State } = require("./state.js");
const { OrgCI } = require("./org-ci.js");
const { AdmissionReconciliation, snapshot } = require("./admission-reconciliation.js");
function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-reconcile-"));
  const state = new State(dir);
  t.after(() => { state.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const repository = "lexmount/example", logs = [], calls = [];
  const pr = { number: 1, state: "open", draft: true, head: { sha: "a".repeat(40) },
    base: { sha: "b".repeat(40), ref: "feature/stack", repo: { full_name: repository } } };
  const current = { pr, pulls: [pr], now: 1000000 };
  const github = { rest: { pulls: {
    list: async args => { calls.push(args); return { data: current.pulls }; },
    get: async () => ({ data: current.pr }),
  }, repos: { createCommitStatus: async () => {} } } };
  const config = { stateDirectory: dir, stateStorage: "sqlite", binary: __filename,
    repositories: [{ name: repository, baseBranches: ["main"], requiresAgent: true, agentFallback: true }],
    infrastructure: { enabled: true, externalDispatch: true, orgCI: { enabled: true, agentReady: true } },
    admissionReconciliation: { enabled: true, mode: "repair", ...extra } };
  const s = new ReviewService({ config, github, state, log: text => logs.push(JSON.parse(text)) });
  s.orgCI = new OrgCI(s);
  const scan = new AdmissionReconciliation(s, () => current.now);
  const advance = () => { current.now += 901000; };
  return { s, scan, current, pr, calls, logs, advance, config, dir };
}
test("disabled by default, bounded configuration, and no Gitea or implicit repository expansion", async t => {
  const { s, scan, config, calls } = fixture(t);
  delete s.config.admissionReconciliation;
  await scan.tick(); await s.poll(); assert.equal(calls.length, 0);
  for (const admissionReconciliation of [{ enabled: true, intervalSeconds: 30 }, { enabled: true, graceSeconds: 0 },
    { enabled: true, maxAdmissionsPerScan: 1000 }, { enabled: true, repositories: ["lexmount/unconfigured"] }]) {
    assert.throws(() => configuration({ ...config, admissionReconciliation }), /Reconciliation|reconciliation/);
  }
  assert.throws(() => configuration({ ...config, gitea: {} }), /GitHub/);
});
test("missing draft and stacked PR receives a durable normal Agent receipt after grace", async t => {
  const { s, scan, current, pr, calls, advance } = fixture(t);
  await scan.tick(); const p = snapshot("lexmount/example", pr);
  assert.equal(s.state.data.admissionSnapshots["lexmount/example#1"].status, "grace");
  assert.equal(Object.keys(s.orgCI.receipts).length, 0);
  current.now += 60000; await scan.tick(); assert.equal(calls.length, 1);
  advance(); const result = await scan.tick(); assert.equal(result.admitted, 1);
  const receipt = s.orgCI.receipts[p.request_id]; assert.equal(receipt.route, "agent");
  assert.equal(receipt.reconciliation.source, "scheduled_snapshot_scan");
  assert.equal(receipt.published, undefined);
  s.orgCI.agentDispatch = async () => s.orgCI.submitReview({ ...p, request_id: `github:${p.request_id}` }, { id: "org-ci-dispatcher" });
  await s.orgCI.dispatch(receipt); assert.equal(s.state.data.jobs.length, 1);
  await s.orgCI.submit(p, "agent"); advance(); await scan.tick();
  assert.equal(s.state.data.jobs.length, 1); assert.equal(Object.keys(s.orgCI.receipts).length, 1);
});
test("observe mode reports gaps without submitting or changing existing jobs", async t => {
  const { s, scan, advance } = fixture(t, { mode: "observe" });
  await scan.tick(); advance(); const result = await scan.tick();
  assert.equal(result.missing, 1); assert.equal(result.admitted, 0);
  assert.equal(s.state.data.admissionSnapshots["lexmount/example#1"].status, "missing");
  assert.equal(Object.keys(s.orgCI.receipts).length, 0); assert.equal(s.state.data.jobs.length, 0);
});
test("SQLite checkpoint survives restart and does not trigger an immediate rescan", async t => {
  const { s, scan, current, calls, advance, dir } = fixture(t);
  await scan.tick();
  const reopened = new (require("./state-sqlite.js").SQLiteState)(path.join(dir, "state.db"));
  const saved = reopened.load(); reopened.close();
  assert.equal(saved.admissionSnapshots["lexmount/example#1"].firstSeenAt, current.now);
  const restarted = new AdmissionReconciliation(s, () => current.now);
  await restarted.tick(); assert.equal(calls.length, 1);
  advance(); await restarted.tick(); assert.equal(Object.keys(s.orgCI.receipts).length, 1);
});
test("failed receipts and completed or failed reviews are owned, not automatically rerun", async t => {
  for (const kind of ["receipt", "complete", "failed", "delivery", "failed_delivery"]) {
    const { s, scan, pr, advance } = fixture(t);
    const p = snapshot("lexmount/example", pr);
    if (kind === "receipt") s.orgCI.receipts[p.request_id] = { ...p, state: "failed" };
    else if (["delivery", "failed_delivery"].includes(kind)) s.state.data.deliveries = [{ repository: p.repository, number: 1, head: p.head_sha, base: p.base_sha, state: kind === "delivery" ? "pending" : "failed", admitted: true, id: "delivery" }];
    else s.state.data.jobs.push({ id: 42, repository: p.repository, number: 1, head: p.head_sha, base: p.base_sha, baseRef: p.base_ref, state: kind });
    await scan.tick(); advance(); const result = await scan.tick();
    assert.equal(result.admitted, 0); assert.equal(result.missing, 0);
  }
});
test("head or target changes restart grace, and stale API snapshots cannot dispatch", async t => {
  const { s, scan, pr, current, advance } = fixture(t);
  await scan.tick(); advance(); pr.base.ref = "main"; await scan.tick();
  assert.equal(Object.keys(s.orgCI.receipts).length, 0);
  assert.equal(s.state.data.admissionSnapshots["lexmount/example#1"].firstSeenAt, current.now);
  advance(); current.pr = { ...pr, head: { sha: "c".repeat(40) } };
  await scan.tick(); assert.equal(Object.keys(s.orgCI.receipts).length, 0);
  assert.equal(s.state.data.admissionSnapshots["lexmount/example#1"].error, "PR_SNAPSHOT_CHANGED");
});
test("closed PRs disappear only after a successful complete list, not on API failure", async t => {
  const { s, scan, current, advance } = fixture(t);
  await scan.tick(); advance();
  const original = s.github.rest.pulls.list;
  s.github.rest.pulls.list = async () => { throw Error("network unavailable"); };
  await scan.tick(); assert.ok(s.state.data.admissionSnapshots["lexmount/example#1"]);
  s.github.rest.pulls.list = original; current.pulls = []; advance(); await scan.tick();
  assert.equal(Object.keys(s.state.data.admissionSnapshots).length, 0);
});
test("per-round cap bounds recovery while API rate limits delay the next round", async t => {
  const { s, scan, current, pr, calls, advance } = fixture(t, { maxAdmissionsPerScan: 1 });
  current.pulls.push({ ...pr, number: 2 });
  s.github.rest.pulls.get = async args => ({ data: current.pulls.find(p => p.number === args.pull_number) });
  await scan.tick(); advance(); assert.equal((await scan.tick()).admitted, 1);
  advance(); assert.equal((await scan.tick()).admitted, 1); assert.equal(Object.keys(s.orgCI.receipts).length, 2);
  advance(); s.github.rest.pulls.list = async () => { calls.push({}); throw Object.assign(Error("rate limited"), { status: 429, response: { headers: { "retry-after": "3600" } } }); };
  await scan.tick(); const n = calls.length;
  advance(); await scan.tick(); assert.equal(calls.length, n);
});
test("concurrent scans share one API traversal and persistence failures remain fatal", async t => {
  const { s, scan, pr, calls, advance } = fixture(t);
  let release;
  s.github.rest.pulls.list = async () => { calls.push({}); return new Promise(resolve => { release = () => resolve({ data: [pr] }); }); };
  const pending = scan.tick(); await scan.tick(); assert.equal(calls.length, 1); release(); await pending;
  advance(); s.state.save = () => { throw Object.assign(Error("disk full"), { persistence: true }); };
  await assert.rejects(scan.tick(), { persistence: true }); assert.equal(scan.running, false);
});
test("pagination failure does not mistake unvisited PRs for closed PRs", async t => {
  const { s, scan, pr, advance } = fixture(t);
  await scan.tick(); advance();
  s.github.rest.pulls.list = async args => {
    if (args.page === 2) throw Error("second page unavailable");
    return { data: Array.from({ length: 100 }, (_, n) => ({ ...pr, number: n + 2 })) };
  };
  await scan.tick(); assert.ok(s.state.data.admissionSnapshots["lexmount/example#1"]);
  assert.equal(Object.keys(s.orgCI.receipts).length, 0);
});

test("missed reopen reaccepts a closed receipt after a new grace period", async t => {
  const { s, scan, current, pr, advance } = fixture(t);
  const p = snapshot("lexmount/example", pr);
  await s.orgCI.submit(p, "agent"); await scan.tick();
  s.orgCI.stop(s.orgCI.receipts[p.request_id], "superseded", "pr_closed");
  advance(); await scan.tick();
  assert.equal(s.orgCI.receipts[p.request_id].state, "superseded");
  assert.equal(s.state.data.admissionSnapshots["lexmount/example#1"].missingSinceAt, current.now);
  advance(); await scan.tick();
  assert.equal(s.orgCI.receipts[p.request_id].state, "accepted");
  assert.equal(s.orgCI.receipts[p.request_id].reopenHistory.length, 1);
});

test("a stale PR does not starve other missing PRs in the same repository", async t => {
  const { s, scan, current, pr, advance } = fixture(t);
  current.pulls.push({ ...pr, number: 2 });
  await scan.tick(); advance();
  s.github.rest.pulls.get = async args => ({ data: args.pull_number === 1
    ? { ...pr, head: { sha: "c".repeat(40) } } : current.pulls[1] });
  const result = await scan.tick();
  assert.equal(result.admitted, 1); assert.equal(result.errors, 1);
  assert.equal(Object.keys(s.orgCI.receipts).length, 1);
  assert.equal(Object.values(s.orgCI.receipts)[0].pull_number, 2);
});

test("a refused reopen does not consume the recovery cap or starve another PR", async t => {
  const { s, scan, current, pr, advance } = fixture(t, { maxAdmissionsPerScan: 1 });
  const p = snapshot("lexmount/example", pr);
  await s.orgCI.submit(p, "agent");
  s.orgCI.stop(s.orgCI.receipts[p.request_id], "superseded", "pr_closed");
  s.orgCI.receipts[p.request_id].jobId = 12345;
  current.pulls.push({ ...pr, number: 2 });
  s.github.rest.pulls.get = async args => ({ data: current.pulls.find(p => p.number === args.pull_number) });
  await scan.tick(); advance(); const result = await scan.tick();
  assert.equal(result.admitted, 1);
  assert.equal(s.state.data.admissionSnapshots["lexmount/example#1"].status, "reopen_blocked");
  assert.equal(s.orgCI.receipts[p.request_id].reconciliation, undefined);
  assert.equal(Object.values(s.orgCI.receipts).find(r => r.pull_number === 2).state, "accepted");
  advance(); assert.equal((await scan.tick()).admitted, 0);
});


test("initial baseline skips exact historical snapshots but recovers new and changed PRs", async t => {
  const { s, current, pr, advance } = fixture(t);
  const id = snapshot("lexmount/example", pr).request_id;
  s.config.admissionReconciliation.initialBaseline = [id];
  const scan = new AdmissionReconciliation(s, () => current.now);
  await scan.tick(); advance(); await scan.tick();
  assert.equal(s.state.data.admissionSnapshots["lexmount/example#1"].status, "baseline");
  assert.equal(Object.keys(s.orgCI.receipts).length, 0);
  const restarted = new AdmissionReconciliation(s, () => current.now);
  advance(); await restarted.tick();
  assert.equal(Object.keys(s.orgCI.receipts).length, 0);
  current.pulls = [{ ...pr, number: 2 }, { ...pr, base: { ...pr.base, ref: "main" } }];
  s.github.rest.pulls.get = async args => ({ data: current.pulls.find(p => p.number === args.pull_number) });
  advance(); await restarted.tick();
  assert.equal(Object.keys(s.orgCI.receipts).length, 0);
  advance(); await restarted.tick();
  assert.equal(Object.keys(s.orgCI.receipts).length, 2);
});

test("initial baseline validates canonical IDs and cannot suppress a changed head or base", async t => {
  for (const field of ["head", "base"]) {
    const { s, config, current, pr, advance } = fixture(t);
    const id = snapshot("lexmount/example", pr).request_id;
    for (const initialBaseline of [null, {}, ["invalid"], [null]]) {
      assert.throws(() => configuration({ ...config, admissionReconciliation: { initialBaseline } }), /initialBaseline/);
    }
    s.config.admissionReconciliation.initialBaseline = [id];
    const scan = new AdmissionReconciliation(s, () => current.now);
    await scan.tick(); pr[field].sha = "c".repeat(40);
    advance(); await scan.tick(); advance(); await scan.tick();
    assert.equal(Object.keys(s.orgCI.receipts).length, 1);
  }
});
