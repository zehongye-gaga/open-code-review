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

const repository = "owner/repo", head = "b".repeat(40), base = "a".repeat(40);
const session = "11111111-2222-3333-4444-555555555555";
const overflow = "prompt exceeded the configured token budget";
const compression = "stopped because context compression exceeded its threshold";

function harness(t, outcomes, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-context-service-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, "ocr"); fs.writeFileSync(binary, "mock binary");
  const sessions = path.join(root, "sessions");
  const config = { stateDirectory: root, binary, maxAttempts: 5, analytics: { sessionDirectory: sessions },
    repositories: [{ name: repository, baseBranches: ["main"] }], ...overrides };
  const pull = { number: 1, state: "open", draft: false, head: { sha: head }, base: { sha: base, ref: "main", repo: { full_name: repository } } };
  const statuses = [], invocations = [], publications = [];
  const github = { getToken: () => "fixture", rest: { pulls: { get: async () => ({ data: pull }) },
    repos: { createCommitStatus: async value => { statuses.push(value); return { data: {} }; } } } };
  const dependencies = { config, github, log: () => {}, resolveContextTokens: options => options.maxTokens ?? 200000,
    prepare: async ({ core, snapshot, context, cwd }) => {
      const directory = path.join(root, "runs", `ocr-pr-${context.runAttempt}`); fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "metadata.json"), JSON.stringify(snapshot || {
        number: 1, head, base, base_ref: "main", merge_base: base, background: "Fixture requirements", telemetry: { workspace: cwd } }));
      core.setOutput("should_review", "true"); core.setOutput("result_directory", directory);
    },
    run: async ({ directory, cwd, options, resume, requireResume, budget, beforeNativeStart }) => {
      await beforeNativeStart();
      invocations.push({ maxTokens: options.maxTokens ?? 200000, resume, requireResume, budget });
      const reason = outcomes[invocations.length - 1];
      const metadata = JSON.parse(fs.readFileSync(path.join(directory, "metadata.json")));
      const done = { item_id: "already-reviewed", path: "done.js", fingerprint: "done-diff" };
      const pending = { item_id: "remaining", path: "large.js", fingerprint: "large-diff" };
      const state = reason ? "partial" : "complete";
      const sessionPath = path.join(sessions, cwd.replace(/^([A-Za-z]):[\\/]/, "$1_").replace(/^[\\/]+/, "").replace(/[\\/]/g, "-"));
      fs.mkdirSync(sessionPath, { recursive: true });
      fs.writeFileSync(path.join(sessionPath, `${session}.jsonl`), [
        { type: "session_start", sessionId: session, cwd, diffFrom: metadata.range.from, diffTo: head },
        { type: "review_item_failed", sessionId: session, filePath: pending.path, fingerprint: pending.fingerprint,
          error: reason || "" },
      ].map(event => JSON.stringify(event)).join("\n") + "\n");
      fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ status: state, session_id: session, comments: [],
        manifest: { schema_version: "ocr.run-manifest/v1", operation: "review", run_id: session, terminal_state: state,
          input: { mode: "range", resolved_base: metadata.range.from, resolved_head: head },
          coverage: { selected: [done, pending], reused: [done], completed: reason ? [] : [pending], waived: [],
            failed: reason ? [{ ...pending, classification: "budget", reason }] : [] } } }));
      fs.writeFileSync(path.join(directory, "exit-code.json"), "0");
    },
    publish: async () => { publications.push(true); return { comments: [], summaryURL: "https://example.test/review" }; } };
  const create = () => new ReviewService({ ...dependencies, state: new State(root) });
  const service = create(); service.accept(repository, pull);
  return { service, create, root, statuses, invocations, publications };
}

async function attempt(service) {
  const job = service.state.data.jobs[0]; job.nextAt = 0;
  await service.tick(); return service.state.data.jobs[0];
}

test("two context warnings stay private and pending; execution three fails without execution four", async t => {
  const h = harness(t, [overflow, compression, overflow]);
  let job = await attempt(h.service);
  assert.equal(job.state, "queued"); assert.equal(job.retryMaxTokens, 400000);
  assert.ok(h.statuses.every(status => status.state === "pending"));
  assert.equal(job.contextRetries.length, 1);
  assert.equal(h.publications.length, 0);
  const restarted = h.create(); job = await attempt(restarted);
  assert.equal(job.state, "queued"); assert.equal(job.retryMaxTokens, 800000);
  assert.ok(h.statuses.every(status => status.state === "pending"));
  assert.equal(job.contextRetries.length, 2);
  job = await attempt(restarted);
  assert.equal(job.state, "failed"); assert.equal(job.attempt, 3);
  assert.equal(h.statuses.at(-1).state, "error");
  assert.deepEqual(h.invocations.map(call => call.maxTokens), [200000, 400000, 800000]);
  assert.equal(h.invocations[1].resume, session); assert.equal(h.invocations[2].resume, session);
  assert.ok(h.invocations.every(call => call.budget === 0));
  assert.ok(h.statuses.every(status => !/400000|800000|warning|expanded|compression/.test(status.description)));
  assert.equal(job.contextRetries.length, 2);
  assert.match(job.failureDiagnostics.message, /prompt exceeded the configured token budget/);
  await attempt(restarted); assert.equal(h.invocations.length, 3); assert.equal(h.publications.length, 0);
});

test("execution three can succeed and publishes once while both expansion warnings remain visible", async t => {
  const h = harness(t, [compression, overflow, null]);
  await attempt(h.service); await attempt(h.service); const job = await attempt(h.service);
  assert.equal(job.state, "complete"); assert.equal(h.publications.length, 1);
  assert.equal(h.statuses.at(-1).state, "success");
  assert.equal(job.contextRetries.length, 2);
  assert.equal(job.failureDiagnostics, undefined);
});

test("unrelated errors do not expand; policy rejection retains the original failure", async t => {
  const unrelated = harness(t, ["authentication failed"]);
  const ordinary = await attempt(unrelated.service);
  assert.equal(ordinary.retryMaxTokens, undefined); assert.equal(ordinary.contextRetries, undefined);
  const limited = harness(t, [overflow], { contextRetry: { maxTokens: 300000 } });
  const failed = await attempt(limited.service);
  assert.equal(failed.state, "failed"); assert.equal(failed.retryMaxTokens, undefined);
  assert.match(failed.failureDiagnostics.message, /prompt exceeded the configured token budget/);
  assert.match(failed.failureDiagnostics.message, /200000 -> 400000.*300000/);
  assert.equal(failed.contextRetries, undefined);
});

test("preparation failures do not consume native context executions", async t => {
  const h = harness(t, [overflow, overflow, null]);
  const prepare = h.service.prepare; let calls = 0;
  h.service.prepare = async args => { if (++calls <= 2) throw Error("Temporary fetch failure"); return prepare(args); };
  await attempt(h.service); await attempt(h.service);
  let job = await attempt(h.service);
  assert.equal(job.attempt, 3); assert.equal(job.nativeAttempts, 1);
  assert.equal(job.state, "queued"); assert.equal(job.contextRetries[0].attempt, 1);
  await attempt(h.service); job = await attempt(h.service);
  assert.equal(job.state, "complete"); assert.equal(job.nativeAttempts, 3);
  assert.deepEqual(h.invocations.map(call => call.maxTokens), [200000, 400000, 800000]);
});

for (const phase of ["preparation", "native startup"]) test(`${phase} failures after a context expansion remain bounded across restart`, async t => {
  const h = harness(t, [overflow]); await attempt(h.service);
  const service = h.create();
  if (phase === "preparation") service.prepare = async () => { throw Error("Persistent fetch failure"); };
  else service.run = async () => { throw Error("Native input unavailable before start"); };
  for (let n = 1; n <= service.config.maxAttempts; n++) {
    const job = await attempt(service);
    assert.equal(job.nativeAttempts, 1); assert.equal(job.contextPreparationFailures, n);
    assert.equal(job.state, n < service.config.maxAttempts ? "queued" : "failed");
  }
  assert.equal(h.invocations.length, 1);
  assert.equal(h.statuses.at(-1).state, "error");
});
