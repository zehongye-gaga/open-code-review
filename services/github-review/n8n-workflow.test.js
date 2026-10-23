// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { normalizeAcknowledgement, withAcknowledgementFallback } = require("./n8n-workflow.js");
const source = { envelope: { event: "pull_request", delivery_id: "delivery-test", signature: "original-signature", raw_body: "original-bytes" } };

test("only a correlated durable receipt is accepted; HTTP success alone is insufficient", () => {
  for (const state of ["pending", "dispatched", "ignored", "superseded"]) {
    assert.equal(normalizeAcknowledgement({ statusCode: 202, body: { delivery_id: "delivery-test", state } }, source).acknowledged, true);
  }
  for (const response of [undefined, {}, { error: "timeout" }, { statusCode: 200, body: "OK" },
    { statusCode: 204 }, { statusCode: 200, body: { accepted: true } },
    { statusCode: 302, body: { delivery_id: "delivery-test", state: "pending" } },
    { statusCode: 202, body: { delivery_id: "wrong", state: "pending" } },
    { statusCode: 202, body: { delivery_id: "delivery-test", state: "failed" } },
    { statusCode: 502, body: { delivery_id: "delivery-test", state: "pending" } }]) {
    const result = normalizeAcknowledgement(response, source);
    assert.equal(result.acknowledged, false);
    assert.ok(result.statusCode >= 400);
  }
  assert.equal(normalizeAcknowledgement({ statusCode: 200, body: { state: "ping", accepted: true } }, { envelope: { event: "ping" } }).acknowledged, true);
  assert.equal(normalizeAcknowledgement({ statusCode: 202, body: { state: "ignored", reason: "unsupported_event" } }, source).acknowledged, true);
});

test("workflow errors reach fallback with original bytes and both failures return an error", () => {
  const names = ["InsightFlow - Lex-CR Agent queue", "Other repositories - direct OCR", "Preserve signed GitHub payload", "Acknowledge durable acceptance", "Dispatch accepted", "Record dispatch failure"];
  const original = { nodes: names.map((name) => ({ name, parameters: { options: {} }, credentials: { httpHeaderAuth: { id: "credential-reference" } } })), connections: {} };
  const workflow = withAcknowledgementFallback(original);
  assert.equal(original.nodes.length, names.length);
  const node = (name) => workflow.nodes.find((entry) => entry.name === name);
  assert.equal(node(names[0]).onError, "continueRegularOutput");
  assert.equal(node(names[0]).retryOnFail, false);
  assert.equal(workflow.connections["Agent queue acknowledged?"].main[1][0].node, "Default OCR - missing queue ACK");
  const fallback = node("Default OCR - missing queue ACK");
  const body = vm.runInNewContext(`(${fallback.parameters.jsonBody.slice(3, -2)})`, { $: () => ({ first: () => ({ json: source }) }) });
  assert.equal(body.raw_body, source.envelope.raw_body); assert.equal(body.signature, source.envelope.signature);
  assert.equal(body.delivery_id, "delivery-test"); assert.equal(body.fallback, true); assert.equal(body.route, "agent");
  assert.equal(fallback.credentials.httpHeaderAuth.id, "credential-reference");
  const code = node("Validate default OCR ACK").parameters.jsCode;
  const [item] = vm.runInNewContext(`(function () { ${code} })()`, {
    $input: { first: () => ({ json: { error: "connection refused" } }) }, $: () => ({ first: () => ({ json: source }) }),
  });
  assert.equal(item.json.statusCode, 502); assert.equal(item.json.acknowledged, false);
  assert.throws(() => withAcknowledgementFallback(workflow), /already contains/);
});
