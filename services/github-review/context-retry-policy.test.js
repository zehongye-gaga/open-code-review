// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ReviewService } = require("./service.js");
const { State } = require("./state.js");
const { resolveOptions } = require("./options.js");
const { bindPolicy, currentPolicy } = require("./review-policy.js");

const repository = "owner/repo", head = "b".repeat(40), base = "a".repeat(40);
const session = "11111111-2222-3333-4444-555555555555";
const overflow = "prompt exceeded the configured token budget";
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));

function snapshotInput(snapshot) {
  const { fingerprint, checkpointFingerprint, range, ...input } = copy(snapshot);
  return { ...input, range: { mode: range.mode, from: range.from, to: range.to } };
}

function harness(t, { crashAt, crashAfterReportAt } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-context-policy-"));
  const states = [];
  t.after(() => {
    for (const state of states) state.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const binary = path.join(root, "ocr"), rules = path.join(root, "rules.json");
  fs.writeFileSync(binary, "mock native binary");
  fs.writeFileSync(rules, JSON.stringify({ rules: [{ path: "**", rule: "Check authorization boundaries." }] }));
  const actor = { id: "insightflow-agent", role: "agent", repositories: [repository], tokenFile: path.join(root, "unused-token") };
  const config = { stateDirectory: root, binary, maxAttempts: 5,
    repositories: [{ name: repository, baseBranches: ["main"], requiresAgent: true, reviewDefaults: { ruleSet: "security" } }],
    infrastructure: { dispatchEnabled: true, allowUnlimitedBudget: true, policyVersion: "1", clients: [actor],
      ruleSets: { security: rules }, budgetRetry: { enabled: true, mode: "unlimited", maxRetries: 4, multiplier: 2 } } };
  const pull = { number: 1, state: "open", draft: false, head: { sha: head },
    base: { sha: base, ref: "main", repo: { full_name: repository } } };
  const invocations = [], preparedSnapshots = [], statuses = [], publications = [];
  const github = { getToken: () => "fixture", rest: {
    pulls: { get: async () => ({ data: pull }) },
    repos: { createCommitStatus: async value => { statuses.push(value); return { data: {} }; } } } };
  const dependencies = { config, github, log: () => {}, resolveContextTokens: options => options.maxTokens ?? 200000,
    prepare: async ({ core, snapshot, context, cwd }) => {
      preparedSnapshots.push(copy(snapshot));
      const directory = path.join(root, "runs", `ocr-pr-${context.runAttempt}`);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "metadata.json"), JSON.stringify(snapshot || {
        number: 1, head, base, base_ref: "main", merge_base: base,
        background: "Original PR requirements", telemetry: { workspace: cwd } }));
      core.setOutput("should_review", "true"); core.setOutput("result_directory", directory);
    },
    run: async ({ directory, options, resume, requireResume, budget, beforeNativeStart }) => {
      await beforeNativeStart();
      const metadata = JSON.parse(fs.readFileSync(path.join(directory, "metadata.json")));
      invocations.push({ maxTokens: options.maxTokens ?? 200000, resume, requireResume, budget,
        options: copy(options), input: snapshotInput(metadata) });
      if (invocations.length === crashAt) {
        // A persistence failure escapes runJob without settling the persisted running attempt.
        throw Object.assign(new Error("Simulated process crash"), { persistence: true });
      }
      const failed = invocations.length < 3, terminal = failed ? "partial" : "complete";
      const done = { item_id: "reviewed", path: "done.js", fingerprint: "done-diff" };
      const pending = { item_id: "pending", path: "large.js", fingerprint: "large-diff" };
      fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ status: terminal, session_id: session, comments: [],
        manifest: { schema_version: "ocr.run-manifest/v1", operation: "review", run_id: session, terminal_state: terminal,
          input: { mode: "range", resolved_base: metadata.range.from, resolved_head: head },
          coverage: { selected: [done, pending], reused: [done], completed: failed ? [] : [pending], waived: [],
            failed: failed ? [{ ...pending, classification: "budget", reason: overflow }] : [] } } }));
      fs.writeFileSync(path.join(directory, "exit-code.json"), "0");
      if (invocations.length === crashAfterReportAt) {
        throw Object.assign(new Error("Simulated crash after native report"), { persistence: true });
      }
    },
    publish: async () => { publications.push(true); return { comments: [], summaryURL: "https://example.test/review" }; } };
  const create = () => {
    const state = new State(root); states.push(state);
    return new ReviewService({ ...dependencies, state });
  };
  const service = create();
  const settings = resolveOptions(service.config, service.repo(repository), "deep", { background: "Inspect trust boundaries.", fullReview: false });
  settings.preview = false;
  bindPolicy(service, service.repo(repository), settings);
  const job = service.accept(repository, pull, { settings, requestedBy: actor.id, requestId: "context-policy-fixture" });
  job.retryBudget = 0;
  service.state.save();
  return { service, create, root, actor, rules, invocations, preparedSnapshots, statuses, publications };
}

async function attempt(service) {
  const job = service.state.data.jobs[0]; job.nextAt = 0;
  await service.tick(); return service.state.data.jobs[0];
}

test("Agent jobs with unlimited aggregate budget resume context expansions without changing admitted settings or snapshot input", async t => {
  const h = harness(t), originalSettings = copy(h.service.state.data.jobs[0].settings);
  let job = await attempt(h.service);
  assert.equal(job.state, "queued"); assert.equal(job.retryMaxTokens, 400000);
  const originalSnapshot = snapshotInput(job.snapshot);
  assert.deepEqual(job.settings, originalSettings);
  const restarted = h.create();
  job = await attempt(restarted);
  assert.equal(job.state, "queued"); assert.equal(job.retryMaxTokens, 800000);
  assert.deepEqual(job.settings, originalSettings);
  assert.deepEqual(snapshotInput(job.snapshot), originalSnapshot);
  job = await attempt(restarted);
  assert.equal(job.state, "complete"); assert.equal(h.publications.length, 1);
  assert.deepEqual(h.invocations.map(call => call.maxTokens), [200000, 400000, 800000]);
  assert.deepEqual(h.invocations.slice(1).map(call => [call.resume, call.requireResume]), [[session, true], [session, true]]);
  assert.ok(h.invocations.every(call => call.budget === 0));
  assert.ok(h.invocations.every(call => call.options.rule === originalSettings.resources.ruleSet.file));
  assert.deepEqual(job.settings, originalSettings);
  assert.equal(job.requestedBy, "insightflow-agent"); assert.equal(job.retryBudget, 0);
  assert.equal(job.settings.options.budget, 500000); assert.equal(job.settings.options.maxTokens, undefined);
  assert.deepEqual(snapshotInput(job.snapshot), originalSnapshot);
  for (const call of h.invocations) assert.deepEqual(call.input, originalSnapshot);
  for (const snapshot of h.preparedSnapshots.slice(1)) assert.deepEqual(snapshotInput(snapshot), originalSnapshot);
});

test("context expansion is durable while GitHub status publication is still waiting", async t => {
  const h = harness(t);
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const unblock = new Promise(resolve => { release = resolve; });
  const publishStatus = h.service.status.bind(h.service);
  h.service.status = async (job, state, ...args) => {
    if (state === "pending" && job.contextRetries?.length === 1) {
      entered();
      await unblock;
    }
    return publishStatus(job, state, ...args);
  };
  const execution = attempt(h.service);
  try {
    await Promise.race([waiting, execution.then(() => { throw new Error("Expected pending status publication to wait"); })]);
    const independent = new State(h.root);
    try {
      const persisted = independent.database.load().jobs[0];
      assert.equal(persisted.state, "queued");
      assert.equal(persisted.attempt, 1);
      assert.equal(persisted.contextRetries.length, 1);
      assert.equal(persisted.retryMaxTokens, 400000);
      assert.deepEqual([persisted.contextRetries[0].from, persisted.contextRetries[0].to], [200000, 400000]);
      assert.match(persisted.failureDiagnostics.message, /prompt exceeded the configured token budget/);
    } finally { independent.database.close(); }
  } finally { release(); await execution; }
  assert.equal(h.invocations.length, 1);
  assert.ok(h.statuses.every(status => status.state === "pending"));
});

for (const [name, change] of [
  ["policy version", h => { h.service.config.infrastructure.policyVersion = "2"; }],
  ["named rule set mapping", h => {
    const replacement = path.join(h.root, "replacement-rules.json");
    fs.writeFileSync(replacement, JSON.stringify({ rules: [{ path: "**", rule: "Enforce new security requirements." }] }));
    h.service.config.infrastructure.ruleSets.security = replacement;
  }],
]) {
  test(`${name} changes reject an expanded Agent job before its old session can run`, async t => {
    const h = harness(t); await attempt(h.service);
    const originalSettings = copy(h.service.state.data.jobs[0].settings);
    const originalSnapshot = copy(h.service.state.data.jobs[0].snapshot);
    change(h);
    const restarted = h.create();
    assert.equal(currentPolicy(restarted, restarted.state.data.jobs[0]), false);
    const job = await attempt(restarted);
    assert.equal(h.invocations.length, 1, "Changed policy must not resume or restart native execution");
    assert.equal(job.state, "failed"); assert.equal(h.publications.length, 0);
    assert.match(job.error, /policy.*changed/i);
    assert.deepEqual(job.settings, originalSettings); assert.deepEqual(job.snapshot, originalSnapshot);
  });
}

for (const [name, change] of [
  ["removed Agent", h => { h.service.config.infrastructure.clients = []; }],
  ["revoked repository scope", h => { h.actor.repositories = ["other/repo"]; }],
  ["revoked dispatch role", h => { h.actor.role = "reader"; }],
]) {
  test(`${name} blocks the next context attempt after restart`, async t => {
    const h = harness(t); await attempt(h.service);
    const originalSettings = copy(h.service.state.data.jobs[0].settings);
    const originalSnapshot = copy(h.service.state.data.jobs[0].snapshot);
    change(h);
    const restarted = h.create();
    const job = await attempt(restarted);
    assert.equal(h.invocations.length, 1, "Revoked authorization must prevent another native execution");
    assert.equal(job.state, "failed"); assert.equal(h.publications.length, 0);
    assert.deepEqual(job.settings, originalSettings); assert.deepEqual(job.snapshot, originalSnapshot);
  });
}

test("a crash during the third native execution cannot start a fourth execution after restart", async t => {
  const h = harness(t, { crashAt: 3 });
  await attempt(h.service); await attempt(h.service);
  const originalSettings = copy(h.service.state.data.jobs[0].settings);
  const originalSnapshot = snapshotInput(h.service.state.data.jobs[0].snapshot);
  await assert.rejects(attempt(h.service), /Simulated process crash/);
  assert.equal(h.invocations.length, 3);
  assert.equal(h.service.state.data.jobs[0].state, "running");
  assert.equal(h.service.state.data.jobs[0].attempt, 3);
  const restarted = h.create();
  const job = await attempt(restarted);
  assert.equal(h.invocations.length, 3, "The three-execution limit must survive a process crash");
  assert.equal(job.state, "failed"); assert.equal(h.publications.length, 0);
  assert.match(job.failureDiagnostics.message, /prompt exceeded the configured token budget/);
  assert.deepEqual(job.settings, originalSettings);
  assert.deepEqual(snapshotInput(job.snapshot), originalSnapshot);
});

test("a complete third native report can be published after restart without another native execution", async t => {
  const h = harness(t, { crashAfterReportAt: 3 });
  await attempt(h.service); await attempt(h.service);
  const originalSettings = copy(h.service.state.data.jobs[0].settings);
  const originalSnapshot = snapshotInput(h.service.state.data.jobs[0].snapshot);
  await assert.rejects(attempt(h.service), /Simulated crash after native report/);
  assert.equal(h.invocations.length, 3); assert.equal(h.publications.length, 0);
  assert.equal(h.service.state.data.jobs[0].state, "running");
  assert.equal(h.service.state.data.jobs[0].progress.complete, true);
  const restarted = h.create();
  const job = await attempt(restarted);
  assert.equal(job.state, "complete"); assert.equal(h.publications.length, 1);
  assert.equal(h.invocations.length, 3, "Completed native evidence must be reused for publication");
  assert.equal(job.attempt, 3); assert.equal(h.statuses.at(-1).state, "success");
  assert.deepEqual(job.settings, originalSettings);
  assert.deepEqual(snapshotInput(job.snapshot), originalSnapshot);
  await attempt(restarted);
  assert.equal(h.publications.length, 1); assert.equal(h.invocations.length, 3);
});
