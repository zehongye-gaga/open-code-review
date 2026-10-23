// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { test } = require("node:test");
const { State } = require("./state.js");
const { ReviewService, configuration } = require("./service.js");
const { createServer } = require("./server.js");
const { createGitHub } = require("./github.js");
const { childEnvironment } = require("./review.js");
const { planReview } = require("./progress.js");

const repository = "owner/repo";
const head = "b".repeat(40), base = "a".repeat(40);
const sessionId = "11111111-2222-3333-4444-555555555555";
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for worker transition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function writeReport(directory, { state = "complete", comments = [], budgetExceeded = false } = {}) {
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, "metadata.json")));
  const item = { item_id: "file-1", fingerprint: "diff-1" };
  fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ status: state, session_id: sessionId, comments,
    summary: { budget_exceeded: budgetExceeded },
    manifest: { schema_version: "ocr.run-manifest/v1", operation: "review", run_id: sessionId, terminal_state: state,
      input: { mode: "range", resolved_base: metadata.range.from, resolved_head: metadata.head },
      coverage: { selected: [item], completed: state === "complete" ? [item] : [], reused: [],
        failed: state === "complete" ? [] : [item], waived: [] } } }));
  fs.writeFileSync(path.join(directory, "exit-code.json"), "0");
}
function prepareFixture(directory, pull, core, snapshot) {
  fs.writeFileSync(path.join(directory, "metadata.json"), JSON.stringify(snapshot || {
    number: pull.number, head: pull.head.sha, base: pull.base.sha, base_ref: pull.base.ref,
    merge_base: base, background: "Review this change" }));
  core.setOutput("should_review", "true"); core.setOutput("result_directory", directory);
}
function pr(overrides = {}) {
  return { number: 1, state: "open", draft: false, title: "Fix", head: { sha: head },
    base: { sha: base, ref: "main", repo: { full_name: repository } }, ...overrides };
}
function setup(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-service-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const current = { pr: pr() }, statuses = [];
  const binary = path.join(directory, "ocr");
  fs.writeFileSync(binary, "mock binary");
  const config = { stateDirectory: directory, binary, repositories: [{ name: repository, baseBranches: ["main"] }] };
  const github = { getToken: () => "test-token", rest: {
    pulls: { get: async () => ({ data: current.pr }), list: async () => ({ data: [current.pr] }) },
    repos: { createCommitStatus: async (p) => { statuses.push(p); return { data: {} }; } },
  } };
  const service = new ReviewService({ config, github, log: () => {},
    prepare: async ({ core, snapshot }) => { prepareFixture(directory, current.pr, core, snapshot); },
    run: async ({ directory }) => writeReport(directory),
    publish: async () => ({ summaryURL: "https://github.com/owner/repo/pull/1#issuecomment-1", comments: [], incomplete: false }),
    ...overrides });
  return { service, current, directory, statuses, github, config };
}

function parallelSetup(t, count = 5) {
  const h = setup(t), pulls = new Map(), running = new Map(), starts = [];
  h.service.config.prConcurrency = 4;
  for (let number = 1; number <= count; number++) pulls.set(number, pr({ number }));
  h.github.rest.pulls.get = async ({ pull_number }) => ({ data: pulls.get(pull_number) });
  h.github.rest.pulls.list = async () => ({ data: [...pulls.values()] });
  h.service.prepare = async ({ core, context, cwd, snapshot }) => {
    const number = context.issue.number;
    const directory = path.join(h.directory, "runs", `ocr-pr-${number}-${context.runId}`);
    fs.mkdirSync(directory, { recursive: true });
    prepareFixture(directory, pulls.get(number), core, snapshot);
    starts.push({ number, cwd, directory });
  };
  h.service.run = async ({ cwd, signal }) => {
    const entry = starts.findLast((entry) => entry.cwd === cwd);
    await new Promise((resolve) => running.set(entry.number, { resolve, signal }));
    writeReport(entry.directory);
  };
  for (const pull of pulls.values()) h.service.accept(repository, pull);
  return { ...h, pulls, running, starts };
}

test("four isolated workers fill freed slots without exceeding the limit or duplicating jobs", async (t) => {
  const h = parallelSetup(t);
  const first = h.service.tick();
  await until(() => h.running.size === 4);
  assert.equal(h.running.size, 4);
  assert.equal(new Set(h.starts.map((entry) => entry.cwd)).size, 4);
  assert.equal(h.service.state.data.jobs.filter((job) => job.state === "queued").length, 1);
  await Promise.all([h.service.tick(), h.service.tick()]);
  assert.equal(h.starts.length, 4);
  h.running.get(2).resolve();
  await until(() => h.service.workers.size === 3);
  const next = h.service.tick();
  await until(() => h.running.size === 5);
  assert.equal(h.starts.length, 5);
  assert.equal(h.starts[4].cwd, h.starts[1].cwd);
  assert.equal(h.service.workers.size, 4);
  for (const entry of h.running.values()) entry.resolve();
  await Promise.all([first, next]);
  assert.equal(h.service.workers.size, 0);
  assert.ok(h.service.state.data.jobs.every((job) => job.state === "complete"));
  assert.equal(h.statuses.filter((s) => s.state === "success").length, 5);
});

test("a superseded PR waits for its old worker to exit without cancelling unrelated PRs", async (t) => {
  const h = parallelSetup(t, 2), first = h.service.tick();
  await until(() => h.running.size === 2);
  const old = h.running.get(1), other = h.running.get(2);
  const updated = pr({ head: { sha: "c".repeat(40) } });
  h.pulls.set(1, updated);
  const replacement = h.service.accept(repository, updated);
  assert.equal(old.signal.aborted, false);
  assert.equal(other.signal.aborted, false);
  await h.service.tick();
  assert.equal(h.starts.length, 2);
  assert.equal(replacement.state, "queued");
  old.resolve();
  await until(() => h.service.workers.size === 1);
  const next = h.service.tick();
  await until(() => h.running.get(1) !== old);
  assert.equal(h.starts.length, 3);
  h.running.get(1).resolve(); other.resolve();
  await Promise.all([first, next]);
  assert.equal(h.service.state.data.jobs[0].state, "checkpointed");
  assert.equal(replacement.state, "complete");
  assert.equal(h.statuses.filter((s) => s.state === "success" && s.sha === updated.head.sha).length, 1);
});

test("shutdown aborts and durably requeues all parallel workers without consuming attempts", async (t) => {
  const h = parallelSetup(t, 4), pending = h.service.tick();
  await until(() => h.running.size === 4);
  h.service.stop();
  for (const entry of h.running.values()) { assert.equal(entry.signal.aborted, true); entry.resolve(); }
  await pending;
  const recovered = new State(h.directory);
  assert.equal(recovered.data.jobs.length, 4);
  assert.ok(recovered.data.jobs.every((job) => job.state === "queued" && job.attempt === 0));
  assert.equal(h.service.active, null);
});

test("health lists all active PRs and concurrency configuration is validated", async (t) => {
  const h = parallelSetup(t, 4), pending = h.service.tick();
  await until(() => h.running.size === 4);
  h.service.lastPoll = new Date().toISOString();
  const server = createServer(h.service);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
  const health = await response.json();
  assert.equal(health.running, 4);
  assert.equal(health.prConcurrency, 4);
  assert.deepEqual(health.activeJobs.map((job) => job.number), [1, 2, 3, 4]);
  assert.equal(health.active, health.activeJobs[0].id);
  for (const entry of h.running.values()) entry.resolve();
  await pending;
  assert.equal(configuration(h.config).prConcurrency, 1);
  for (const value of [0, -1, 1.5, "4", null, Infinity]) {
    assert.throws(() => configuration({ ...h.config, prConcurrency: value }), /prConcurrency/);
  }
});

test("durable queue deduplicates head/base, coalesces updates and recovers an interrupted worker", (t) => {
  const { service, directory } = setup(t);
  const first = service.accept(repository, pr());
  assert.equal(service.accept(repository, pr()), null);
  first.state = "running"; first.attempt = 1; service.state.save();
  const restarted = new State(directory);
  assert.equal(restarted.next().id, first.id);
  assert.equal(restarted.next().state, "queued");
  const updated = restarted.enqueue(repository, pr({ head: { sha: "c".repeat(40) } }));
  assert.equal(restarted.data.jobs[0].state, "superseded");
  assert.equal(restarted.next().id, updated.id);
  assert.equal(fs.statSync(path.join(directory, "state.json")).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(directory, "state.json"), "broken");
  assert.throws(() => new State(directory), SyntaxError);
});

test("polling seeds existing heads only once and detects new commits without workflows", async (t) => {
  const h = setup(t);
  h.service.config.bootstrapExisting = false;
  await h.service.poll();
  assert.equal(h.service.state.data.jobs.length, 0);
  h.current.pr = pr({ head: { sha: "c".repeat(40) } });
  await h.service.poll();
  assert.equal(h.service.state.data.jobs.length, 1);
  await h.service.poll();
  assert.equal(h.service.state.data.jobs.length, 1);
  h.current.pr.draft = true;
  await h.service.poll();
  assert.equal(h.service.state.data.jobs[0].state, "superseded");
  h.current.pr.draft = false;
  await h.service.poll();
  assert.equal(h.service.state.data.jobs.length, 2);
  assert.ok(h.service.lastPoll);
});

test("complete reviews publish exact-head statuses and apply the configured severity policy", async (t) => {
  const h = setup(t);
  h.service.accept(repository, pr());
  await h.service.tick();
  assert.deepEqual(h.statuses.map((s) => s.state), ["pending", "pending", "success"]);
  assert.ok(h.statuses.every((s) => s.sha === head && s.context === "ocr-review"));
  assert.equal(h.service.state.data.jobs[0].state, "complete");
  h.service.publish = async () => ({ summaryURL: "https://example.test/comment", comments: [{ severity: "high" }] });
  h.service.accept(repository, pr(), { force: true });
  await h.service.tick();
  assert.equal(h.statuses.at(-1).state, "failure");
  assert.equal(h.service.state.data.jobs.at(-1).state, "complete");
});

test("failures retry with backoff and stop at the cap; a restart retains that decision", async (t) => {
  const h = setup(t, { run: async () => { throw new Error("provider unavailable"); } });
  h.service.config.maxAttempts = 2;
  const job = h.service.accept(repository, pr());
  await h.service.tick();
  assert.equal(job.state, "queued");
  assert.ok(job.nextAt > Date.now());
  assert.equal(h.service.state.next(), undefined);
  job.nextAt = 0;
  await h.service.tick();
  assert.equal(job.state, "failed");
  assert.equal(job.attempt, 2);
  assert.equal(h.statuses.at(-1).state, "error");
  assert.equal(new State(h.directory).next(), undefined);
});

test("new pushes preserve active work and its checkpoint, coalescing only waiting heads", async (t) => {
  const h = setup(t);
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let finish, oldSignal;
  h.service.run = async ({ signal, directory }) => {
    oldSignal = signal;
    started();
    await new Promise((resolve) => { finish = resolve; });
    writeReport(directory);
  };
  h.service.publish = async () => assert.fail("superseded result published");
  const first = h.service.accept(repository, pr());
  const running = h.service.tick();
  await ready;
  h.current.pr = pr({ head: { sha: "c".repeat(40) } });
  const intermediate = h.service.accept(repository, h.current.pr);
  h.current.pr = pr({ head: { sha: "d".repeat(40) } });
  const next = h.service.accept(repository, h.current.pr);
  assert.equal(intermediate.state, "superseded");
  assert.equal(oldSignal.aborted, false);
  assert.equal(first.state, "running");
  finish();
  await running;
  assert.equal(first.state, "checkpointed");
  assert.equal(h.service.state.next().id, next.id);
  assert.equal(h.service.state.data.checkpoints[first.key].payload.head, head);
  assert.deepEqual(h.statuses.map((s) => s.state), ["pending", "pending"]);
});

test("graceful shutdown requeues interrupted work without consuming a retry", async (t) => {
  const h = setup(t);
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  h.service.run = async ({ signal }) => { started(); await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })); };
  const job = h.service.accept(repository, pr());
  const running = h.service.tick(); await ready;
  h.service.stop(); await running;
  assert.equal(job.state, "queued");
  assert.equal(job.attempt, 0);
  assert.equal(new State(h.directory).next().id, job.id);
});

test("a stale PR before execution or publication cannot set a successful status", async (t) => {
  const h = setup(t);
  const job = h.service.accept(repository, pr());
  h.current.pr = pr({ head: { sha: "c".repeat(40) } });
  await h.service.tick();
  assert.equal(job.state, "superseded");
  assert.ok(h.statuses.every((s) => s.state === "pending"));
  h.service.publish = async () => {
    h.current.pr.state = "closed";
    return { comments: [], summaryURL: "https://example.test/comment" };
  };
  await h.service.tick();
  assert.ok(h.statuses.every((s) => s.state !== "success"));
});

test("HTTP API requires a bearer token and webhook signatures; only allowlisted PRs are queued", async (t) => {
  const h = setup(t);
  const server = createServer(h.service, { apiToken: "api-test", webhookSecret: "webhook-test" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url + "/healthz")).status, 503);
  h.service.lastPoll = new Date().toISOString();
  assert.equal((await fetch(url + "/healthz")).status, 200);
  assert.equal((await fetch(url + "/v1/jobs")).status, 401);
  const headers = { authorization: "Bearer api-test", "content-type": "application/json" };
  assert.equal((await fetch(url + "/v1/reviews", { method: "POST", headers,
    body: JSON.stringify({ repository: "other/repo", pull_number: 1 }) })).status, 400);
  const body = JSON.stringify({ action: "opened", repository: { full_name: repository }, pull_request: { number: 1 } });
  assert.equal((await fetch(url + "/webhooks/github", { method: "POST", body })).status, 401);
  const signature = "sha256=" + crypto.createHmac("sha256", "webhook-test").update(body).digest("hex");
  const response = await fetch(url + "/webhooks/github", { method: "POST", body,
    headers: { "x-github-event": "pull_request", "x-hub-signature-256": signature } });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).queued, true);
  assert.equal((await (await fetch(url + "/v1/jobs", { headers })).json()).length, 1);
  const again = await fetch(url + "/webhooks/github", { method: "POST", body,
    headers: { "x-github-event": "pull_request", "x-hub-signature-256": signature } });
  assert.equal((await again.json()).queued, false);
});

test("GitHub transport has the publisher's wire contract and reloads rotated credentials", async (t) => {
  const h = setup(t), tokenFile = path.join(h.directory, "token");
  fs.writeFileSync(tokenFile, "first");
  const calls = [];
  const github = createGitHub({ tokenFile, fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    return new Response(JSON.stringify({ id: 1 }), { status: 200, headers: { "x-ratelimit-remaining": "99" } });
  } });
  const p = { owner: "owner", repo: "repo", pull_number: 42 };
  await github.rest.pulls.createReview({ ...p, commit_id: head, event: "COMMENT", body: "review", comments: [] });
  assert.equal(calls[0].url, "https://api.github.com/repos/owner/repo/pulls/42/reviews");
  assert.deepEqual(JSON.parse(calls[0].body), { commit_id: head, event: "COMMENT", body: "review", comments: [] });
  fs.writeFileSync(tokenFile, "second");
  await github.rest.issues.updateComment({ ...p, comment_id: 123, body: "updated" });
  assert.equal(calls[1].headers.authorization, "Bearer second");
  assert.equal(calls[1].redirect, "error");
  const failing = createGitHub({ token: "test", fetchImpl: async () => new Response(JSON.stringify({ message: "rate limited" }),
    { status: 429, headers: { "retry-after": "60" } }) });
  await assert.rejects(failing.rest.pulls.get(p), (error) => error.status === 429 && error.response.headers["retry-after"] === "60");
});

test("review children receive only model/runtime variables and configuration rejects unsafe repos", () => {
  assert.deepEqual(childEnvironment({ HOME: "/home/ocr", CODEX_HOME: "/auth", PATH: "/bin", OCR_LLM_TOKEN: "model",
    GH_TOKEN: "github", AWS_SECRET_ACCESS_KEY: "secret", OCR_SERVICE_API_TOKEN: "control", GIT_CONFIG_VALUE_0: "git" }),
  { HOME: "/home/ocr", CODEX_HOME: "/auth", PATH: "/bin", OCR_LLM_TOKEN: "model" });
  assert.throws(() => configuration({ stateDirectory: "/data/ocr", repositories: [{ name: "../../tmp", baseBranches: ["main"] }] }), /unique owner/);
});

test("a delayed queued status cannot overwrite the final review status", async (t) => {
  const h = setup(t), delivered = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  h.github.rest.repos.createCommitStatus = async (value) => {
    if (value.description.startsWith("OCR queued")) await blocked;
    delivered.push(value.state);
  };
  const job = h.service.accept(repository, pr());
  const flushing = h.service.flushStatuses();
  const running = h.service.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(job.state, "queued");
  release();
  await Promise.all([flushing, running]);
  assert.deepEqual(delivered, ["pending", "pending", "success"]);
  assert.equal(job.state, "complete");
});

test("persistence failure clears the active slot and propagates for supervisor restart", async (t) => {
  const h = setup(t);
  h.service.accept(repository, pr());
  h.service.execute = async () => {
    h.service.state.save = () => { throw Object.assign(new Error("ENOSPC"), { persistence: true }); };
    return { stale: false };
  };
  await assert.rejects(h.service.tick(), (error) => error.persistence === true);
  assert.equal(h.service.active, null);
});

test("base advancement preserves completed head reviews but refreshes queued review ranges", async (t) => {
  const h = setup(t);
  const first = h.service.accept(repository, pr());
  await h.service.tick();
  const changed = pr({ base: { ...pr().base, sha: "c".repeat(40) } });
  assert.equal(h.service.accept("OWNER/REPO", changed), null);
  assert.equal(first.state, "complete");
  const queued = h.service.accept(repository, changed, { force: true });
  const next = h.service.accept(repository, pr({ base: { ...pr().base, sha: "d".repeat(40) } }));
  assert.equal(queued.state, "superseded");
  assert.equal(next.base, "d".repeat(40));
});

test("token-budget exhaustion reports an error without repeating the same paid review", async (t) => {
  const h = setup(t, { publish: async () => ({ incomplete: true, budgetExceeded: true,
    comments: [], summaryURL: "https://example.test/comment" }) });
  const job = h.service.accept(repository, pr());
  await h.service.tick();
  assert.equal(job.state, "failed");
  assert.equal(job.attempt, 1);
  assert.match(h.statuses.at(-1).description, /Token budget guard/);
  assert.equal(h.service.state.next(), undefined);
});

test("a failed old snapshot resumes after restart before the coalesced new head can run", async (t) => {
  const h = setup(t);
  const old = h.service.accept(repository, pr());
  h.service.run = async ({ directory }) => {
    writeReport(directory, { state: "partial" });
    h.current.pr = pr({ head: { sha: "c".repeat(40) } });
    h.service.accept(repository, h.current.pr);
  };
  h.service.publish = async () => assert.fail("An old snapshot must not publish");
  await h.service.tick();
  assert.equal(old.state, "queued");
  assert.equal(old.progress.sessionId, sessionId);
  assert.equal(old.progress.complete, false);
  assert.equal(h.service.state.data.checkpoints[old.key], undefined);
  assert.equal(h.service.state.next(), undefined, "The newer head waits through the old snapshot's backoff");
  h.service.state = new State(h.directory);
  const recovered = h.service.state.data.jobs[0];
  recovered.nextAt = 0;
  h.service.run = async ({ resume, directory }) => {
    assert.equal(resume, sessionId);
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, "metadata.json")));
    assert.equal(metadata.head, head);
    assert.equal(metadata.range.from, base);
    writeReport(directory);
  };
  await h.service.tick();
  assert.equal(recovered.state, "checkpointed");
  assert.equal(h.service.state.data.checkpoints[recovered.key].payload.head, head);
  assert.equal(h.service.state.next().head, "c".repeat(40));
});

test("a resumable snapshot keeps its worker slot even when lower slots are free", async (t) => {
  const h = setup(t);
  h.service.config.prConcurrency = 4;
  const job = h.service.accept(repository, pr());
  job.snapshot = { number: 1, head, base, base_ref: "main", merge_base: base, background: "Review this change" };
  job.slot = 2;
  h.service.run = async ({ directory, cwd }) => {
    assert.match(cwd, /worker-repositories\/2\/owner\/repo$/);
    writeReport(directory);
  };
  await h.service.tick();
  assert.equal(job.state, "complete");
  assert.equal(job.slot, 2);
  assert.ok(job.progress.sessionId);
});

test("publication retries reuse a complete report without another model call", async (t) => {
  const h = setup(t);
  let executions = 0, publications = 0;
  h.service.run = async ({ directory }) => { executions++; writeReport(directory); };
  h.service.publish = async () => {
    if (++publications === 1) throw new Error("GitHub unavailable");
    return { comments: [], summaryURL: "https://example.test/summary" };
  };
  const job = h.service.accept(repository, pr());
  await h.service.tick();
  assert.equal(job.state, "queued");
  job.nextAt = 0;
  await h.service.tick();
  assert.equal(job.state, "complete");
  assert.equal(executions, 1);
  assert.equal(publications, 2);
});

test("a moving base is coalesced once while its original snapshot continues", (t) => {
  const h = setup(t), job = h.service.accept(repository, pr());
  job.state = "running";
  const changed = pr({ base: { ...pr().base, sha: "d".repeat(40) } });
  const next = h.service.accept(repository, changed);
  assert.equal(job.state, "running");
  for (let i = 0; i < 3; i++) assert.equal(h.service.accept(repository, changed), null);
  assert.equal(h.service.state.data.jobs.length, 2);
  assert.equal(next.state, "queued");
});

test("restart recovers closed native artifacts even if progress was not persisted", async (t) => {
  const h = setup(t), job = h.service.accept(repository, pr());
  job.workspace = path.join(h.directory, "repositories", "owner", "repo");
  fs.mkdirSync(job.workspace, { recursive: true });
  job.directory = path.join(h.directory, "runs", "ocr-pr-crashed");
  fs.mkdirSync(job.directory);
  prepareFixture(job.directory, h.current.pr, { setOutput() {} });
  const planned = await planReview({ config: h.service.config, job, directory: job.directory, cwd: job.workspace });
  job.snapshot = planned.metadata; job.slot = 0; job.state = "running";
  writeReport(job.directory);
  h.service.state.save();
  h.service.state = new State(h.directory);
  h.service.run = async () => assert.fail("A closed complete report should be recovered without rerunning OCR");
  await h.service.tick();
  const recovered = h.service.state.data.jobs[0];
  assert.equal(recovered.state, "complete");
  assert.equal(recovered.progress.sessionId, sessionId);
  assert.equal(recovered.directory, job.directory);
  assert.equal(h.service.state.data.checkpoints[job.key].payload.head, head);
});

test("retargeting to an allowed branch with the same base SHA cannot publish the old snapshot", async (t) => {
  const h = setup(t), job = h.service.accept(repository, pr());
  h.service.config.repositories[0].baseBranches.push("release");
  h.service.run = async ({ directory }) => {
    writeReport(directory);
    h.current.pr = pr({ base: { ...pr().base, ref: "release" } });
  };
  h.service.publish = async () => assert.fail("The previous target branch must not be published");
  await h.service.tick();
  assert.equal(job.state, "checkpointed");
  assert.equal(h.service.state.next().baseRef, "release");
  assert.ok(h.statuses.every((status) => status.state !== "success"));
});


test("budget guard raises the persisted attempt budget within policy then stops at its ceiling", async (t) => {
  const { resolveOptions } = require("./options.js");
  const h = setup(t);
  h.service.config.infrastructure = { dispatchEnabled: true, budgetRetry: { enabled: true, maxRetries: 2, multiplier: 2 },
    limits: { budget: 800000 }, clients: [{ id: "dispatcher", role: "dispatcher", repositories: [repository] }] };
  const settings = resolveOptions(h.service.config, h.service.repo(repository));
  const job = h.service.accept(repository, pr(), { settings, requestedBy: "dispatcher" });
  const original = JSON.stringify(settings), budgets = [], resumes = [];
  h.service.run = async ({ directory, budget, resume }) => {
    budgets.push(budget); resumes.push(resume); writeReport(directory, { state: "partial", budgetExceeded: true });
  };
  h.service.publish = async () => assert.fail("Budget warnings and partial findings must not be published");
  await h.service.tick();
  assert.equal(job.state, "queued"); assert.equal(job.retryBudget, 400000);
  assert.equal(h.statuses.at(-1).state, "pending");
  const saved = JSON.parse(fs.readFileSync(h.service.state.file)).jobs[0];
  assert.equal(saved.retryBudget, 400000); assert.equal(saved.budgetRetries.length, 1);
  job.nextAt = 0; await h.service.tick();
  assert.equal(job.state, "queued"); assert.equal(job.retryBudget, 800000);
  job.nextAt = 0; await h.service.tick();
  assert.equal(job.state, "failed"); assert.equal(job.budgetRetries.length, 2);
  assert.deepEqual(budgets, [200000, 400000, 800000]);
  assert.deepEqual(resumes, [undefined, sessionId, sessionId]);
  assert.equal(JSON.stringify(job.settings), original);
  assert.equal(h.statuses.at(-1).state, "error");
});

test("a budget retry does not review an obsolete PR head", async (t) => {
  const { resolveOptions } = require("./options.js");
  const h = setup(t);
  h.service.config.infrastructure = { externalDispatch: true, dispatchEnabled: true,
    budgetRetry: { enabled: true, maxRetries: 2, multiplier: 2 },
    clients: [{ id: "dispatcher", role: "dispatcher", repositories: [repository] }] };
  const job = h.service.accept(repository, pr(), { settings: resolveOptions(h.service.config, h.service.repo(repository)), requestedBy: "dispatcher" });
  h.service.run = async ({ directory }) => writeReport(directory, { state: "partial", budgetExceeded: true });
  h.service.publish = async () => assert.fail("Budget warnings must not be published");
  await h.service.tick();
  h.current.pr = pr({ head: { sha: "c".repeat(40) } });
  h.service.run = async () => assert.fail("Stale retry must not invoke OCR");
  job.nextAt = 0; await h.service.tick();
  assert.equal(job.state, "superseded");
});

test("budget retry completes at the increased budget without mutating the agent request", async (t) => {
  const { resolveOptions } = require("./options.js");
  const h = setup(t);
  h.service.config.infrastructure = { dispatchEnabled: true, budgetRetry: { enabled: true, maxRetries: 2, multiplier: 2 },
    limits: { budget: 2000000 }, clients: [{ id: "agent", role: "agent", repositories: [repository] }] };
  const job = h.service.accept(repository, pr(), { settings: resolveOptions(h.service.config, h.service.repo(repository), "deep"), requestedBy: "agent" });
  let runs = 0, publications = 0;
  h.service.run = async ({ directory }) => {
    runs++;
    writeReport(directory, { state: runs === 1 ? "partial" : "complete", budgetExceeded: runs === 1 });
  };
  h.service.publish = async () => { publications++; return { comments: [] }; };
  await h.service.tick();
  assert.equal(job.retryBudget, 1000000);
  assert.equal(publications, 0);
  job.nextAt = 0; await h.service.tick();
  assert.equal(job.state, "complete");
  assert.equal(publications, 1);
  assert.equal(job.settings.options.budget, 500000);
  assert.equal(job.budgetRetries.length, 1);
  assert.equal(h.statuses.at(-1).state, "success");
});

test("incomplete native findings stay private through retries and terminal failure", async (t) => {
  const h = setup(t), job = h.service.accept(repository, pr());
  h.service.run = async ({ directory }) => writeReport(directory, { state: "partial",
    comments: [{ file: "partial.js", severity: "high", message: "Unfinished investigation" }] });
  h.service.publish = async () => assert.fail("An incomplete run cannot publish review comments");
  for (let i = 0; i < h.service.config.maxAttempts; i++) {
    job.nextAt = 0;
    await h.service.tick();
  }
  assert.equal(job.state, "failed");
  assert.equal(h.statuses.at(-1).state, "error");
  assert.ok(h.statuses.every((status) => status.state !== "success"));
  assert.match(job.error, /Native review incomplete/);
});

test("unlimited budgets and revoked clients cannot trigger budget escalation runs", async (t) => {
  const { resolveOptions } = require("./options.js");
  const h = setup(t);
  h.service.config.infrastructure = { dispatchEnabled: true, allowUnlimitedBudget: true,
    budgetRetry: { enabled: true, maxRetries: 2, multiplier: 2 }, clients: [] };
  const job = h.service.accept(repository, pr(), { settings: resolveOptions(h.service.config, h.service.repo(repository), "standard", { budget: 0 }), requestedBy: "revoked" });
  assert.equal(h.service.increaseRetryBudget(job), false);
  job.retryBudget = 400000;
  h.service.run = async () => assert.fail("Revoked client must not run OCR");
  await h.service.tick();
  assert.equal(job.state, "failed");
  assert.match(job.error, /no longer authorized/);
});


test("Git fetch credentials are separate from the GitHub API credential", async (t) => {
  const h = setup(t);
  const tokenFile = path.join(h.directory, "git-token");
  fs.writeFileSync(tokenFile, "fetch-only-token\n");
  h.service.config.gitTokenFile = tokenFile;
  const prepare = h.service.prepare;
  h.service.prepare = async (args) => {
    assert.equal(args.token, "fetch-only-token");
    assert.equal(args.github.getToken(), "test-token");
    return prepare(args);
  };
  const job = h.service.accept(repository, pr());
  await h.service.tick();
  assert.equal(job.state, "complete");
});
