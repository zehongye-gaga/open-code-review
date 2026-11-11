// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

// SPDX-License-Identifier: Apache-2.0
"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const locks = new WeakMap();
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function bindingFor(service, repository, number) {
  const config = service.config.infrastructure?.agentDispatch;
  if (!config?.url || !config.model || !config.tokenFile) throw new Error("Agent dispatch is not configured");
  const id = hash([config.url, config.model, config.clientId, repository.toLowerCase(), number]);
  service.state.data.agentSessions ||= {};
  const bindings = service.state.data.agentSessions;
  bindings[id] ||= { id, repository: repository.toLowerCase(), number, model: config.model,
    url: config.url, createdAt: new Date().toISOString() };
  return bindings[id];
}
async function withSession(service, repository, number, run) {
  const binding = bindingFor(service, repository, number);
  let pending = locks.get(service);
  if (!pending) { pending = new Map(); locks.set(service, pending); }
  const previous = pending.get(binding.id) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  pending.set(binding.id, gate);
  await previous;
  try { return await run(binding); }
  finally { release(); if (pending.get(binding.id) === gate) pending.delete(binding.id); }
}
function headers(service) {
  return { "content-type": "application/json", authorization: `Bearer ${fs.readFileSync(service.config.infrastructure.agentDispatch.tokenFile, "utf8").trim()}` };
}
function recordSession(service, binding, key) {
  if (typeof key !== "string" || !key || key.length > 1024 || /[\x00-\x1f]/.test(key)) throw new Error("Agent did not return a valid session key");
  if (binding.sessionKey && binding.sessionKey !== key) throw new Error("Agent session binding changed unexpectedly");
  binding.sessionKey = key; binding.updatedAt = new Date().toISOString();
  service.state.save();
}
async function informationalMessage(service, binding, message, id) {
  const config = service.config.infrastructure.agentDispatch;
  const response = await fetch(config.url, { method: "POST", headers: headers(service), redirect: "error",
    signal: AbortSignal.timeout(config.timeoutMs || 180000),
    body: JSON.stringify({ model: config.model, stream: false, tool_choice: "none",
      ...(binding.sessionKey ? { session_key: binding.sessionKey } : {}), client_message_id: id,
      messages: [{ role: "user", content: message }] }) });
  if (!response.ok) throw Object.assign(new Error(`Agent session initialization HTTP ${response.status}`), { status: response.status });
  const key = response.headers.get("x-goclaw-session-key");
  if (key) recordSession(service, binding, key);
  const body = await response.json();
  if (body.error) throw new Error("Agent returned a session initialization error");
  recordSession(service, binding, body.session_key || key);
}
async function ensureSession(service, binding) {
  if (binding.sessionKey) return;
  // Bootstrap cannot run tools. A lost first response cannot submit a review.
  await informationalMessage(service, binding,
    `This is the persistent OCR routing session for ${binding.repository} PR #${binding.number}. Future commit events and review outcomes belong to this PR only. This message initializes context only; do not submit or retry any review. Reply ACK.`,
    `ocr-session-${binding.id}`);
}
function retireAgentFeedback(service) {
  const original = service.state.data.agentFeedback;
  const count = (original || []).filter(item => item.state === "pending").length;
  if (!count) return 0;
  const disabledAt = new Date().toISOString();
  service.state.data.agentFeedback = original.map(item => item.state === "pending"
    ? { ...item, state: "disabled", disabledAt, disabledReason: "result_feedback_removed" } : item);
  try {
    service.state.save();
  } catch (error) {
    service.state.data.agentFeedback = original;
    throw error;
  }
  service.log("agent_feedback_disabled", { count });
  return count;
}
module.exports = { bindingFor, withSession, headers, recordSession, ensureSession, retireAgentFeedback };
