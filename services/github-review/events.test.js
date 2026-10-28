// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { ReviewService } = require("./service.js");
const { GitHubEvents } = require("./events.js");
const { State } = require("./state.js");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-events-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binary = path.join(dir, "ocr"), secret = path.join(dir, "secret");
  fs.writeFileSync(binary, "fixture"); fs.writeFileSync(secret, "test-secret");
  const actor = { id: "n8n", role: "dispatcher", repositories: ["org/*"], tokenFile: secret };
  const pull = { number: 1, title: "Fixture", state: "open", draft: false,
    head: { sha: "b".repeat(40) }, base: { sha: "a".repeat(40), ref: "main", repo: { full_name: "org/repo" } } };
  let getCalls = 0, failNext = false;
  const github = { getToken: () => "fixture", rest: { pulls: { get: async () => { getCalls++; if (failNext) { failNext = false; throw new Error("temporary network failure"); } return { data: pull }; } }, repos: { createCommitStatus: async () => ({}) } } };
  const s = new ReviewService({ config: { stateDirectory: dir, binary, repositories: [{ name: "org/repo", baseBranches: ["main"] }],
    infrastructure: { enabled: true, dispatchEnabled: true, externalDispatch: true, githubWebhookSecretFile: secret, clients: [actor] } }, github, log: () => {} });
  const events = new GitHubEvents(s);
  const envelope = (action = "opened", id = "delivery-1") => {
    const raw = JSON.stringify({ action, repository: { full_name: "org/repo" }, pull_request: pull });
    return { raw_body: Buffer.from(raw).toString("base64"), signature: "sha256=" + crypto.createHmac("sha256", "test-secret").update(raw).digest("hex"), event: "pull_request", delivery_id: id, route: "direct" };
  };
  return { s, events, actor, pull, envelope, dir, calls: () => getCalls, fail: () => { failNext = true; } };
}
test("signed event is durably acknowledged before GitHub calls and dispatches exactly once", async (t) => {
  const h = fixture(t), args = h.envelope();
  assert.equal((await h.events.accept(args, h.actor)).state, "pending");
  assert.equal(h.calls(), 0);
  assert.equal(new State(h.dir).data.deliveries[0].state, "pending");
  assert.equal((await h.events.accept(args, h.actor)).deduplicated, true);
  await Promise.all([h.events.tick(), h.events.tick()]);
  assert.equal(h.s.state.data.jobs.length, 1);
  assert.equal(h.events.status({ delivery_id: args.delivery_id }, h.actor).state, "dispatched");
  await h.events.accept(args, h.actor); await h.events.tick();
  assert.equal(h.s.state.data.jobs.length, 1);
});
test("invalid signature, modified raw bytes, agent bypass and conflicting IDs are rejected", async (t) => {
  const h = fixture(t), args = h.envelope();
  await assert.rejects(h.events.accept({ ...args, signature: "sha256=" + "0".repeat(64) }, h.actor), /signature/);
  await assert.rejects(h.events.accept({ ...args, raw_body: Buffer.from("{}").toString("base64") }, h.actor), /signature/);
  h.s.config.repositories[0].requiresAgent = true;
  await assert.rejects(h.events.accept(args, h.actor), /Agent dispatch is not configured/);
  h.s.config.repositories[0].requiresAgent = false;
  await h.events.accept(args, h.actor);
  await assert.rejects(h.events.accept(h.envelope("synchronize"), h.actor), /reused/);
});
test("transient failures remain durable pending deliveries and retry without duplicate reviews", async (t) => {
  const h = fixture(t); await h.events.accept(h.envelope(), h.actor); h.fail();
  await h.events.tick();
  const record = h.s.state.data.deliveries[0];
  assert.equal(record.state, "pending"); assert.equal(record.attempts, 1);
  assert.equal(h.s.state.data.jobs.length, 0);
  record.nextAt = 0; await h.events.tick();
  assert.equal(record.state, "dispatched"); assert.equal(record.attempts, 2);
  assert.equal(h.s.state.data.jobs.length, 1);
});
test("old head and out-of-order close events cannot dispatch or cancel a newer open PR", async (t) => {
  const h = fixture(t); await h.events.accept(h.envelope(), h.actor);
  h.pull.head.sha = "c".repeat(40); await h.events.tick();
  assert.equal(h.s.state.data.deliveries[0].state, "superseded");
  assert.equal(h.s.state.data.jobs.length, 0);
  await h.events.accept(h.envelope("opened", "open-2"), h.actor); await h.events.tick();
  await h.events.accept(h.envelope("closed", "old-close"), h.actor); await h.events.tick();
  assert.equal(h.s.state.data.jobs[0].state, "queued");
  h.pull.state = "closed";
  await h.events.accept(h.envelope("closed", "new-close"), h.actor); await h.events.tick();
  assert.equal(h.s.state.data.jobs[0].state, "cancelled");
});
test("cutover gate and read scopes apply to persisted deliveries", async (t) => {
  const h = fixture(t); h.s.config.infrastructure.externalDispatch = false;
  await assert.rejects(h.events.accept(h.envelope(), h.actor), /cutover/);
  h.s.config.infrastructure.externalDispatch = true;
  await h.events.accept(h.envelope(), h.actor);
  assert.throws(() => h.events.status({ delivery_id: "delivery-1" }, { role: "reader", repositories: ["other/*"] }), /scope/);
});

test("unsigned events require an exact repository exemption and dispatcher scope", async (t) => {
  const h = fixture(t), args = { ...h.envelope(), signature: "" };
  await assert.rejects(h.events.accept(args, h.actor), /Missing GitHub signature/);
  h.s.config.infrastructure.unsignedWebhookRepositories = ["org/repo"];
  await assert.rejects(h.events.accept(args, { ...h.actor, repositories: ["other/repo"] }), /scope/);
  assert.equal((await h.events.accept(args, h.actor)).state, "pending");
  await h.events.tick();
  assert.equal(h.s.state.data.jobs.length, 1);
  await assert.rejects(h.events.accept({ ...args, signature: "sha256=" + "0".repeat(64) }, h.actor), /Invalid GitHub signature/);
  h.s.config.infrastructure.unsignedWebhookRepositories = ["org/other"];
  await assert.rejects(h.events.accept(args, h.actor), /Missing GitHub signature/);
});

test("agent routing is enforced, durable and never falls back to direct dispatch", async (t) => {
  const h = fixture(t);
  h.s.config.repositories[0].requiresAgent = true;
  h.s.config.infrastructure.agentDispatch = { model: "fixture" };
  let calls = 0;
  h.events.agentDispatch = async () => { calls++; throw new Error("Agent unavailable"); };
  await h.events.accept(h.envelope(), h.actor);
  assert.equal(h.s.state.data.deliveries[0].route, "agent");
  await h.events.tick();
  assert.equal(calls, 1);
  assert.equal(h.s.state.data.jobs.length, 0);
  assert.equal(h.s.state.data.deliveries[0].state, "pending");
  h.s.state.data.deliveries[0].nextAt = 0;
  h.events.agentDispatch = async () => ({ id: 123 });
  await h.events.tick();
  assert.equal(h.s.state.data.deliveries[0].jobId, 123);
  assert.equal(h.s.state.data.deliveries[0].state, "dispatched");
});

function enableFallback(h) {
  h.s.config.repositories[0].requiresAgent = true;
  h.s.config.repositories[0].agentFallback = true;
  h.s.config.infrastructure.agentDispatch = { model: "fixture", clientId: "agent" };
  return { id: "agent", role: "agent", repositories: ["org/repo"] };
}
function submission(h, overrides = {}) {
  return { repository: "org/repo", pull_number: 1, head_sha: h.pull.head.sha,
    base_sha: h.pull.base.sha, request_id: "github:delivery-1", ...overrides };
}

test("an opted-in Agent failure submits one default review and records the fallback", async (t) => {
  const h = fixture(t); enableFallback(h);
  h.events.agentDispatch = async () => { throw new Error("Agent HTTP 502"); };
  await h.events.accept(h.envelope(), h.actor); await h.events.tick();
  const event = h.s.state.data.deliveries[0], job = h.s.state.data.jobs[0];
  assert.equal(event.state, "dispatched"); assert.equal(event.dispatchMethod, "direct_fallback");
  assert.equal(event.fallbackReason, "agent_unacknowledged");
  assert.equal(job.requestedBy, "event-fallback"); assert.equal(job.settings.profile, "standard");
  assert.equal(new State(h.dir).data.deliveries[0].jobId, job.id);
  await h.events.accept(h.envelope(), h.actor); await h.events.tick();
  assert.equal(h.s.state.data.jobs.length, 1);
});

test("missing ingress ACK reuses the signed delivery identity and survives restart", async (t) => {
  const h = fixture(t); enableFallback(h);
  const args = h.envelope();
  await h.events.accept(args, h.actor);
  const receipt = await h.events.accept({ ...args, fallback: true }, h.actor);
  assert.equal(receipt.deduplicated, true);
  assert.equal(receipt.fallback_reason, "ingress_ack_missing");
  h.s.state = new State(h.dir);
  h.events.agentDispatch = async () => { throw new Error("Agent must not run after fallback was chosen"); };
  await h.events.tick();
  assert.equal(h.s.state.data.jobs.length, 1);
  assert.equal(h.s.state.data.deliveries[0].state, "dispatched");
  assert.equal(h.s.state.data.deliveries[0].agentTools, undefined);
  await assert.rejects(h.events.accept({ ...h.envelope("synchronize"), fallback: true }, h.actor), /reused/);
});

test("fallback keeps signature, repository, role and exact-head checks", async (t) => {
  const h = fixture(t), args = { ...h.envelope(), fallback: true };
  await assert.rejects(h.events.accept(args, h.actor), /fallback is not allowed/);
  enableFallback(h);
  await assert.rejects(h.events.accept({ ...args, signature: "sha256=" + "0".repeat(64) }, h.actor), /signature/);
  await assert.rejects(h.events.accept(args, { ...h.actor, repositories: ["org/other"] }), /scope/);
  await assert.rejects(h.events.accept(args, { ...h.actor, role: "reader" }), /dispatcher/);
  await h.events.accept(args, h.actor);
  h.pull.head.sha = "c".repeat(40);
  await h.events.tick();
  assert.equal(h.s.state.data.deliveries[0].state, "superseded");
  assert.equal(h.s.state.data.jobs.length, 0);
});

test("a lost Agent response recovers its durable job instead of creating a fallback", async (t) => {
  const h = fixture(t), agent = enableFallback(h);
  await h.events.accept(h.envelope(), h.actor);
  h.events.agentDispatch = async () => {
    await h.events.api.call("submit_review", submission(h, { profile: "deep" }), agent);
    throw new DOMException("Lost response", "TimeoutError");
  };
  await h.events.tick();
  const event = h.s.state.data.deliveries[0];
  assert.equal(event.state, "dispatched"); assert.equal(event.fallbackAt, undefined);
  assert.equal(event.dispatchMethod, "agent"); assert.ok(event.agentAcknowledgedAt);
  assert.equal(h.s.state.data.jobs.length, 1);
  assert.equal(h.s.state.data.jobs[0].settings.profile, "deep");
});

test("a late Agent submission with different options returns the fallback job", async (t) => {
  const h = fixture(t), agent = enableFallback(h);
  await h.events.accept({ ...h.envelope(), fallback: true }, h.actor);
  await h.events.tick();
  const result = await h.events.api.call("submit_review", submission(h, { profile: "deep", options: { effort: "high" } }), agent);
  assert.equal(result.job_id, h.s.state.data.jobs[0].id);
  assert.equal(result.deduplicated, true);
  assert.equal(h.s.state.data.jobs.length, 1);
  assert.equal(h.s.state.data.jobs[0].settings.profile, "standard");
});

test("Agent and fallback racing after a lost ACK can only claim one default job", async (t) => {
  const h = fixture(t), agent = enableFallback(h);
  await h.events.accept({ ...h.envelope(), fallback: true }, h.actor);
  const [late] = await Promise.all([
    h.events.api.call("submit_review", submission(h, { profile: "deep" }), agent), h.events.tick(),
  ]);
  assert.equal(h.s.state.data.jobs.length, 1);
  assert.equal(h.s.state.data.jobs[0].settings.profile, "standard");
  assert.equal(h.s.state.data.deliveries[0].jobId, late.job_id);
  assert.equal(h.s.state.data.deliveries[0].dispatchMethod, "direct_fallback");
});

test("fallback retries use their own durable budget and never call the Agent again", async (t) => {
  const h = fixture(t); enableFallback(h);
  await h.events.accept(h.envelope(), h.actor);
  let calls = 0;
  h.events.agentDispatch = async () => { calls++; h.fail(); throw new DOMException("No ACK", "TimeoutError"); };
  const event = h.s.state.data.deliveries[0]; event.attempts = 9;
  await h.events.tick();
  assert.equal(event.fallbackReason, "agent_ack_timeout");
  assert.equal(event.state, "pending"); assert.equal(event.fallbackAttempts, 1);
  event.nextAt = 0; await h.events.tick();
  assert.equal(event.state, "dispatched"); assert.equal(calls, 1);
  assert.equal(h.s.state.data.jobs.length, 1);
});

test("fallback does not hide changed PRs, revoked policy or persistence failures", async (t) => {
  const h = fixture(t); enableFallback(h);
  await h.events.accept(h.envelope(), h.actor);
  h.events.agentDispatch = async () => { h.pull.base.sha = "c".repeat(40); throw new Error("No ACK"); };
  await h.events.tick();
  assert.equal(h.s.state.data.deliveries[0].state, "superseded");
  assert.equal(h.s.state.data.jobs.length, 0);
  const other = fixture(t); enableFallback(other);
  await other.events.accept({ ...other.envelope(), fallback: true }, other.actor);
  other.s.config.repositories[0].agentFallback = false;
  await other.events.tick();
  assert.equal(other.s.state.data.deliveries[0].state, "failed");
  assert.equal(other.s.state.data.jobs.length, 0);
  const broken = fixture(t); enableFallback(broken);
  await broken.events.accept(broken.envelope(), broken.actor);
  broken.events.agentDispatch = async () => { throw Object.assign(new Error("Cannot save"), { persistence: true }); };
  await assert.rejects(broken.events.tick(), /Cannot save/);
  assert.equal(broken.s.state.data.jobs.length, 0);
  assert.equal(broken.s.state.data.deliveries[0].fallbackAt, undefined);
});

test("deduplicated Agent submission is acknowledged even when its response is lost", async (t) => {
  const h = fixture(t), agent = enableFallback(h);
  const prior = await h.events.api.call("submit_review", submission(h, { request_id: "prior-delivery" }), agent);
  await h.events.accept(h.envelope(), h.actor);
  h.events.agentDispatch = async () => {
    await h.events.api.call("submit_review", submission(h), agent);
    throw new Error("Lost response");
  };
  await h.events.tick();
  assert.equal(h.s.state.data.jobs.length, 1);
  assert.equal(h.s.state.data.deliveries[0].jobId, prior.job_id);
  assert.equal(h.s.state.data.deliveries[0].fallbackAt, undefined);
});


test("unsigned organization events retain scope and agent routing", async (t) => {
  const h = fixture(t), args = { ...h.envelope(), signature: "" };
  await assert.rejects(h.events.accept(args, h.actor), /signature/);
  h.s.config.infrastructure.unsignedWebhookOrganizations = ["org"];
  await assert.rejects(h.events.accept(args, { ...h.actor, repositories: [] }), /scope/);
  h.s.config.repositories[0].requiresAgent = true;
  h.s.config.infrastructure.agentDispatch = { clientId: "agent" };
  assert.equal((await h.events.accept(args, h.actor)).route, "agent");
});

function pushEnvelope(h, overrides = {}, id = "push-1") {
  const payload = { repository: { full_name: "org/repo" }, ref: "refs/heads/topic", after: h.pull.head.sha, deleted: false, ...overrides };
  const raw = JSON.stringify(payload);
  return { raw_body: Buffer.from(raw).toString("base64"), signature: "sha256=" + crypto.createHmac("sha256", "test-secret").update(raw).digest("hex"), event: "push", delivery_id: id, route: "direct" };
}
function pushLookup(h, pulls = [h.pull]) {
  h.pull.head.ref = "topic"; h.pull.head.repo = { full_name: "org/repo" };
  h.s.github.rest.pulls.listForHead = async (args) => { assert.equal(args.head, "org:topic"); return { data: pulls }; };
}
test("push is durable before lookup and shares one review with PR events and duplicate pushes", async (t) => {
  const h = fixture(t); pushLookup(h);
  const args = pushEnvelope(h);
  assert.equal((await h.events.accept(args, h.actor)).state, "pending");
  assert.equal(h.calls(), 0);
  await h.events.tick();
  assert.equal(h.s.state.data.deliveries[0].state, "expanded");
  await h.events.tick();
  const job = h.s.state.data.jobs[0]; assert.ok(job);
  await h.events.accept(h.envelope("synchronize", "pr-event"), h.actor); await h.events.tick();
  await h.events.accept(pushEnvelope(h, {}, "push-2"), h.actor); await h.events.tick(); await h.events.tick();
  assert.equal(h.s.state.data.jobs.length, 1);
  assert.equal(h.s.state.data.deliveries.at(-1).jobId, job.id);
  assert.equal((await h.events.accept(args, h.actor)).deduplicated, true);
});
test("PR-first delivery cannot reuse an obsolete result after the default policy changes", async (t) => {
  const h = fixture(t); pushLookup(h);
  await h.events.accept(h.envelope(), h.actor); await h.events.tick();
  h.s.config.repositories[0].defaultProfile = "deep";
  await h.events.accept(pushEnvelope(h), h.actor); await h.events.tick(); await h.events.tick();
  assert.equal(h.s.state.data.jobs.length, 2);
  assert.notEqual(h.s.state.data.jobs[0].settings.policySignature, h.s.state.data.jobs[1].settings.policySignature);
});
test("push filters deletion, tags, obsolete heads, draft and unrelated PRs", async (t) => {
  const h = fixture(t); pushLookup(h);
  for (const overrides of [{ deleted: true }, { ref: "refs/tags/v1" }]) assert.equal((await h.events.accept(pushEnvelope(h, overrides), h.actor)).state, "ignored");
  h.pull.draft = true;
  await h.events.accept(pushEnvelope(h), h.actor); await h.events.tick();
  assert.equal(h.s.state.data.deliveries[0].reason, "no_eligible_pull_request");
  h.pull.draft = false;
  await h.events.accept(pushEnvelope(h, { after: "c".repeat(40) }, "stale-push"), h.actor); await h.events.tick();
  assert.equal(h.s.state.data.jobs.length, 0);
  assert.equal(h.s.state.data.deliveries.at(-1).state, "ignored");
});
test("push lookup retries durably and preserves Agent routing", async (t) => {
  const h = fixture(t); pushLookup(h);
  const lookup = h.s.github.rest.pulls.listForHead; let failed = false;
  h.s.github.rest.pulls.listForHead = async (args) => { if (!failed) { failed = true; throw new Error("network"); } return lookup(args); };
  h.s.config.repositories[0].requiresAgent = true;
  h.s.config.infrastructure.agentDispatch = { clientId: "agent" };
  await h.events.accept(pushEnvelope(h), h.actor); await h.events.tick();
  assert.equal(h.s.state.data.deliveries[0].state, "pending");
  h.s.state.data.deliveries[0].nextAt = 0; await h.events.tick();
  assert.equal(h.s.state.data.deliveries[1].route, "agent");
  assert.equal(h.s.state.data.deliveries[0].attempts, 2);
});

test("push paginates and fans out only to eligible PRs", async (t) => {
  const h = fixture(t); pushLookup(h);
  const other = { ...h.pull, number: 2 };
  let pages = [];
  h.s.github.rest.pulls.listForHead = async ({ page }) => {
    pages.push(page);
    return { data: page === 1 ? Array.from({ length: 100 }, () => ({ ...h.pull, draft: true })) : [h.pull, other] };
  };
  await h.events.accept(pushEnvelope(h), h.actor); await h.events.tick();
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(h.s.state.data.deliveries.slice(1).map(e => e.number), [1, 2]);
  assert.equal(h.s.state.data.deliveries[0].childDeliveries.length, 2);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function concurrentFixture(t, numbers) {
  const h = fixture(t);
  h.s.config.dispatchConcurrency = 2;
  h.s.github.rest.pulls.get = async ({ pull_number }) => ({ data: { ...h.pull, number: pull_number } });
  for (let i = 0; i < numbers.length; i++) {
    h.pull.number = numbers[i];
    await h.events.accept(h.envelope("synchronize", `parallel-${i}`), h.actor);
  }
  return h;
}
test("slow Agent dispatch does not block another PR; overlapping ticks preserve PR ordering and deduplication", async (t) => {
  const h = await concurrentFixture(t, [1, 1, 2, 3]);
  const gate = deferred(), entered = deferred();
  let calls = 0;
  h.events.agentDispatch = async (service, event) => {
    calls++; entered.resolve(); await gate.promise;
    return h.events.defaultReview(event, h.actor);
  };
  h.s.state.data.deliveries[0].route = "agent";
  const first = h.events.tick();
  await entered.promise;
  // PR 1 is held in the Agent; PR 2 completes without releasing it.
  for (let i = 0; i < 100 && h.s.state.data.deliveries[2].state !== "dispatched"; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.s.state.data.deliveries[2].state, "dispatched");
  await h.events.tick();
  assert.equal(h.s.state.data.deliveries[3].state, "dispatched");
  assert.equal(h.s.state.data.deliveries[1].attempts, 0);
  assert.equal(calls, 1);
  gate.resolve(); await first; await h.events.tick();
  assert.equal(h.s.state.data.jobs.length, 3);
  assert.equal(h.s.state.data.deliveries[0].jobId, h.s.state.data.deliveries[1].jobId);
  assert.equal(h.events.activeDispatches.size, 0);
});
test("dispatch pool is bounded and stopping admits no additional events", async (t) => {
  const h = await concurrentFixture(t, [1, 2, 3]);
  const gate = deferred(), entered = deferred();
  let calls = 0;
  h.events.agentDispatch = async (service, event) => {
    if (++calls === 2) entered.resolve();
    await gate.promise;
    return h.events.defaultReview(event, h.actor);
  };
  for (const event of h.s.state.data.deliveries) event.route = "agent";
  const first = h.events.tick(); await entered.promise;
  await h.events.tick();
  assert.equal(calls, 2); assert.equal(h.events.activeDispatches.size, 2);
  gate.resolve(); await first;
  h.s.stopping = true; await h.events.tick();
  assert.equal(h.s.state.data.deliveries[2].attempts, 0);
  h.s.stopping = false; await h.events.tick();
  assert.equal(calls, 3); assert.equal(h.s.state.data.jobs.length, 3);
});
test("a failed PR releases its dispatch slot without failing other PRs", async (t) => {
  const h = await concurrentFixture(t, [1, 2]);
  h.s.github.rest.pulls.get = async ({ pull_number }) => {
    if (pull_number === 1) throw new Error("temporary failure");
    return { data: { ...h.pull, number: pull_number } };
  };
  await h.events.tick();
  assert.equal(h.s.state.data.deliveries[0].state, "pending");
  assert.equal(h.s.state.data.deliveries[1].state, "dispatched");
  assert.equal(h.events.activeDispatches.size, 0);
});

test("admission publishes pending after durable acceptance and before Agent dispatch", async (t) => {
  const h = fixture(t), statuses = [];
  h.s.github.rest.repos.createCommitStatus = async (status) => {
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, "state.json"))).deliveries.length, 1);
    assert.equal(h.s.state.data.jobs.length, 0);
    statuses.push(status);
  };
  await h.events.accept(h.envelope(), h.actor);
  assert.equal(statuses.length, 1); assert.equal(statuses[0].state, "pending");
  assert.equal(statuses[0].description, "OCR accepted; waiting for review dispatch");
  await h.events.accept(h.envelope(), h.actor);
  assert.equal(statuses.length, 1); assert.equal(h.s.state.data.jobs.length, 0);
});
test("draft, closed and out-of-scope branches do not publish admission pending", async (t) => {
  for (const mutation of [p => p.draft = true, p => p.state = "closed", p => p.base.ref = "other"]) {
    const h = fixture(t), statuses = [];
    h.s.github.rest.repos.createCommitStatus = async (status) => statuses.push(status);
    mutation(h.pull); await h.events.accept(h.envelope(), h.actor);
    assert.equal(statuses.length, 0);
  }
});
test("admission status API failure is retried without losing the durable event", async (t) => {
  const h = fixture(t); let fail = true, count = 0;
  h.s.github.rest.repos.createCommitStatus = async () => { if (fail) throw new Error("GitHub unavailable"); count++; };
  await h.events.accept(h.envelope(), h.actor);
  const e = h.s.state.data.deliveries[0];
  assert.equal(e.state, "pending"); assert.equal(h.s.state.data.jobs.length, 0);
  assert.match(e.statusError, /unavailable/);
  fail = false; e.statusRetryAt = 0; await h.events.publishAdmission(e);
  assert.equal(count, 1); assert.equal(e.admissionPublished, "pending");
});
test("completed tasks and Policy receipts own the status instead of duplicate App events", async (t) => {
  const h = fixture(t), statuses = [];
  await h.events.accept(h.envelope(), h.actor); await h.events.tick();
  h.s.state.data.jobs[0].state = "complete";
  h.s.github.rest.repos.createCommitStatus = async (status) => statuses.push(status);
  await h.events.accept(h.envelope("edited", "duplicate-head"), h.actor);
  assert.equal(statuses.length, 0);
  const other = fixture(t); other.s.state.data.ciReceipts = { test: { repository: "org/repo", head_sha: other.pull.head.sha } };
  other.s.github.rest.repos.createCommitStatus = async (status) => statuses.push(status);
  await other.events.accept(other.envelope(), other.actor);
  assert.equal(statuses.length, 0);
});
test("in-flight admission pending cannot overwrite a later final job status", async (t) => {
  const h = fixture(t), gate = deferred(), entered = deferred(), statuses = [];
  h.s.github.rest.repos.createCommitStatus = async (status) => {
    if (status.state === "pending") { entered.resolve(); await gate.promise; }
    statuses.push(status.state);
  };
  const acceptance = h.events.accept(h.envelope(), h.actor); await entered.promise;
  const final = h.s.status({repository:"org/repo",head:h.pull.head.sha}, "success", "Review complete");
  gate.resolve(); await Promise.all([acceptance, final]);
  assert.deepEqual(statuses, ["pending", "success"]);
});
test("dispatch failures and skipped snapshots settle their early pending status", async (t) => {
  for (const expected of ["error", "success"]) {
    const h = fixture(t), statuses = [];
    h.s.github.rest.repos.createCommitStatus = async (status) => statuses.push(status.state);
    await h.events.accept(h.envelope(), h.actor);
    if (expected === "error") h.s.github.rest.pulls.get = async () => { throw Object.assign(new Error("Denied"), {status:403}); };
    else h.pull.draft = true;
    await h.events.tick();
    assert.deepEqual(statuses, ["pending", expected]);
    assert.equal(h.s.state.data.jobs.length, 0);
  }
});

test("backend alone decides repository enrollment; gateway acknowledges ignores without admitting work", async (t) => {
  const h = fixture(t), args = h.envelope();
  h.s.config.repositories = [];
  const logs = []; h.s.log = (event, data) => logs.push({ event, ...data });
  const result = await h.events.accept(args, h.actor);
  assert.equal(result.state, "ignored");
  assert.equal(result.reason, "repository_not_enabled");
  assert.equal(result.accepted, false);
  assert.equal(result.repository, "org/repo");
  assert.equal(result.pull_number, 1);
  const { normalizeAcknowledgement } = require("./n8n-workflow.js");
  assert.equal(normalizeAcknowledgement({ statusCode: 202, body: result }, { envelope: args }).acknowledged, true);
  assert.equal(h.s.state.data.jobs.length, 0);
  assert.equal((h.s.state.data.deliveries || []).length, 0);
  assert.equal(h.calls(), 0);
  assert.equal(logs[0].delivery_id, args.delivery_id);
  await assert.rejects(h.events.accept({ ...args, signature: "sha256=" + "0".repeat(64) }, h.actor), /signature/);
  await assert.rejects(h.events.accept(args, { ...h.actor, repositories: ["other/*"] }), /scope/);
  assert.throws(() => h.events.api.authorize("org/repo", h.actor), /Repository is not allowed/);
  h.s.config.repositories = [{ name: "org/repo", baseBranches: ["main"] }];
  assert.equal((await h.events.accept(args, h.actor)).state, "pending");
});
