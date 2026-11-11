// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

// SPDX-License-Identifier: Apache-2.0
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { State } = require("./state.js");
const { dispatchAgent } = require("./agent-dispatch.js");
const { bindingFor, withSession, ensureSession, retireAgentFeedback } = require("./agent-session.js");
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-agent-session-"));
  let service;
  t.after(() => { service?.state.database?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const tokenFile = path.join(directory, "token"); fs.writeFileSync(tokenFile, "fixture");
  const original = global.fetch; t.after(() => { global.fetch = original; });
  return service = { config: { binary: __filename, provider: "test", model: "test", blockSeverity: "low", timeoutSeconds: 30, fetchTimeoutSeconds: 30, infrastructure: { agentDispatch: { url: "https://example.test/chat", model: "goclaw:test", tokenFile, clientId: "agent" } } },
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
      settings: require("./review-policy.js").bindPolicy(s,s.repo(),require("./options.js").resolveOptions(s.config, s.repo())), head: event.head, base: event.base, state: "queued", requestedBy: "agent", requestId: `github:${event.id}` });
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
test("same-session operations serialize and existing bindings require no new initialization", async (t) => {
  const s = fixture(t), order = [];
  let release;
  const first = withSession(s, "org/repo", 1, async () => { order.push(1); await new Promise(r => { release = r; }); order.push(2); });
  await new Promise(r => setImmediate(r));
  const second = withSession(s, "org/repo", 1, async () => { order.push(3); });
  release(); await Promise.all([first, second]); assert.deepEqual(order, [1, 2, 3]);
  const binding = bindingFor(s, "org/repo", 1); binding.sessionKey = "existing";
  global.fetch = async () => { assert.fail("An existing session must not be initialized again"); };
  await ensureSession(s, binding);
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

for (const legacyImport of [false, true]) test(`historical feedback is retired once without losing audit or dispatch data (${legacyImport ? "legacy import" : "sqlite"})`, t => {
  const s = fixture(t), binding = bindingFor(s, "org/repo", 1);
  binding.sessionKey = "preserved-session";
  const pending = { id: "historical", state: "pending", bindingId: binding.id, attempts: 3322, nextAt: 123,
    error: "Agent feedback HTTP 409", payload: { budget: 0, budget_retries: [{ from: 500000, to: 0 }], summary_url: "https://example.test/review" } };
  s.state.data.agentFeedback = [pending, { id: "sent", state: "sent", sentAt: "2026-10-30T00:00:00Z" },
    { id: "failed", state: "failed", error: "Agent feedback HTTP 404" }];
  s.state.data.jobs = [{ id: 1, state: "complete", retryBudget: 0, progress: { sessionId: "native-session" }, result: { summaryURL: pending.payload.summary_url } }];
  s.state.save();
  if (legacyImport) {
    const directory = path.dirname(s.state.file), database = path.join(directory, "state.db");
    require("./state-export.js").exportState(database, s.state.file);
    s.state.database.close();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(database + suffix, { force: true });
    s.state = new State(directory);
  }
  const jobs = JSON.parse(JSON.stringify(s.state.data.jobs)), sessions = JSON.parse(JSON.stringify(s.state.data.agentSessions));
  const save = s.state.save.bind(s.state); let writes = 0;
  s.state.save = () => { writes++; save(); };
  global.fetch = async () => { assert.fail("Retirement must not contact the Agent"); };
  assert.equal(retireAgentFeedback(s), 1);
  const retired = s.state.data.agentFeedback[0];
  assert.equal(retired.state, "disabled"); assert.equal(retired.disabledReason, "result_feedback_removed");
  assert.ok(Number.isFinite(Date.parse(retired.disabledAt)));
  const { state, disabledReason, disabledAt, ...history } = retired;
  const expectedHistory = { ...pending }; delete expectedHistory.state;
  assert.deepEqual(history, expectedHistory);
  assert.deepEqual(s.state.data.jobs, jobs); assert.deepEqual(s.state.data.agentSessions, sessions);
  const stable = JSON.parse(JSON.stringify(s.state.data.agentFeedback));
  assert.equal(retireAgentFeedback(s), 0); assert.equal(writes, 1);
  const restored = new State(path.dirname(s.state.file));
  try {
    assert.deepEqual(restored.data.agentFeedback, stable);
    assert.deepEqual(restored.data.jobs, jobs); assert.deepEqual(restored.data.agentSessions, sessions);
    restored.save = () => { assert.fail("Restart must not save feedback again"); };
    assert.equal(retireAgentFeedback({ state: restored, log() {} }), 0);
  } finally { restored.database?.close(); }
});

test("feedback retirement propagates persistence failure and retries the migration", t => {
  const s = fixture(t), original = [{ id: "pending", state: "pending", attempts: 20, payload: { budget: 0 } }];
  s.state.data.agentFeedback = original; s.state.save();
  const save = s.state.save.bind(s.state);
  s.state.save = () => { throw Object.assign(Error("Disk unavailable"), { persistence: true }); };
  assert.throws(() => retireAgentFeedback(s), /Disk unavailable/);
  assert.deepEqual(s.state.data.agentFeedback, original);
  assert.deepEqual(new State(path.dirname(s.state.file)).data.agentFeedback, original);
  s.state.save = save; assert.equal(retireAgentFeedback(s), 1);
  assert.equal(new State(path.dirname(s.state.file)).data.agentFeedback[0].state, "disabled");
});

test("a fresh service needs no feedback history or migration write", t => {
  const s = fixture(t); s.state.save = () => { assert.fail("No history must not cause a write"); };
  assert.equal(retireAgentFeedback(s), 0);
  assert.equal(s.state.data.agentFeedback, undefined);
});
