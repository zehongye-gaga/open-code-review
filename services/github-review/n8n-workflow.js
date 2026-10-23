// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";
const crypto = require("node:crypto");

function normalizeAcknowledgement(response, source) {
  const status = response?.statusCode, body = response?.body;
  const success = Number.isInteger(status) && status >= 200 && status < 300;
  const structured = body && typeof body === "object" && !Array.isArray(body);
  const receipt = structured && body.delivery_id === source.envelope.delivery_id &&
    ["pending", "dispatched", "ignored", "superseded"].includes(body.state);
  const ping = structured && source.envelope.event === "ping" && body.state === "ping" && body.accepted === true;
  const ignored = structured && body.state === "ignored" && body.reason === "unsupported_event";
  const acknowledged = Boolean(success && (receipt || ping || ignored));
  return { acknowledged, statusCode: acknowledged ? status : Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502,
    body: acknowledged ? body : { error: "Review dispatch was not acknowledged", delivery_id: source.envelope.delivery_id } };
}

function withAcknowledgementFallback(original) {
  const workflow = structuredClone(original);
  const names = {
    agent: "InsightFlow - Lex-CR Agent queue", direct: "Other repositories - direct OCR",
    source: "Preserve signed GitHub payload", respond: "Acknowledge durable acceptance",
    validateAgent: "Validate Agent queue ACK", check: "Agent queue acknowledged?",
    fallback: "Default OCR - missing queue ACK", validateDefault: "Validate default OCR ACK",
  };
  const find = (name) => {
    const node = workflow.nodes.find((entry) => entry.name === name);
    if (!node) throw new Error(`Missing expected workflow node: ${name}`);
    return node;
  };
  const agent = find(names.agent), direct = find(names.direct);
  for (const name of [names.source, names.respond]) find(name);
  for (const name of [names.validateAgent, names.check, names.fallback, names.validateDefault]) {
    if (workflow.nodes.some((node) => node.name === name)) throw new Error("Workflow already contains ACK fallback nodes");
  }
  for (const node of [agent, direct]) {
    node.retryOnFail = false; delete node.maxTries; delete node.waitBetweenTries;
    node.onError = "continueRegularOutput";
    node.alwaysOutputData = true;
    node.parameters.options.timeout = node === agent ? 3000 : 5000;
    node.parameters.options.response = { response: { fullResponse: true, neverError: true, responseFormat: "json" } };
  }
  agent.notes = "Durable ingress ACK is checked here. The server waits up to 180 seconds for a verified InsightFlow OCR task, then uses the repository default review if no task was acknowledged. Delivery identity fences late Agent requests.";
  agent.notesInFlow = true;
  const create = (name, type, typeVersion, position, parameters) => ({ id: crypto.randomUUID(), name,
    type: `n8n-nodes-base.${type}`, typeVersion, position, parameters });
  const validation = (name, position) => create(name, "code", 2, position, {
    jsCode: `const normalizeAcknowledgement = ${normalizeAcknowledgement.toString()};\nreturn [{ json: normalizeAcknowledgement($input.first().json, $('${names.source}').first().json) }];`,
  });
  const fallback = structuredClone(direct);
  Object.assign(fallback, { id: crypto.randomUUID(), name: names.fallback, position: [1420, -120],
    notes: "Reuse the original signed envelope and delivery ID. The server permits fallback only for opted-in repositories and deduplicates late Agent submissions." });
  fallback.parameters.jsonBody = `={{ { ...$('${names.source}').first().json.envelope, route: "agent", fallback: true } }}`;
  workflow.nodes.push(validation(names.validateAgent, [930, -300]),
    create(names.check, "if", 2.2, [1170, -300], { conditions: { options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2 },
      conditions: [{ id: crypto.randomUUID(), leftValue: "={{ $json.acknowledged }}", rightValue: true,
        operator: { type: "boolean", operation: "true", singleValue: true } }], combinator: "and" }, options: {} }),
    fallback, validation(names.validateDefault, [1670, 100]));
  agent.position = [690, -300]; direct.position = [690, 260];
  find(names.respond).position = [1910, -200];
  find("Dispatch accepted").position = [2140, -200];
  find("Record dispatch failure").position = [2370, -100];
  const edge = (name) => ({ node: name, type: "main", index: 0 });
  Object.assign(workflow.connections, {
    [names.agent]: { main: [[edge(names.validateAgent)]] },
    [names.validateAgent]: { main: [[edge(names.check)]] },
    [names.check]: { main: [[edge(names.respond)], [edge(names.fallback)]] },
    [names.fallback]: { main: [[edge(names.validateDefault)]] },
    [names.direct]: { main: [[edge(names.validateDefault)]] },
    [names.validateDefault]: { main: [[edge(names.respond)]] },
  });
  return workflow;
}
module.exports = { normalizeAcknowledgement, withAcknowledgementFallback };
