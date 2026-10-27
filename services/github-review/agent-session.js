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
  const bindings = service.state.data.agentSessions ||= {};
  return bindings[id] ||= { id, repository: repository.toLowerCase(), number, model: config.model,
    url: config.url, createdAt: new Date().toISOString() };
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
  if (!response.ok) throw Object.assign(new Error(`Agent feedback HTTP ${response.status}`), { status: response.status });
  const key = response.headers.get("x-goclaw-session-key");
  if (key) recordSession(service, binding, key);
  const body = await response.json();
  if (body.error) throw new Error("Agent returned a feedback error");
  recordSession(service, binding, body.session_key || key);
}
async function ensureSession(service, binding) {
  if (binding.sessionKey) return;
  // Bootstrap cannot run tools. A lost first response cannot submit a review.
  await informationalMessage(service, binding,
    `This is the persistent OCR routing session for ${binding.repository} PR #${binding.number}. Future commit events and review outcomes belong to this PR only. This message initializes context only; do not submit or retry any review. Reply ACK.`,
    `ocr-session-${binding.id}`);
}
function queueFeedback(service, job) {
  const outcome = require("./outcome.js").jobOutcome(job);
  if (!service.config.infrastructure?.agentDispatch?.url || job.settings?.preview || service.stopping) return;
  if (!service.repo(job.repository)?.requiresAgent && job.requestedBy !== service.config.infrastructure.agentDispatch.clientId) return;
  if (!outcome?.terminal &&
      !(job.state === "queued" && job.progress?.budgetExceeded)) return;
  const binding = bindingFor(service, job.repository, job.number);
  const id = hash([job.id, job.startedAt, job.attempt, job.state, job.retryBudget]);
  const outbox = service.state.data.agentFeedback ||= [];
  if (outbox.some((item) => item.id === id)) return;
  outbox.push({ id, bindingId: binding.id, repository: job.repository, number: job.number,
    jobId: job.id, state: "pending", attempts: 0, nextAt: 0, createdAt: new Date().toISOString(),
    payload: { repository: job.repository, pull_number: job.number, job_id: job.id, head_sha: job.head,
      base_sha: job.base, status: outcome.receiptState, outcome: outcome.kind, failure_phase: job.failurePhase, attempt: job.attempt, budget: job.retryBudget ?? job.settings?.options?.budget,
      budget_retries: job.budgetRetries || [], resume_recoveries: job.resumeFallbacks || [], coverage_complete: job.progress?.complete || false,
      findings: job.progress?.findings, summary_url: job.result?.summaryURL, error: job.error,
      automatic_retry_scheduled: job.state === "queued" } });
}
async function feedbackTick(service) {
  if (service.agentFeedbackRunning || service.stopping) return;
  const item = (service.state.data.agentFeedback || []).find((entry) => entry.state === "pending" && entry.nextAt <= Date.now());
  if (!item) return;
  service.agentFeedbackRunning = true;
  try {
    await withSession(service, item.repository, item.number, async (binding) => {
      if (service.stopping) return;
      if (binding.id !== item.bindingId) throw Object.assign(new Error("Agent configuration changed; feedback retained for reconciliation"), { status: 403 });
      item.attempts++; service.state.save();
      await ensureSession(service, binding);
      await informationalMessage(service, binding,
        `OCR execution feedback, informational only. The executor owns retries. Do not submit, retry or cancel review tasks. Do not publish comments. Store this outcome in this PR context and reply ACK. Event ID: ${item.id}\n${JSON.stringify(item.payload)}`,
        `ocr-feedback-${item.id}`);
      item.state = "sent"; item.sentAt = new Date().toISOString(); delete item.error;
    });
  } catch (error) {
    if (error.persistence) throw error;
    item.error = error.message;
    if ([400, 401, 403, 404, 422].includes(error.status)) item.state = "failed";
    else item.nextAt = Date.now() + Math.min(300, 2 ** Math.min(item.attempts, 9)) * 1000;
    service.log("agent_feedback_failed", { id: item.id, error: item.error });
  } finally { service.agentFeedbackRunning = false; service.state.save(); }
}
module.exports = { bindingFor, withSession, headers, recordSession, ensureSession, queueFeedback, feedbackTick };
