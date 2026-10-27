// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { normalizeAcknowledgement, withBackendControl } = require("./n8n-workflow.js");
const source = { envelope: { event: "pull_request", delivery_id: "delivery-test", signature: "original-signature", raw_body: "original-bytes" } };

test("only a correlated durable receipt is accepted; HTTP success alone is insufficient", () => {
  for (const state of ["pending", "dispatched", "expanded", "ignored", "superseded", "failed"]) {
    assert.equal(normalizeAcknowledgement({ statusCode: 202, body: { delivery_id: "delivery-test", state } }, source).acknowledged, true);
  }
  for (const response of [undefined, {}, { error: "timeout" }, { statusCode: 200, body: "OK" },
    { statusCode: 204 }, { statusCode: 200, body: { accepted: true } },
    { statusCode: 302, body: { delivery_id: "delivery-test", state: "pending" } },
    { statusCode: 202, body: { delivery_id: "wrong", state: "pending" } },
    { statusCode: 502, body: { delivery_id: "delivery-test", state: "pending" } }]) {
    const result = normalizeAcknowledgement(response, source);
    assert.equal(result.acknowledged, false);
    assert.ok(result.statusCode >= 400);
  }
  assert.equal(normalizeAcknowledgement({ statusCode: 200, body: { state: "ping", accepted: true } }, { envelope: { event: "ping" } }).acknowledged, true);
  assert.equal(normalizeAcknowledgement({ statusCode: 202, body: { state: "ignored", reason: "unsupported_event" } }, source).acknowledged, true);
});

test("gateway transformation removes orchestration and preserves credentials and original bytes", () => {
  const names = ["GitHub Webhook", "Preserve signed GitHub payload", "InsightFlow - Lex-CR Agent queue", "Validate Agent queue ACK", "Acknowledge durable acceptance", "CI Submit Webhook", "CI Normalize submission", "CI Accept Agent task", "CI Respond acceptance", "CI Receipt Status Webhook", "CI Normalize receipt query", "CI Query receipt", "CI Respond receipt status", "CI Draft rollout notes"];
  const original = { nodes: [...names, "CI Wait 30 seconds", "Default OCR - missing queue ACK"].map(name => ({ name, parameters: { options: {}, jsCode: "const keys = ['base_ref'];", jsonBody: "original-body" }, credentials: { httpHeaderAuth: { id: "retained" } } })), connections: {} };
  const workflow = withBackendControl(original);
  assert.equal(workflow.nodes.length,14); assert.equal(original.nodes.length,16);
  assert.ok(!JSON.stringify(workflow.connections).includes("CI Wait"));
  const node = name => workflow.nodes.find(n => n.name === name);
  assert.equal(node("CI Accept Agent task").credentials.httpHeaderAuth.id,"retained");
  assert.equal(node("InsightFlow - Lex-CR Agent queue").parameters.jsonBody,"original-body");
  assert.match(node("CI Normalize submission").parameters.jsCode,/retry_key/);
  const [item] = vm.runInNewContext(`(function(){${node("Validate Agent queue ACK").parameters.jsCode}})()`, {
    $input: { first: () => ({ json: { error: "timeout" } }) }, $: () => ({ first: () => ({ json: source }) }) });
  assert.equal(item.json.statusCode,502);
  assert.equal(workflow.connections["CI Respond acceptance"],undefined);
});
