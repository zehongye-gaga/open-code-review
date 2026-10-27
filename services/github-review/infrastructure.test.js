// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ReviewService } = require("./service.js");
const { State } = require("./state.js");
const { Infrastructure } = require("./infrastructure.js");
const { resolveOptions, executionOptions, cliArguments } = require("./options.js");
const { createServer } = require("./server.js");
const head = "b".repeat(40), base = "a".repeat(40);
const actor = { id: "agent", role: "agent", repositories: ["org/*"] };
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-infra-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binary = path.join(dir, "ocr"); fs.writeFileSync(binary, "fixture");
  const pull = { number: 1, state: "open", draft: false, title: "Change", head: { sha: head }, base: { sha: base, ref: "main", repo: { full_name: "org/repo" } } };
  const statuses = [];
  const github = { getToken: () => "test", rest: { pulls: { get: async () => ({ data: pull }), list: async () => { throw new Error("Polling must not run"); }, listFiles: async () => ({ data: [{ filename: "src/a.js", additions: 2, patch: "x".repeat(20000) }] }) }, repos: { createCommitStatus: async (s) => statuses.push(s) } } };
  const config = { stateDirectory: dir, binary, provider: "mock", model: "model", repositories: [{ name: "org/repo", baseBranches: ["main"], requiresAgent: true }],
    infrastructure: { enabled: true, externalDispatch: true, organizations: [{ name: "org" }] } };
  const s = new ReviewService({ config, github, log: () => {} });
  const api = new Infrastructure(s);
  const args = { repository: "org/repo", pull_number: 1, head_sha: head, base_sha: base };
  return { dir, s, api, args, pull, statuses, config };
}
test("equivalent concurrent submissions deduplicate durably; changed parameters cannot duplicate automated reviews", async (t) => {
  const h = setup(t);
  const jobs = await Promise.all(Array.from({ length: 5 }, () => h.api.call("submit_review", { ...h.args, request_id: "delivery-1", options: { effort: "low" } }, actor)));
  assert.equal(new Set(jobs.map((j) => j.job_id)).size, 1);
  assert.equal(h.s.state.data.jobs.length, 1);
  const restored = new State(h.dir);
  assert.equal(restored.data.jobs[0].settings.options.effort, "low");
  await assert.rejects(h.api.call("submit_review", { ...h.args, request_id: "delivery-1", options: { effort: "high" } }, actor), /request_id/);
  const next = await h.api.call("submit_review", { ...h.args, options: { effort: "high" } }, actor);
  assert.equal(next.job_id, jobs[0].job_id);
});
test("authorization, stale SHA, unknown flags, model allowlists and budgets fail before queueing", async (t) => {
  const h = setup(t);
  for (const [args, who] of [
    [h.args, { id: "n8n", role: "dispatcher", repositories: ["org/*"] }],
    [h.args, { id: "reader", role: "reader", repositories: ["org/*"] }],
    [{ ...h.args, head_sha: "c".repeat(40) }, actor],
    [{ ...h.args, options: { shell: "id" } }, actor],
    [{ ...h.args, options: { budget: 0 } }, actor],
    [{ ...h.args, options: { budget: 1000001 } }, actor],
    [{ ...h.args, options: { model: "unconfigured" } }, actor],
    [{ ...h.args, profile: "__proto__" }, actor],
  ]) await assert.rejects(h.api.call("submit_review", args, who));
  assert.equal(h.s.state.data.jobs.length, 0);
});
test("external dispatch prevents polling and legacy observations from bypassing the agent", async (t) => {
  const h = setup(t);
  await h.s.poll(); assert.ok(h.s.lastPoll);
  assert.equal(await h.s.observe("org/repo", 1), null);
  assert.equal(h.s.state.data.jobs.length, 0);
  assert.ok(h.s.repo("org/new-repo")); assert.equal(h.s.repo("other/new-repo"), null);
});
test("preview is isolated from pending review and emits no GitHub status", async (t) => {
  const h = setup(t);
  const real = await h.api.call("submit_review", h.args, actor);
  const before = h.statuses.length;
  const preview = await h.api.call("preview_review", h.args, actor);
  assert.equal(h.statuses.length, before);
  assert.equal(h.s.state.data.jobs.find((j) => j.id === real.job_id).state, "queued");
  assert.equal(preview.preview, true);
});
test("cancellation survives worker completion and restart; retry requires unchanged source", async (t) => {
  const h = setup(t);
  const submitted = await h.api.call("submit_review", h.args, actor);
  const j = h.s.state.data.jobs[0];
  let release;
  h.s.execute = async () => new Promise((resolve) => { release = resolve; });
  const running = h.s.tick();
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  await h.api.call("cancel_review", { job_id: submitted.job_id, reason: "operator cancelled" }, actor);
  release({ stale: true }); await running;
  assert.equal(j.state, "cancelled");
  assert.equal(new State(h.dir).data.jobs[0].state, "cancelled");
  h.pull.head.sha = "c".repeat(40);
  await assert.rejects(h.api.call("retry_review", { job_id: j.id }, actor), /PR changed/);
  h.pull.head.sha = head;
  assert.equal((await h.api.call("retry_review", { job_id: j.id }, actor)).state, "queued");
});
test("partial budget-exhausted results are never certified complete and results are scoped", async (t) => {
  const h = setup(t);
  await h.api.call("submit_review", h.args, actor);
  const j = h.s.state.data.jobs[0];
  j.directory = h.dir; j.state = "failed"; j.progress = { complete: false, budgetExceeded: true };
  fs.writeFileSync(path.join(h.dir, "result.json"), JSON.stringify({ status: "partial", comments: [{ severity: "high" }], summary: { budget_exceeded: true } }));
  const result = await h.api.call("get_review_result", { job_id: j.id }, actor);
  assert.equal(result.complete, false); assert.equal(result.budget_exhausted, true);
  await assert.rejects(h.api.call("get_review_result", { job_id: j.id }, { role: "reader", repositories: ["other/*"] }), /scope/);
});
test("named resources are pinned and command arguments remain separate values", (t) => {
  const h = setup(t), file = path.join(h.dir, "rules.json"); fs.writeFileSync(file, "{}");
  h.s.config.infrastructure.ruleSets = { security: file };
  h.s.config.infrastructure.providers = { mock: { models: ["model"], reasoningEfforts: ["low"], reasoningProviders: { low: "mock-low" } } };
  const settings = resolveOptions(h.s.config, h.s.repo("org/repo"), "light", { ruleSet: "security", reasoningEffort: "low", exclude: "$(touch /tmp/never)", maxTools: 50 });
  assert.equal(executionOptions(settings).provider, "mock-low");
  assert.ok(cliArguments(executionOptions(settings)).includes("$(touch /tmp/never)"));
  fs.writeFileSync(file, "changed"); assert.throws(() => executionOptions(settings), /changed/);
});
test("authorized policy skip is explicit and non-failing; patches are bounded", async (t) => {
  const h = setup(t);
  await assert.rejects(h.api.call("record_review_skip", { ...h.args, reason: "docs only" }, actor), /does not allow/);
  h.s.config.repositories[0].allowSkip = true;
  const skip = await h.api.call("record_review_skip", { ...h.args, reason: "docs only" }, actor);
  assert.equal(skip.state, "skipped"); assert.equal(h.statuses.at(-1).state, "success");
  const ctx = await h.api.call("get_pr_context", { repository: "org/repo", pull_number: 1, include_patches: true }, actor);
  assert.equal(ctx.files[0].patch.length, 10000); assert.equal(ctx.files[0].patch_truncated_or_unavailable, true);
});
test("MCP lifecycle and HTTP share authentication, origin protection, validation and task IDs", async (t) => {
  const h = setup(t), server = createServer(h.s, { apiToken: "test-secret" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: "Bearer test-secret", "content-type": "application/json", accept: "application/json, text/event-stream" };
  const rpc = (body, extra = {}) => fetch(url + "/mcp", { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).status, 200);
  assert.equal((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const listed = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  assert.ok(listed.result.tools.some((tool) => tool.name === "submit_review"));
  assert.equal((await rpc({ jsonrpc: "2.0", id: 3, method: "ping" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 3, method: "ping" }, { authorization: "Bearer wrong" })).status, 401);
  const submitted = await (await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "submit_review", arguments: h.args } })).json();
  assert.equal(submitted.result.isError, false);
  const http = await (await fetch(url + "/v2/submit_review", { method: "POST", headers, body: JSON.stringify(h.args) })).json();
  assert.equal(http.job_id, submitted.result.structuredContent.job_id);
  const invalid = await (await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "submit_review", arguments: { ...h.args, options: { budget: -1 } } } })).json();
  assert.equal(invalid.result.isError, true);
  const legacy = await fetch(url + "/v1/reviews", { method: "POST", headers, body: JSON.stringify({ repository: "org/repo", pull_number: 1 }) });
  assert.equal(legacy.status, 409);
});

test("queued job uses its saved options and changed heads cannot silently enqueue an unapproved task", async (t) => {
  const h = setup(t);
  const submitted = await h.api.call("submit_review", { ...h.args, options: { effort: "high", concurrency: 3, budget: 123456 } }, actor);
  const j = h.s.state.data.jobs[0];
  h.pull.head.sha = "c".repeat(40);
  await h.s.tick();
  assert.equal(j.state, "superseded");
  assert.equal(h.s.state.data.jobs.length, 1);
  assert.equal(submitted.options.budget, 123456);
});

test("native subprocess receives configurable flags and request timeout without mutating global environment", async (t) => {
  const h = setup(t);
  const { runReview } = require("./review.js");
  const binary = path.join(h.dir, "capture");
  fs.writeFileSync(binary, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2),timeout:process.env.OCR_LLM_TIMEOUT}));`, { mode: 0o700 });
  fs.writeFileSync(path.join(h.dir, "metadata.json"), JSON.stringify({ head, merge_base: base, background: "context" }));
  const before = process.env.OCR_LLM_TIMEOUT;
  await runReview({ core: { info() {} }, directory: h.dir, binary, cwd: h.dir, budget: 1234,
    options: { effort: "high", concurrency: 3, timeout: 9, maxTokens: 32000, maxTools: 50, maxGitProcs: 4,
      requestTimeoutSeconds: 33, noFilter: true, preview: true, exclude: "*.lock", rule: "/trusted/rule.json", tools: "/trusted/tools.json" } });
  const r = JSON.parse(fs.readFileSync(path.join(h.dir, "result.json")));
  for (const [flag, value] of [["--effort", "high"], ["--concurrency", "3"], ["--timeout", "9"], ["--max-tokens", "32000"], ["--max-tools", "50"], ["--max-git-procs", "4"], ["--rule", "/trusted/rule.json"], ["--tools", "/trusted/tools.json"]]) assert.equal(r.args[r.args.indexOf(flag) + 1], value);
  assert.ok(r.args.includes("--preview")); assert.ok(r.args.includes("--no-filter"));
  assert.equal(r.timeout, "33"); assert.equal(process.env.OCR_LLM_TIMEOUT, before);
});

test("staged infrastructure supports preview but cannot start live reviews before routing cutover", async (t) => {
  const h = setup(t); h.s.config.infrastructure.dispatchEnabled = false;
  await assert.rejects(h.api.call("submit_review", h.args, actor), /cutover/);
  const caps = await h.api.call("get_capabilities", {}, actor);
  assert.equal(caps.live_dispatch_enabled, false);
  const preview = await h.api.call("preview_review", h.args, actor);
  assert.equal(preview.preview, true);
});


test("automated submissions use incremental policy while admins can request full review", async (t) => {
  const h = setup(t);
  await h.api.call("submit_review", { ...h.args, options: { fullReview: true } }, actor);
  assert.equal(h.s.state.data.jobs[0].fullReview, false);
  assert.equal(h.s.state.data.jobs[0].settings.options.fullReview, false);
  await h.api.call("submit_review", { ...h.args, options: { fullReview: true } }, { id: "operator", role: "admin" });
  assert.equal(h.s.state.data.jobs[1].fullReview, true);
});
