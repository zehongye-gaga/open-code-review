// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { tracked, historyResult, connectionState } = require("./monitor-web/monitor-view.js");
const { Monitor, ReportCache, joinPulls, githubPulls, getHealth, unitStatus } = require("./monitor-data.js");
const { createMonitorServer } = require("./monitor.js");

const at = "2026-10-15T10:00:00.000Z";
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-monitor-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { stateDirectory: root, repositories: [{ name: "org/repo", baseBranches: ["main"] }],
    githubTokenFile: path.join(root, "github-token"), prConcurrency: 4, budget: 0, model: "test-model", blockSeverity: "low" };
  write(path.join(root, "config.json"), config);
  fs.writeFileSync(config.githubTokenFile, "private-github-token");
  write(path.join(root, "state.json"), { version: 1, jobs: [] });
  write(path.join(root, "cr", "state.json"), { version: 1, reviews: {} });
  write(path.join(root, "cr", "current-open-pr-snapshot.json"), { captured_at: at });
  const options = { ocrConfig: path.join(root, "config.json"), cragent: { concurrency: 4,
    states: [{ repository: "org/repo", file: path.join(root, "cr", "state.json") }] } };
  let now = Date.parse(at);
  const dependencies = { now: () => now, unit: async () => ({ state: "active", pid: 123, memoryBytes: 1024 }),
    health: async () => ({ reachable: true, ok: true, lastPoll: at, running: null, queued: null }),
    github: async () => ({ pulls: [pull(1)], remaining: 100 }), resources: () => ({ volumes: [] }) };
  return { root, config, options, dependencies, advance: (ms) => { now += ms; } };
}

function pull(number, contexts = [], head = "new-head") {
  return { repository: "org/repo", number, title: "<script>untrusted title</script>", url: `https://github.com/org/repo/pull/${number}`,
    headRefOid: head, baseRefName: "main", isDraft: false, updatedAt: at,
    commits: { nodes: [{ commit: { oid: head, status: { contexts } } }] } };
}

test("PR status uses the current head and never treats missing reviews as success", () => {
  const config = { repositories: [{ name: "org/repo", baseBranches: ["main"] }] };
  const prs = [pull(1), pull(2, [{ context: "ocr-review", state: "FAILURE", createdAt: at, targetUrl: "javascript:alert(1)" }]),
    { ...pull(3), isDraft: true }, { ...pull(4), baseRefName: "elsewhere" }];
  const rows = joinPulls(prs, config, [{ repository: "org/repo", number: 1, head: "old-head", state: "complete", findings: 0 }], []);
  assert.equal(rows[0].ocr.state, "missing"); assert.equal(rows[0].ocr.jobState, null);
  assert.equal(rows[1].ocr.state, "failure"); assert.equal(rows[1].ocr.url, null);
  assert.equal(rows[2].inScope, false); assert.equal(rows[3].inScope, false);
  prs[1].commits.nodes[0].commit.oid = "old-head";
  assert.equal(joinPulls(prs, config, [], [])[1].ocr.state, "missing");
});

test("collects four worker slots, checkpoints, retry queues and report usage without exposing source content", async (t) => {
  const f = fixture(t), jobs = [0, 1, 2, 3].map((slot) => ({ id: slot, repository: "org/repo", number: slot + 1,
    head: "new-head", state: "running", slot, attempt: 1, startedAt: at, createdAt: at, error: "private trace" }));
  jobs.push({ id: 5, repository: "org/repo", number: 5, head: "x", state: "queued", attempt: 2, nextAt: Date.parse(at) + 60000, progress: { sessionId: "secret-session", selected: 10, complete: 6 } });
  jobs.push({ id: 6, repository: "org/repo", number: 6, head: "y", state: "complete", updatedAt: at,
    directory: path.join(f.root, "runs", "six"), result: { findings: 2, blocking: 1, summaryURL: "https://github.com/org/repo/pull/6" } });
  jobs.push({ id: 7, repository: "org/repo", number: 7, head: "z", state: "checkpointed", updatedAt: at,
    directory: path.join(f.root, "runs", "seven"), range: { mode: "checkpoint" } });
  for (const job of jobs.slice(-2)) write(path.join(job.directory, "result.json"), { summary: { total_tokens: 120, input_tokens: 100, output_tokens: 20, cache_read_tokens: 50 }, comments: [{ content: "private code" }] });
  write(path.join(f.root, "state.json"), { version: 1, jobs });
  write(path.join(f.root, "cr", "state.json"), { reviews: { first: { pr: { number: 9, head: { sha: "cr-head" } }, status: "publishing", updated_at: at, last_error: "secret-error" },
    second: { pr: { number: 10, head: { sha: "cr-head" } }, status: "error_publish_pending", updated_at: at } } });
  const monitor = new Monitor(f.options, f.dependencies); await monitor.collect(); await monitor.refreshGitHub();
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.services.ocr.running, 4); assert.equal(snapshot.services.ocr.queued, 1);
  assert.equal(snapshot.services.cragent.running, 1); assert.equal(snapshot.services.cragent.queued, 1);
  assert.equal(snapshot.work.length, 7); assert.equal(snapshot.services.ocr.healthy, true);
  assert.equal(snapshot.usage.totalTokens, 240); assert.equal(snapshot.usage.cacheReadTokens, 100);
  assert.equal(snapshot.history.length, 2); assert.equal(snapshot.history[0].findings, 2);
  assert.equal(snapshot.history[0].blocking, 1);
  const text = JSON.stringify(snapshot);
  for (const secret of ["private trace", "private code", "secret-session", "secret-error", "private-github-token", f.root]) assert.equal(text.includes(secret), false);
  f.advance(200000); assert.equal(monitor.snapshot().stale, true); assert.equal(monitor.snapshot().github.stale, true);
  assert.equal(monitor.snapshot().services.ocr.healthy, false);
});

test("unreadable state retains previous rows and visibly degrades rather than clearing the queue", async (t) => {
  const f = fixture(t);
  write(path.join(f.root, "state.json"), { version: 1, jobs: [{ id: 1, state: "running", number: 1, repository: "org/repo", head: "x", startedAt: at }] });
  const monitor = new Monitor(f.options, f.dependencies); await monitor.collect();
  fs.writeFileSync(path.join(f.root, "state.json"), "{broken"); await monitor.collect();
  assert.equal(monitor.snapshot().services.ocr.sourceError, true);
  assert.equal(monitor.snapshot().services.ocr.healthy, false);
  assert.equal(monitor.snapshot().work.length, 1);
  fs.writeFileSync(path.join(f.root, "cr", "state.json"), "null"); await monitor.collect();
  assert.equal(monitor.snapshot().services.cragent.healthy, false);
});

test("mixed-case configuration matches canonical persisted repository names", async (t) => {
  const f = fixture(t);
  f.config.repositories[0].name = "Org/Repo";
  write(f.options.ocrConfig, f.config);
  write(path.join(f.root, "state.json"), { version: 1, jobs: [{ id: 1, repository: "org/repo", number: 1, head: "new-head", state: "queued", attempt: 2 }] });
  f.dependencies.github = async (config) => { assert.equal(config.repositories[0].name, "org/repo"); return { pulls: [pull(1)] }; };
  const monitor = new Monitor(f.options, f.dependencies); await monitor.collect(); await monitor.refreshGitHub();
  assert.equal(monitor.snapshot().pulls[0].ocr.jobState, "queued");
  assert.equal(monitor.snapshot().pulls[0].ocr.attempt, 2);
});

test("one fresh CR Agent source cannot mask a stalled or missing source heartbeat", async (t) => {
  const f = fixture(t);
  const stale = path.join(f.root, "cr-stale", "state.json");
  write(stale, { reviews: {} });
  write(path.join(path.dirname(stale), "current-open-pr-snapshot.json"), { captured_at: "2026-10-15T09:00:00Z" });
  f.options.cragent.states.push({ name: "stalled", repository: "org/repo", file: stale });
  const monitor = new Monitor(f.options, f.dependencies); await monitor.collect();
  assert.equal(monitor.snapshot().services.cragent.healthy, false);
  assert.equal(monitor.snapshot().services.cragent.sources.find((s) => s.name === "stalled").stale, true);
  write(path.join(path.dirname(stale), "current-open-pr-snapshot.json"), {}); await monitor.collect();
  assert.equal(monitor.snapshot().services.cragent.healthy, false);
  write(path.join(path.dirname(stale), "current-open-pr-snapshot.json"), { captured_at: at }); await monitor.collect();
  assert.equal(monitor.snapshot().services.cragent.healthy, true);
});

test("default dashboard includes CR Agent failures, pending jobs and recent checks on old PRs", () => {
  const pr = { updatedAt: "2026-01-01T00:00:00Z", ocr: { state: "missing", jobState: null }, cragent: { state: "failure" } };
  assert.equal(tracked(pr, Date.parse(at)), true);
  pr.cragent.state = "pending"; assert.equal(tracked(pr, Date.parse(at)), true);
  pr.cragent.state = "success"; pr.cragent.updatedAt = at; assert.equal(tracked(pr, Date.parse(at)), true);
  pr.cragent.updatedAt = pr.updatedAt; assert.equal(tracked(pr, Date.parse(at)), false);
  assert.equal(historyResult({ state: "complete", findings: null }), "neutral");
  assert.equal(historyResult({ state: "complete", findings: 0, blocking: 0 }), "success");
  assert.equal(historyResult({ state: "complete", findings: 2, blocking: 0 }), "success");
  assert.equal(historyResult({ state: "complete", findings: 2, blocking: 2 }), "failure");
  assert.equal(historyResult({ state: "complete", findings: 2 }), "neutral");
});

test("one failed CR Agent state or heartbeat does not freeze other sources' jobs", async (t) => {
  const f = fixture(t), second = path.join(f.root, "second", "state.json");
  const review = (number, status) => ({ pr: { number, head: { sha: "new-head" } }, status, updated_at: at });
  write(second, { reviews: { second: review(2, "queued") } });
  write(path.join(path.dirname(second), "current-open-pr-snapshot.json"), { captured_at: at });
  write(path.join(f.root, "cr", "state.json"), { reviews: { first: review(1, "queued") } });
  f.options.cragent.states.push({ name: "second", repository: "org/repo", file: second });
  const monitor = new Monitor(f.options, f.dependencies); await monitor.collect();
  fs.writeFileSync(second, "invalid");
  write(path.join(f.root, "cr", "state.json"), { reviews: { first: review(1, "running") } });
  await monitor.collect();
  assert.equal(monitor.snapshot().work.find((job) => job.number === 1).state, "running");
  assert.equal(monitor.snapshot().work.find((job) => job.number === 2).state, "queued");
  assert.equal(monitor.snapshot().services.cragent.healthy, false);
  write(second, { reviews: { second: review(2, "running") } });
  fs.writeFileSync(path.join(path.dirname(second), "current-open-pr-snapshot.json"), "invalid");
  await monitor.collect();
  assert.equal(monitor.snapshot().work.find((job) => job.number === 2).state, "running");
  assert.equal(monitor.snapshot().services.cragent.healthy, false);
});

test("initial loading followed by network failure displays a disconnected state", () => {
  assert.equal(connectionState({ ready: false }, false), "connecting");
  assert.equal(connectionState({ ready: false }, true), "disconnected");
  assert.equal(connectionState({ ready: true, collectedAt: at }, false, Date.parse(at) + 46000), "stale");
});

test("GitHub outage retains the last result and flags it, while local collection continues", async (t) => {
  const f = fixture(t); let fail = false;
  f.dependencies.github = async () => { if (fail) throw new Error("credentials must not leak"); return { pulls: [pull(1)], remaining: 99 }; };
  const monitor = new Monitor(f.options, f.dependencies); await monitor.refreshGitHub(); await monitor.collect();
  fail = true; f.advance(61000); await monitor.refreshGitHub(); await monitor.collect();
  const result = monitor.snapshot();
  assert.equal(result.github.error, true); assert.equal(result.github.updatedAt, at);
  assert.equal(result.pulls.length, 1); assert.equal(result.stale, false);
  assert.equal(JSON.stringify(result).includes("credentials must not leak"), false);
});

test("report cache rejects traversal and symlinks, updates replaced reports, and counts missing reports", async (t) => {
  const f = fixture(t), cache = new ReportCache(f.root), directory = path.join(f.root, "runs", "one");
  write(path.join(directory, "result.json"), { summary: { total_tokens: 12 } });
  assert.equal(cache.get({ directory }).totalTokens, 12);
  write(path.join(directory, "result.json"), { summary: { total_tokens: 1234 } });
  assert.equal(cache.get({ directory }).totalTokens, 1234);
  write(path.join(f.root, "outside", "result.json"), { summary: { total_tokens: 1234 } });
  assert.equal(cache.get({ directory: path.join(f.root, "outside") }), null);
  fs.symlinkSync(path.join(f.root, "outside"), path.join(f.root, "runs", "link"));
  assert.equal(cache.get({ directory: path.join(f.root, "runs", "link") }), null);
  write(path.join(f.root, "state.json"), { version: 1, jobs: [{ id: 1, state: "complete", updatedAt: at, directory: path.join(f.root, "missing") }] });
  const monitor = new Monitor(f.options, f.dependencies); await monitor.collect();
  assert.equal(monitor.snapshot().usage.expectedReports, 1); assert.equal(monitor.snapshot().usage.reports, 0);
});

test("GraphQL follows pagination and rejects partial responses", async (t) => {
  const f = fixture(t), calls = [];
  const request = async (url, options) => {
    calls.push(JSON.parse(options.body)); assert.equal(options.headers.authorization, "Bearer private-github-token");
    return { ok: true, json: async () => ({ data: { repository: { pullRequests: { nodes: [pull(calls.length)],
      pageInfo: { hasNextPage: calls.length === 1, endCursor: "next" } } }, rateLimit: { remaining: 50 } } }) };
  };
  const result = await githubPulls(f.config, request);
  assert.equal(result.pulls.length, 2); assert.equal(calls[1].variables.after, "next");
  await assert.rejects(githubPulls(f.config, async () => ({ ok: true, json: async () => ({ errors: [{ message: "partial" }], data: {} }) })), /incomplete/);
});

test("overlapping collection is coalesced and overdue jobs are visible", async (t) => {
  const f = fixture(t); let release, calls = 0;
  f.dependencies.health = async () => { calls++; await new Promise((resolve) => { release = resolve; }); return { ok: true, reachable: true, lastPoll: at }; };
  write(path.join(f.root, "state.json"), { version: 1, jobs: [{ id: 1, state: "running", number: 1, startedAt: "2026-10-15T09:00:00Z" }] });
  const monitor = new Monitor(f.options, f.dependencies), pending = monitor.collect();
  await monitor.collect(); assert.equal(calls, 1); release(); await pending;
  assert.equal(monitor.snapshot().work[0].overdue, true);
});

async function serve(t, monitor, options) {
  const server = createMonitorServer(monitor, options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("web server is read-only, serves CSP-protected assets, and denies filesystem paths", async (t) => {
  const url = await serve(t, { snapshot: () => ({ ready: true, stale: false, collectedAt: at }) });
  for (const file of ["/", "/monitor-ui.js", "/monitor-view.js", "/monitor.css"]) {
    const response = await fetch(url + file); assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.ok((await response.text()).length > 100);
  }
  assert.equal((await fetch(url + "/api/status", { method: "POST" })).status, 405);
  assert.equal((await fetch(url + "/config.json")).status, 404);
  assert.equal((await fetch(url + "/../monitor-data.js")).status, 404);
  assert.equal((await fetch(url + "/healthz")).status, 200);
});

test("optional bearer protection covers both snapshots and the webpage", async (t) => {
  const url = await serve(t, { snapshot: () => ({ ready: false }) }, { bearerToken: "monitor-secret" });
  for (const route of ["/", "/api/status", "/healthz"]) assert.equal((await fetch(url + route)).status, 401);
  const response = await fetch(url + "/api/status", { headers: { authorization: "Bearer monitor-secret" } });
  assert.deepEqual(await response.json(), { ready: false });
  assert.equal((await fetch(url + "/healthz", { headers: { authorization: "Bearer monitor-secret" } })).status, 503);
});

test("an authenticating proxy can inject bearer auth for the page, assets and browser refreshes", async (t) => {
  const upstream = await serve(t, { snapshot: () => ({ ready: true, stale: false, collectedAt: at }) }, { bearerToken: "proxy-secret" });
  const proxy = http.createServer(async (req, res) => {
    const response = await fetch(upstream + req.url, { headers: { authorization: "Bearer proxy-secret" } });
    res.writeHead(response.status, { "content-type": response.headers.get("content-type") });
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => { proxy.closeAllConnections(); return new Promise((resolve) => proxy.close(resolve)); });
  const base = `http://127.0.0.1:${proxy.address().port}`;
  for (const route of ["/", "/monitor-ui.js", "/monitor-view.js", "/monitor.css", "/api/status"]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200); assert.equal((await response.text()).includes("proxy-secret"), false);
  }
});

test("health transport fails closed and systemd names cannot become options", async () => {
  assert.equal((await getHealth("http://127.0.0.1:1/healthz")).reachable, false);
  await assert.rejects(unitStatus("../bad;echo.service"), /Invalid/);
});

test("PR analytics validates parameters and survives a malformed HTTP request target", async (t) => {
  const url = await serve(t, { snapshot: () => ({ ready: true }),
    analyticsPull: (repository, number) => ({ repository, number, runs: [] }) });
  const response = await fetch(url + "/api/analytics/pr?repository=Org%2FRepo&number=12");
  assert.deepEqual(await response.json(), { repository: "org/repo", number: 12, runs: [] });
  assert.equal((await fetch(url + "/api/analytics/pr?repository=../secret&number=0")).status, 400);
  const malformed = await new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port: new URL(url).port, path: "//[invalid" }, (res) => {
      res.resume(); res.on("end", () => resolve(res.statusCode));
    });
    request.on("error", reject);
  });
  assert.equal(malformed, 400);
  assert.equal((await fetch(url + "/api/status")).status, 200);
});
