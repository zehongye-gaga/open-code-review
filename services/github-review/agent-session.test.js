// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

// SPDX-License-Identifier: Apache-2.0
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { State } = require("./state.js");
const { dispatchAgent } = require("./agent-dispatch.js");
const { bindingFor, withSession, ensureSession, queueFeedback, feedbackTick } = require("./agent-session.js");
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-agent-session-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, "token"); fs.writeFileSync(tokenFile, "fixture");
  const original = global.fetch; t.after(() => { global.fetch = original; });
  return { config: { infrastructure: { agentDispatch: { url: "https://example.test/chat", model: "goclaw:test", tokenFile, clientId: "agent" } } },
    state: new State(directory), repo: () => ({ requiresAgent: true }), log() {} };
}
const reply = (key) => new Response(JSON.stringify({ session_key: key, choices: [{ message: { content: "ACK" } }] }),
  { headers: { "x-goclaw-session-key": key } });
test("PR bindings survive restart, isolate repositories and reuse a session across commits", async (t) => {
  const s = fixture(t), requests = [];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    if (body.tool_choice === "none") return reply("session-1");
    const event = s.event;
    s.state.data.jobs.push({ id: requests.length, repository: event.repository, number: event.number,
      head: event.head, base: event.base, state: "queued", requestedBy: "agent", requestId: `github:${event.id}` });
    return new Response('data: [DONE]\n\n', { headers: { "x-goclaw-session-key": "session-1" } });
  };
  s.event = { id: "first", repository: "org/repo", number: 1, head: "a", base: "b" };
  await dispatchAgent(s, s.event);
  s.state = new State(path.dirname(s.state.file));
  s.event = { ...s.event, id: "second", head: "c" };
  await dispatchAgent(s, s.event);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].tool_choice, "none");
  assert.equal(requests[1].session_key, "session-1");
  assert.equal(requests[2].session_key, "session-1");
  assert.notEqual(requests[1].client_message_id, requests[2].client_message_id);
  await dispatchAgent(s, s.event);
  assert.equal(requests.length, 3);
  assert.notEqual(bindingFor(s, "other/repo", 1).id, bindingFor(s, "org/repo", 1).id);
  assert.notEqual(bindingFor(s, "org/repo", 2).id, bindingFor(s, "org/repo", 1).id);
});
test("budget outcomes use a durable no-tools outbox and a stable retry message ID", async (t) => {
  const s = fixture(t), bodies = [];
  bindingFor(s, "org/repo", 1).sessionKey = "fixed";
  const job = { id: 1, repository: "org/repo", number: 1, head: "a", base: "b", state: "queued", attempt: 1,
    startedAt: "2026-10-23T00:00:00Z", retryBudget: 1000000, progress: { budgetExceeded: true },
    budgetRetries: [{ from: 500000, to: 1000000 }] };
  queueFeedback(s, job); queueFeedback(s, job); s.state.save();
  s.state = new State(path.dirname(s.state.file));
  global.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1) throw new Error("Network response lost");
    return reply("fixed");
  };
  await feedbackTick(s);
  assert.equal(s.state.data.agentFeedback[0].state, "pending");
  s.state.data.agentFeedback[0].nextAt = 0;
  await feedbackTick(s);
  assert.equal(s.state.data.agentFeedback[0].state, "sent");
  assert.equal(bodies[0].client_message_id, bodies[1].client_message_id);
  for (const body of bodies) { assert.equal(body.tool_choice, "none"); assert.equal(body.session_key, "fixed"); }
  assert.equal(s.state.data.jobs.length, 0);
  job.state = "complete"; job.attempt = 2; job.progress = { complete: true, findings: 2 };
  queueFeedback(s, job); await feedbackTick(s);
  assert.equal(s.state.data.agentFeedback.length, 2);
  assert.equal(s.state.data.agentFeedback[1].state, "sent");
});
test("same-session operations serialize and invalid bindings never create replacement sessions", async (t) => {
  const s = fixture(t), order = [];
  let release;
  const first = withSession(s, "org/repo", 1, async () => { order.push(1); await new Promise(r => { release = r; }); order.push(2); });
  await new Promise(r => setImmediate(r));
  const second = withSession(s, "org/repo", 1, async () => { order.push(3); });
  release(); await Promise.all([first, second]); assert.deepEqual(order, [1, 2, 3]);
  bindingFor(s, "org/repo", 1).sessionKey = "existing";
  const job = { id: 2, repository: "org/repo", number: 1, state: "failed" };
  queueFeedback(s, job);
  global.fetch = async (_url, opts) => {
    assert.equal(JSON.parse(opts.body).session_key, "existing"); return new Response("not found", { status: 404 });
  };
  await feedbackTick(s);
  assert.equal(s.state.data.agentFeedback[0].state, "failed");
  assert.equal(bindingFor(s, "org/repo", 1).sessionKey, "existing");
});
test("session key is saved before consuming the bootstrap response", async (t) => {
  const s = fixture(t), binding = bindingFor(s, "org/repo", 1);
  global.fetch = async () => ({ ok: true, headers: new Headers({ "x-goclaw-session-key": "allocated" }),
    async json() { assert.equal(new State(path.dirname(s.state.file)).data.agentSessions[binding.id].sessionKey, "allocated"); throw new Error("Interrupted body"); } });
  await assert.rejects(ensureSession(s, binding), /Interrupted body/);
  global.fetch = async () => { throw new Error("Must reuse allocated session"); };
  await ensureSession(s, binding);
});

test("Agent feedback uses the same skip outcome and preserves unlimited retry budget",(t)=>{
 const s=fixture(t),job={id:3,repository:"org/repo",number:1,state:"complete",attempt:1,retryBudget:0,
  settings:{options:{budget:2000000}},progress:{skipped:true,selected:0},result:{skipped:true,findings:0,blocking:0,summaryURL:"https://example.test/review"}};
 queueFeedback(s,job);const payload=s.state.data.agentFeedback[0].payload;
 assert.equal(payload.status,"skipped");assert.equal(payload.outcome,"skipped");assert.equal(payload.budget,0);assert.equal(payload.automatic_retry_scheduled,false);
});
