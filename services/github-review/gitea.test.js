// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), http = require("node:http");
const { createGitea } = require("./gitea.js");
const { createGiteaWebhook } = require("./gitea-webhook.js");
function secret(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), "gitea-test-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); const p = path.join(d, "secret"); fs.writeFileSync(p, "test-secret"); return p; }
test("Gitea maps review coordinates and restricts credentials to configured origin", async t => {
  const calls = [], tokenFile = secret(t);
  const g = createGitea({ origin: "https://gitea.example", tokenFile, fetchImpl: async (url, args) => { calls.push({ url, args }); return new Response(JSON.stringify({ id: 1 }), { status: 200 }); } });
  await g.rest.pulls.createReview({ owner: "infra", repo: "test", pull_number: 1, commit_id: "a".repeat(40), event: "COMMENT", comments: [{ path: "a.js", line: 3, side: "RIGHT", body: "new" }, { path: "b.js", line: 7, side: "LEFT", body: "old" }] });
  assert.equal(calls[0].url, "https://gitea.example/api/v1/repos/infra/test/pulls/1/reviews");
  assert.equal(calls[0].args.redirect, "error");
  assert.deepEqual(JSON.parse(calls[0].args.body).comments.map(c => [c.new_position, c.old_position]), [[3, 0], [0, 7]]);
  assert.throws(() => createGitea({ origin: "https://user:secret@gitea.example", tokenFile }), /HTTPS origin/);
});
test("Gitea webhook rejects unsigned requests and reconciles PR state through API", async t => {
  const file = secret(t), observed = [], service = { config: { gitea: { webhookSecretFile: file } }, repo: r => r === "infra/test", log() {}, observe: async (r, n) => { observed.push([r, n]); return { id: 42 }; }, poll: async () => { observed.push("poll"); } };
  const handler = createGiteaWebhook(service), server = http.createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(r => server.listen(0, "127.0.0.1", r)); t.after(() => { server.closeAllConnections(); server.close(); });
  const body = JSON.stringify({ repository: { full_name: "infra/test" }, pull_request: { number: 1 }, action: "closed" });
  const url = `http://127.0.0.1:${server.address().port}/webhooks/gitea`;
  const signature = crypto.createHmac("sha256", "test-secret").update(body).digest("hex");
  const post = headers => fetch(url, { method: "POST", headers, body });
  assert.equal((await post({ "x-gitea-event": "pull_request" })).status, 401);
  assert.equal(observed.length, 0);
  for (let i = 0; i < 2; i++) { const r = await post({ "x-gitea-event": "pull_request_sync", "x-gitea-signature": signature }); assert.equal(r.status, 202); assert.equal((await r.json()).job_id, 42); }
  assert.deepEqual(observed, [["infra/test", 1], ["infra/test", 1]]);
  assert.equal((await post({ "x-gitea-event": "push", "x-gitea-signature": signature })).status, 202);
  assert.equal(observed.at(-1), "poll");
});

test("Gitea admission deduplicates, supersedes, reconciles new bases and ignores stale close payloads", async t => {
  const { ReviewService } = require("./service.js");
  const tokenFile = secret(t), directory = path.dirname(tokenFile), repository = "infra/test";
  const head = "a".repeat(40), base = "b".repeat(40);
  let pr = { number: 1, title: "Change", state: "open", draft: false, head: { sha: head }, base: { sha: base, ref: "main", repo: { full_name: repository } } };
  const g = createGitea({ origin: "https://gitea.example", tokenFile, fetchImpl: async (url, args) => new Response(JSON.stringify(args.method === "GET" ? pr : {}), { status: 200 }) });
  const service = new ReviewService({ config: { stateDirectory: directory, binary: "/usr/bin/true", repositories: [{ name: repository, baseBranches: ["main"] }], gitea: { webhookSecretFile: tokenFile } }, github: g, log() {} });
  const first = await service.observe(repository, 1);
  assert.equal(first.state, "queued");
  assert.equal(await service.observe(repository, 1), null);
  assert.equal(service.state.data.jobs.length, 1);
  first.state = "complete";
  pr = { ...pr, base: { ...pr.base, sha: "c".repeat(40) } };
  const changed = await service.observe(repository, 1);
  assert.equal(changed.fullReview, true);
  assert.equal(service.state.data.jobs.length, 2);
  pr = { ...pr, head: { sha: "d".repeat(40) } };
  const newer = await service.observe(repository, 1);
  assert.equal(changed.state, "superseded");
  assert.equal(newer.state, "queued");
  pr = { ...pr, state: "closed" };
  assert.equal(await service.observe(repository, 1), null);
  assert.equal(newer.state, "superseded");
  pr = { ...pr, state: "open", title: "[WIP] Not ready" };
  assert.equal(await service.observe(repository, 1), null);
});

test("Gitea clamped physical pages fill logical pages without dropping PRs", async t => {
  const calls = [], tokenFile = secret(t);
  const g = createGitea({ origin: "https://gitea.example", tokenFile, fetchImpl: async url => {
    const u = new URL(url), page = Number(u.searchParams.get("page")); calls.push(page);
    const data = Array.from({ length: 125 }, (_, i) => ({ number: i + 1 })).slice((page - 1) * 50, page * 50);
    return new Response(JSON.stringify(data), { headers: { "x-total-count": "125" } });
  } });
  const p = { owner: "infra", repo: "test", per_page: 100 };
  assert.equal((await g.rest.pulls.list({ ...p, page: 1 })).data.length, 100);
  assert.deepEqual(calls, [1, 2]);
  const second = (await g.rest.pulls.list({ ...p, page: 2 })).data;
  assert.equal(second.length, 25); assert.equal(second.at(-1).number, 125);
});
test("Gitea preserves transient HTTP errors and stops comment scans at requested window", async t => {
  const tokenFile = secret(t);
  const failing = createGitea({ origin: "https://gitea.example", tokenFile, fetchImpl: async () => new Response("<html>bad gateway</html>", { status: 502, headers: { "retry-after": "20" } }) });
  await assert.rejects(failing.rest.users.getAuthenticated(), e => e.status === 502 && e.response.headers["retry-after"] === "20");
  let calls = 0;
  const g = createGitea({ origin: "https://gitea.example", tokenFile, fetchImpl: async url => {
    calls++;
    const data = url.includes("/comments") ? [{ id: 1, position: 4 }] : [{ id: 1 }, { id: 2 }, { id: 3 }];
    return new Response(JSON.stringify(data), { headers: { "x-total-count": String(data.length) } });
  } });
  const r = await g.rest.pulls.listReviewComments({ owner: "infra", repo: "test", pull_number: 1, per_page: 1 });
  assert.equal(r.data.length, 1); assert.equal(calls, 2);
});

test("Gitea unpaginated comment endpoints are not repeatedly fetched as physical pages", async t => {
  const tokenFile = secret(t), calls = [];
  const g = createGitea({ origin: "https://gitea.example", tokenFile, fetchImpl: async url => {
    calls.push(url);
    if (url.includes("/reviews?")) return new Response(JSON.stringify([{ id: 1 }]), { headers: { "x-total-count": "1" } });
    return new Response(JSON.stringify([{ id: 7, position: 3 }]));
  } });
  const p = { owner: "infra", repo: "test", pull_number: 1, issue_number: 1, per_page: 100 };
  assert.equal((await g.rest.pulls.listReviewComments(p)).data.length, 1);
  assert.equal((await g.rest.issues.listComments(p)).data.length, 1);
  assert.equal(calls.length, 3);
  assert.ok(calls.filter(url => url.includes("/comments")).every(url => !url.includes("?")));
});

test("Gitea sequential enumeration is linear and rejects pagination cycles", async t => {
  const tokenFile = secret(t); let calls = 0;
  const g = createGitea({ origin: "https://gitea.example", tokenFile, fetchImpl: async url => {
    calls++; const page = Number(new URL(url).searchParams.get("page"));
    return new Response(JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ id: (page - 1) * 50 + i }))), { headers: { "x-total-count": "1000" } });
  } });
  let total = 0;
  for (let page = 1; ; page++) { const r = await g.rest.pulls.listReviews({ owner: "infra", repo: "test", pull_number: 1, page }); total += r.data.length; if (r.data.length < 100) break; }
  assert.equal(total, 1000); assert.equal(calls, 20);
  const cyclic = createGitea({ origin: "https://gitea.example", tokenFile, fetchImpl: async url => {
    const page = Number(new URL(url).searchParams.get("page"));
    return new Response(JSON.stringify([{ id: page }]), { headers: { link: `<https://gitea.example/api/v1/repos/infra/test/pulls/1/reviews?limit=100&page=${page === 1 ? 2 : 1}>; rel="next"` } });
  } });
  await assert.rejects(cyclic.rest.pulls.listReviews({ owner: "infra", repo: "test", pull_number: 1 }), /Repeated/);
});
