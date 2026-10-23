// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { dispatchAgent } = require("./agent-dispatch.js");
test("agent stream is verified against persisted tasks and supports retry recovery", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-dispatch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenFile = path.join(dir, "token"); fs.writeFileSync(tokenFile, "fixture");
  const e = { id: "delivery", repository: "org/repo", number: 1, head: "a", base: "b" };
  const job = { id: 123, repository: e.repository, number: 1, head: "a", base: "b", requestedBy: "agent", requestId: "github:delivery" };
  const s = { config: { infrastructure: { agentDispatch: { url: "https://example.test/chat", tokenFile, model: "goclaw:test", clientId: "agent" } } }, state: { data: { jobs: [] }, save() {} } };
  require("./agent-session.js").bindingFor(s, e.repository, e.number).sessionKey = "fixed-pr-session";
  const original = global.fetch; t.after(() => { global.fetch = original; });
  global.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"{\\"job_id\\":123}"}}]}\n\ndata: [DONE]\n\n');
  await assert.rejects(dispatchAgent(s, e), /verifiable/);
  global.fetch = async () => { s.state.data.jobs.push(job); return new Response('data: [DONE]\n\n'); };
  assert.equal((await dispatchAgent(s, e)).id, 123);
  global.fetch = async () => { throw new Error("Must recover without another request"); };
  assert.equal((await dispatchAgent(s, e)).id, 123);
  s.state.data.jobs = [];
  global.fetch = async () => new Response('data: {"choices":[]}\n\n');
  await assert.rejects(dispatchAgent(s, e), /before completion/);
  global.fetch = async () => { s.state.data.jobs.push(job); throw new Error("Response lost after submission"); };
  assert.equal((await dispatchAgent(s, e)).id, 123);
  s.state.data.jobs = [];
  const historyReply = 'data: {"choices":[{"delta":{"content":"{\\"job_id\\":123}","goclaw_event":{"type":"tool.result","payload":{"is_error":false,"canonical_name":"ocr__get_review_history"}}}}]}\n\ndata: [DONE]\n\n';
  s.state.data.jobs = [{ ...job, state: "skipped", requestId: "another-delivery" }];
  global.fetch = async () => new Response(historyReply);
  await assert.rejects(dispatchAgent(s, e), /verifiable/);
  s.state.data.jobs = [];
  s.config.infrastructure.agentDispatch.timeoutMs = 10;
  let signal;
  global.fetch = async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  await assert.rejects(dispatchAgent(s, e), (error) => error.name === "TimeoutError");
  assert.equal(signal.aborted, true);
  global.fetch = async (_url, options) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
    options.signal.addEventListener("abort", () => controller.error(options.signal.reason), { once: true });
  } }));
  await assert.rejects(dispatchAgent(s, e), (error) => error.name === "TimeoutError");
});
