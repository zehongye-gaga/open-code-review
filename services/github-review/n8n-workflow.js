// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";
const crypto = require("node:crypto");

function normalizeAcknowledgement(response, source) {
  const status = response?.statusCode, body = response?.body;
  const success = Number.isInteger(status) && status >= 200 && status < 300;
  const structured = body && typeof body === "object" && !Array.isArray(body);
  const receipt = structured && body.delivery_id === source.envelope.delivery_id &&
    ["pending", "dispatched", "expanded", "ignored", "superseded", "failed"].includes(body.state);
  const ping = structured && source.envelope.event === "ping" && body.state === "ping" && body.accepted === true;
  const ignored = structured && body.state === "ignored" && body.reason === "unsupported_event";
  const acknowledged = Boolean(success && (receipt || ping || ignored));
  return { acknowledged, statusCode: acknowledged ? status : Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502,
    body: acknowledged ? body : { error: "Review dispatch was not acknowledged", delivery_id: source.envelope.delivery_id } };
}

function withBackendControl(original) {
  const workflow = structuredClone(original);
  const keep = ["GitHub Webhook", "Preserve signed GitHub payload", "InsightFlow - Lex-CR Agent queue",
    "Validate Agent queue ACK", "Acknowledge durable acceptance", "CI Submit Webhook", "CI Normalize submission",
    "CI Accept Agent task", "CI Respond acceptance", "CI Receipt Status Webhook", "CI Normalize receipt query",
    "CI Query receipt", "CI Respond receipt status", "CI Draft rollout notes"];
  const node = (name) => {
    const value = workflow.nodes.find((entry) => entry.name === name);
    if (!value) throw new Error(`Missing expected workflow node: ${name}`);
    return value;
  };
  keep.forEach(node);
  workflow.nodes = workflow.nodes.filter((entry) => keep.includes(entry.name));
  workflow.connections = {};
  const connect = (...names) => names.slice(0, -1).forEach((name, i) => {
    workflow.connections[name] = { main: [[{ node: names[i + 1], type: "main", index: 0 }]] };
  });
  connect("GitHub Webhook", "Preserve signed GitHub payload", "InsightFlow - Lex-CR Agent queue",
    "Validate Agent queue ACK", "Acknowledge durable acceptance");
  connect("CI Submit Webhook", "CI Normalize submission", "CI Accept Agent task", "CI Respond acceptance");
  connect("CI Receipt Status Webhook", "CI Normalize receipt query", "CI Query receipt", "CI Respond receipt status");
  const submit = node("CI Normalize submission");
  submit.parameters.jsCode = submit.parameters.jsCode.replace("'base_ref'", "'base_ref','retry_key','source'");
  node("Validate Agent queue ACK").parameters.jsCode = `const normalizeAcknowledgement = ${normalizeAcknowledgement.toString()};
return [{ json: normalizeAcknowledgement($input.first().json, $('Preserve signed GitHub payload').first().json) }];`;
  for (const name of ["InsightFlow - Lex-CR Agent queue", "CI Accept Agent task", "CI Query receipt"]) {
    const request = node(name);
    request.parameters.options.timeout = 12000;
    request.retryOnFail = true; request.maxTries = 2; request.waitBetweenTries = 1000;
    request.onError = "continueRegularOutput"; request.alwaysOutputData = true;
    request.notes = "Transport only. The backend owns durable scheduling, policy, fallback and recovery.";
  }
  for (const name of ["CI Respond acceptance", "CI Respond receipt status"]) {
    node(name).parameters.responseBody = '={{ $json.body || { error: "OCR transport unavailable" } }}';
    node(name).parameters.options.responseCode = '={{ $json.statusCode || 502 }}';
  }
  const rows = [["GitHub Webhook", "Preserve signed GitHub payload", "InsightFlow - Lex-CR Agent queue", "Validate Agent queue ACK", "Acknowledge durable acceptance"],
    ["CI Submit Webhook", "CI Normalize submission", "CI Accept Agent task", "CI Respond acceptance"],
    ["CI Receipt Status Webhook", "CI Normalize receipt query", "CI Query receipt", "CI Respond receipt status"]];
  rows.forEach((names, y) => names.forEach((name, x) => { node(name).position = [x * 280, y * 300]; }));
  Object.assign(node("CI Draft rollout notes"), { position: [0, -300] });
  node("CI Draft rollout notes").parameters.content = "## OCR transport gateway\nBackend contract v2: durable acceptance transfers scheduling and recovery to the backend. No polling loop or transport-triggered Agent fallback. CI gates admission only; ocr-review reports the verdict. Backend structured logs retain request and delivery IDs without credential payloads.";
  return workflow;
}
module.exports = { normalizeAcknowledgement, withBackendControl };
