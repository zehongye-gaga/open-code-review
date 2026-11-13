// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const { createHash } = require("node:crypto");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const ajv = new Ajv({ strict: false });
addFormats(ajv);
const string = { type: ["string", "null"], maxLength: 500 };
const validate = ajv.compile({
  type: "object",
  additionalProperties: false,
  required: ["schema", "event", "sequence", "at", "repository", "run_id", "run_attempt"],
  properties: {
    schema: { const: "ocr-policy-telemetry/v1" },
    event: { enum: ["ocr_client_started", "ocr_gateway_request", "ocr_client_result"] },
    sequence: { type: "integer", minimum: 1, maximum: 1000 },
    at: { type: "string", format: "date-time" },
    repository: string,
    repository_id: string,
    run_id: string,
    run_attempt: string,
    job: string,
    workflow_ref: string,
    request_id: string,
    pull_number: { type: "integer", minimum: 1 },
    head_sha: { type: "string", pattern: "^[a-f0-9]{40}$" },
    base_sha: { type: "string", pattern: "^[a-f0-9]{40}$" },
    base_ref: { type: "string", minLength: 1, maxLength: 240 },
    elapsed_ms: { type: "integer", minimum: 0, maximum: 86400000 },
    operation: { enum: ["ocr-ci-submit", "ocr-ci-status"] },
    attempt: { type: "integer", minimum: 1, maximum: 4 },
    http_status: {
      anyOf: [{ type: "integer", minimum: 100, maximum: 599 }, { type: "null" }]
    },
    error: string,
    error_code: string,
    retry_delay_seconds: { type: ["number", "null"], minimum: 0 },
    outcome: { enum: ["accepted", "skipped", "timeout", "failed"] },
    reason: { type: ["string", "null"], maxLength: 100 }
  }
});
function snapshot(row) {
  if (
    !row.request_id ||
    !row.head_sha ||
    !row.base_sha ||
    !row.base_ref ||
    !row.pull_number
  )
    return null;
  const identity = {
    base_ref: row.base_ref,
    base_sha: row.base_sha,
    head_sha: row.head_sha,
    pull_number: row.pull_number,
    repository: row.repository.toLowerCase()
  };
  const json = JSON.stringify(identity).replace(
    /[\u007f-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
  );
  return "ocr-ci-" + createHash("sha256").update(json).digest("hex") === row.request_id
    ? identity
    : null;
}
function parseClientLog(log, context) {
  const records = new Map();
  let invalid = false;
  for (const line of log.split(/\r?\n/)) {
    const text = line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, "");
    if (!text.startsWith("{") || text.length > 16000) continue;
    let row;
    try {
      row = JSON.parse(text);
    } catch {
      continue;
    }
    if (row?.schema !== "ocr-policy-telemetry/v1") continue;
    if (
      !validate(row) ||
      ![context.repository, ...(context.aliases || [])]
        .map((v) => v.toLowerCase())
        .includes(row.repository?.toLowerCase()) ||
      row.run_id !== context.runId ||
      row.run_attempt !== String(context.attempt) ||
      (context.repositoryId && row.repository_id !== context.repositoryId)
    ) {
      invalid = true;
      continue;
    }
    if (row.request_id && !snapshot(row)) {
      invalid = true;
      continue;
    }
    const previous = records.get(row.sequence);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) invalid = true;
    records.set(row.sequence, row);
  }
  const rows = [...records.values()].sort((a, b) => a.sequence - b.sequence);
  const finals = rows.filter((r) => r.event === "ocr_client_result");
  const final = finals.length === 1 ? finals[0] : null;
  const identity = rows.find((r) => snapshot(r));
  if (rows.some((r) => r.request_id && identity && r.request_id !== identity.request_id))
    invalid = true;
  if (rows.some((r, i) => r.sequence !== i + 1)) invalid = true;
  if (
    final &&
    (final !== rows.at(-1) ||
      !Number.isInteger(final.elapsed_ms) ||
      !final.outcome ||
      (final.outcome === "timeout" && final.reason !== "ack_deadline_exceeded") ||
      (["accepted", "skipped", "timeout"].includes(final.outcome) && !snapshot(final)) ||
      (final.outcome === "skipped" && final.reason !== "repository_not_enabled"))
  )
    invalid = true;
  const requests = [];
  for (const row of rows.filter((r) => r.event === "ocr_gateway_request")) {
    if (!row.operation || !row.attempt || !Number.isInteger(row.elapsed_ms)) {
      invalid = true;
      continue;
    }
    requests.push({
      sequence: row.sequence,
      operation: row.operation === "ocr-ci-submit" ? "submit" : "status",
      attempt: row.attempt,
      elapsedMs: row.elapsed_ms,
      httpStatus: row.http_status ?? null,
      errorCode: row.error_code?.slice(0, 100) || null,
      at: row.at
    });
  }
  const complete = !!final && !invalid;
  return {
    prNumber: identity?.pull_number || null,
    requestId: identity?.request_id || null,
    headSha: identity?.head_sha || null,
    baseSha: identity?.base_sha || null,
    baseRef: identity?.base_ref || null,
    outcome: complete ? final.outcome : context.cancelled ? "cancelled" : "unknown",
    reason: invalid
      ? "invalid_client_log"
      : complete
        ? final.reason || null
        : "final_result_missing",
    elapsedMs: complete ? final.elapsed_ms : null,
    finishedAt: complete ? final.at : null,
    coverage: complete ? "complete" : rows.length ? "partial" : "missing",
    requests: invalid ? [] : requests
  };
}
module.exports = { parseClientLog, snapshot };
