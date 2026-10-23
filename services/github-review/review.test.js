// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { resolvePullRequest, prepareReview, runReview, publishReview } = require("./review.js");

const base = "a".repeat(40);
const head = "b".repeat(40);
const context = { repo: { owner: "owner", repo: "repo" }, eventName: "workflow_dispatch" };
function makePR(overrides = {}) {
  return { number: 1, state: "open", draft: false, title: "Fix arithmetic", body: "Keep empty inputs safe",
    head: { sha: head }, base: { sha: base, repo: { full_name: "owner/repo" } }, ...overrides };
}
function harness(pr = makePR()) {
  const outputs = {}, failures = [], notices = [];
  return {
    outputs, failures, notices, context,
    github: { rest: { pulls: { get: async () => ({ data: pr }) } } },
    core: { setOutput: (k, v) => { outputs[k] = v; }, setFailed: (v) => failures.push(v),
      notice: (v) => notices.push(v), info: () => {}, warning: () => {} },
  };
}
function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-pr-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function saveResult(directory, result = { status: "complete", comments: [],
  manifest: { terminal_state: "complete", input: { resolved_head: head } } }, exitCode = 0) {
  fs.writeFileSync(path.join(directory, "metadata.json"), JSON.stringify({ number: 1, head, base,
    merge_base: base, background: "Untrusted text: $(touch should-not-exist); `whoami`" }));
  fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify(result));
  fs.writeFileSync(path.join(directory, "stderr.log"), "");
  fs.writeFileSync(path.join(directory, "exit-code.json"), JSON.stringify(exitCode));
}

test("PR resolution rejects malformed numbers and skips stale, closed and draft events", async () => {
  for (const number of ["1;whoami", "-1", "0", "1\n2", "99999999999999999999"]) {
    await assert.rejects(resolvePullRequest({ ...harness(), prNumber: number }), /positive integer/);
  }
  for (const pr of [makePR({ state: "closed" }), makePR({ draft: true })]) {
    assert.equal(await resolvePullRequest({ ...harness(pr), prNumber: "1" }), null);
  }
  const h = harness();
  assert.equal(await resolvePullRequest({ ...h, prNumber: "1", context: { ...context,
    eventName: "pull_request_target", payload: { pull_request: { head: { sha: "c".repeat(40) } } } } }), null);
  assert.equal((await resolvePullRequest({ ...h, prNumber: "1" })).head, head);
  await assert.rejects(resolvePullRequest({ ...harness(makePR({ head: { sha: "--help" } })), prNumber: "1" }), /valid head/);
});

test("fetches exact PR objects while retaining the trusted base working tree", async (t) => {
  const directory = temp(t);
  const origin = path.join(directory, "origin"), checkout = path.join(directory, "checkout");
  fs.mkdirSync(origin);
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(origin, "init", "--initial-branch=main");
  git(origin, "config", "user.name", "Contract test");
  git(origin, "config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(origin, "trusted.txt"), "trusted base\n");
  git(origin, "add", "."); git(origin, "commit", "-m", "Base");
  const baseSha = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(origin, "trusted.txt"), "untrusted PR\n");
  fs.writeFileSync(path.join(origin, "untrusted.sh"), "exit 99\n");
  git(origin, "add", "."); git(origin, "commit", "-m", "Change");
  const headSha = git(origin, "rev-parse", "HEAD");
  git(origin, "update-ref", "refs/pull/1/head", headSha);
  git(directory, "clone", "--branch", "main", origin, checkout);
  const h = harness(makePR({ head: { sha: headSha }, base: { sha: baseSha, repo: { full_name: "owner/repo" } } }));
  await prepareReview({ ...h, context: { ...h.context, runId: "service-job", runAttempt: 2 },
    prNumber: "1", cwd: checkout, temp: directory, token: "test-token" });
  assert.equal(h.outputs.should_review, "true");
  assert.equal(fs.readFileSync(path.join(checkout, "trusted.txt"), "utf8"), "trusted base\n");
  assert.equal(fs.existsSync(path.join(checkout, "untrusted.sh")), false);
  assert.equal(git(checkout, "rev-parse", "HEAD"), baseSha);
  assert.equal(fs.readFileSync(path.join(checkout, ".git/config"), "utf8").includes("test-token"), false);
  const metadata = JSON.parse(fs.readFileSync(path.join(h.outputs.result_directory, "metadata.json")));
  assert.equal(metadata.head, headSha);
  assert.equal(metadata.merge_base, baseSha);
  assert.deepEqual({ ...metadata.telemetry, preparedAt: null }, {
    repository: "owner/repo", jobId: "service-job", attempt: 2, workspace: checkout, preparedAt: null,
  });
  assert.ok(Date.parse(metadata.telemetry.preparedAt));
  git(origin, "update-ref", "refs/pull/1/head", baseSha);
  await prepareReview({ ...h, prNumber: "1", cwd: checkout, temp: directory });
  assert.equal(h.outputs.should_review, "false");
});

test("runs the installed binary with native review flags and literal PR text", async (t) => {
  const directory = temp(t), h = harness();
  saveResult(directory);
  const binary = path.join(directory, "ocr");
  fs.writeFileSync(binary, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\nprocess.stderr.write('diagnostic');\n`, { mode: 0o700 });
  await runReview({ ...h, directory, binary, cwd: directory, model: "custom-codex", budget: "250000" });
  const args = JSON.parse(fs.readFileSync(path.join(directory, "result.json")));
  assert.equal(args[0], "review");
  for (const [flag, value] of [["--from", base], ["--to", head], ["--provider", "openai-codex"],
    ["--model", "custom-codex"], ["--max-tokens-budget", "250000"]]) {
    assert.equal(args[args.indexOf(flag) + 1], value);
  }
  assert.match(args[args.indexOf("--background") + 1], /\$\(touch/);
  assert.equal(fs.existsSync(path.join(directory, "should-not-exist")), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "exit-code.json"))), 0);
  assert.equal(fs.readFileSync(path.join(directory, "stderr.log"), "utf8"), "diagnostic");
  await runReview({ ...h, directory, binary: path.join(directory, "missing"), cwd: directory });
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "exit-code.json"))), 1);
  assert.match(fs.readFileSync(path.join(directory, "stderr.log"), "utf8"), /Could not run/);
});

test("publication skips changed PRs and rejects results for a different commit", async (t) => {
  const directory = temp(t);
  saveResult(directory);
  for (const pr of [makePR({ head: { sha: base } }), makePR({ state: "closed" }), makePR({ draft: true }),
    makePR({ base: { sha: head } })]) {
    await publishReview({ ...harness(pr), directory, post: async () => assert.fail("stale result published") });
  }
  const h = harness();
  saveResult(directory, { status: "complete", manifest: { input: { resolved_head: base } } });
  await publishReview({ ...h, directory, post: async () => assert.fail("wrong head published") });
  assert.match(h.failures[0], /different head/);
});

test("publisher uses sticky incremental comments and surfaces partial or failed runs", async (t) => {
  const directory = temp(t);
  for (const scenario of ["complete", "partial", "skipped", "process-failed", "post-failed", "summary-failed", "missing"]) {
    const h = harness();
    const state = ["partial", "skipped"].includes(scenario) ? scenario : "complete";
    saveResult(directory, { status: state, comments: [],
      manifest: { terminal_state: state, input: { resolved_head: head } } },
    scenario === "process-failed" ? 1 : 0);
    if (scenario === "missing") fs.unlinkSync(path.join(directory, "result.json"));
    let calls = 0;
    await publishReview({ ...h, directory, post: async (options) => {
      calls++;
      assert.equal(options.prNumber, 1);
      assert.equal(options.stickySummary, true);
      assert.equal(options.incremental, true);
      options.core.setOutput("comments_failed", scenario === "post-failed" ? 1 : 0);
      options.core.setOutput("summary_comment_url", scenario === "summary-failed" ? "" : "https://github.com/owner/repo/pull/1#issuecomment-1");
    } });
    assert.equal(calls, 1);
    assert.equal(h.failures.length, ["complete", "skipped"].includes(scenario) ? 0 : 1);
  }
});

test("real publisher shows an incomplete warning and a neutral skipped result", async (t) => {
  const directory = temp(t);
  process.env.OCR_READ_SUCCESS_DELAY = "0";
  for (const state of ["partial", "skipped"]) {
    const h = harness(), bodies = [];
    saveResult(directory, { status: state, comments: [],
      manifest: { terminal_state: state, input: { resolved_head: head } } });
    h.github.rest.users = { getAuthenticated: async () => ({ data: { login: "review-bot" } }) };
    h.github.rest.issues = {
      listComments: async () => ({ data: [], headers: {} }),
      createComment: async ({ body }) => { bodies.push(body); return { data: { id: 1, html_url: "https://github.com/owner/repo/pull/1#issuecomment-1" } }; },
    };
    await publishReview({ ...h, directory });
    assert.equal(bodies.length, 1);
    assert.doesNotMatch(bodies[0], /✅/);
    if (state === "partial") {
      assert.match(bodies[0], /incomplete review/);
      assert.doesNotMatch(bodies[0], /Looks good to me/);
      assert.equal(h.failures.length, 1);
    } else {
      assert.match(bodies[0], /No reviewable files/);
      assert.equal(h.failures.length, 0);
    }
  }
});

test("a finding published in the summary outside the diff is not a failed review", async (t) => {
  const directory = temp(t), h = harness();
  saveResult(directory);
  const result = await publishReview({ ...h, directory, post: async ({ core }) => {
    core.setOutput("comments_failed", "1");
    core.setOutput("publication_failures", "0");
    core.setOutput("summary_comment_url", "https://example.test/comment");
  } });
  assert.equal(result.incomplete, false);
  assert.equal(h.failures.length, 0);
});

test("cancel and timeout terminate a review child and save its unsuccessful exit", async (t) => {
  const directory = temp(t), h = harness();
  saveResult(directory);
  const binary = path.join(directory, "ocr");
  fs.writeFileSync(binary, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  await runReview({ ...h, directory, binary, cwd: directory, timeoutMs: 100 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "exit-code.json"))), 1);
  const controller = new AbortController();
  const running = runReview({ ...h, directory, binary, cwd: directory, signal: controller.signal });
  controller.abort();
  await running;
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "exit-code.json"))), 1);
});

test("native resume uses the pinned checkpoint range and falls back once only on admission rejection", async (t) => {
  const directory = temp(t), h = harness(), resume = "11111111-2222-3333-4444-555555555555";
  saveResult(directory);
  const file = path.join(directory, "metadata.json");
  const metadata = JSON.parse(fs.readFileSync(file));
  metadata.range = { mode: "checkpoint", from: "c".repeat(40), to: head };
  metadata.incrementalExclude = ["already-reviewed.go"];
  fs.writeFileSync(file, JSON.stringify(metadata));
  const binary = path.join(directory, "ocr");
  fs.writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
if (args.includes('--resume')) {
  process.stderr.write('Error: load resume session: missing session\\n'); process.exitCode = 1;
} else process.stdout.write('{}');
`, { mode: 0o700 });
  await runReview({ ...h, directory, binary, cwd: directory, resume });
  const calls = fs.readFileSync(path.join(directory, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][calls[0].indexOf("--resume") + 1], resume);
  assert.equal(calls[0][calls[0].indexOf("--from") + 1], metadata.range.from);
  assert.equal(calls[1].includes("--resume"), false);
  for (const call of calls) assert.equal(call[call.indexOf("--exclude") + 1], "already-reviewed.go");
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "exit-code.json"))), 0);
  assert.match(fs.readFileSync(path.join(directory, "resume-rejected-stderr.log"), "utf8"), /missing session/);
  fs.writeFileSync(binary, `#!${process.execPath}\nprocess.stderr.write('Error: review failed: server_is_overloaded'); process.exitCode = 1;\n`);
  await runReview({ ...h, directory, binary, cwd: directory, resume });
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "exit-code.json"))), 1);
  assert.match(fs.readFileSync(path.join(directory, "stderr.log"), "utf8"), /server_is_overloaded/);
});

test("a saved immutable snapshot can be prepared after the PR ref moves", async (t) => {
  const directory = temp(t);
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  git("commit", "--allow-empty", "-m", "Base");
  const baseSha = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-m", "Old head");
  const headSha = git("rev-parse", "HEAD");
  const snapshot = { number: 1, head: headSha, base: baseSha, base_ref: "main", background: "Original requirements" };
  const h = harness();
  h.github.rest.pulls.get = async () => assert.fail("Retry must not replace the saved input with current PR metadata");
  await prepareReview({ ...h, prNumber: 1, cwd: directory, temp: directory, snapshot,
    expectedHead: headSha, expectedBase: baseSha, checkoutBase: true });
  assert.equal(h.outputs.should_review, "true");
  const metadata = JSON.parse(fs.readFileSync(path.join(h.outputs.result_directory, "metadata.json")));
  assert.equal(metadata.head, headSha);
  assert.equal(metadata.merge_base, baseSha);
  assert.equal(metadata.background, snapshot.background);
  assert.equal(git("rev-parse", "HEAD"), baseSha);
});

test("overlapping shutdown and timeout send only one graceful signal to native OCR", async (t) => {
  const directory = temp(t), h = harness(), controller = new AbortController();
  saveResult(directory);
  const binary = path.join(directory, "ocr");
  fs.writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
process.on('SIGTERM', () => {
  fs.appendFileSync('signals', 'TERM\\n');
  setTimeout(() => process.exit(0), 250);
});
fs.writeFileSync('ready', 'yes');
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const running = runReview({ ...h, directory, binary, cwd: directory, timeoutMs: 1000, signal: controller.signal });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(directory, "signals"))) {
    assert.ok(Date.now() < deadline);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  controller.abort();
  await running;
  assert.equal(fs.readFileSync(path.join(directory, "signals"), "utf8"), "TERM\n");
});
