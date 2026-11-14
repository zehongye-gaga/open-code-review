// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const { jobOutcome, receiptOutcome } = require("../github-review/outcome.js");
const { digest, iso } = require("./normalize.js");
const instanceId = randomUUID();
const ajv = new Ajv({ strict: false });
addFormats(ajv);
const validateRetryEvent = ajv.compile(
  require("./audit-ingestion-v1.schema.json").properties.signals.items
    .properties.retryEvents.items,
);
const reasonCodes = new Set([
  "n8n_tracking_stalled",
  "review_deadline_exceeded",
  "repository_access_failed",
  "dispatch_configuration_or_access_error",
  "dispatch_retries_exhausted",
  "admission_retries_exhausted",
  "admission_deadline_exceeded",
  "review_incomplete_or_failed",
  "repository_not_allowed",
  "client_scope_denied",
  "native_execution_timeout",
  "agent_ack_timeout",
  "publication_failed",
  "execution_failed",
  "dispatch_failed",
  "admission_failed",
  "upstream_unavailable",
  "cancelled",
  "superseded",
  "checkpointed",
  "policy_skip",
  "preview_only",
  "no_reviewable_items",
  "repository_not_enabled",
  "target_branch_not_allowed",
]);
const reasonCode = (value, fallback) =>
  reasonCodes.has(value) ? value : fallback;
const diagnosticLimit = 262144;
function redactDiagnostic(value) {
  return value
    .replace(
      /(\b[\w.-]*(?:api[_-]?key|token|secret|password)\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(?:github_pat_|gh[pousr]_|goclaw_|xox[baprs]-)[A-Za-z0-9_.-]+/g,
      "[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]")
    .replace(/(\b(?:Bearer|Basic)[ \t]+)[^\s"'<>;,]+/gi, "$1[REDACTED]")
    .replace(
      /https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[^\s"'<>]+/gi,
      "[WEBHOOK REDACTED]",
    )
    .replace(
      /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
      "[PRIVATE KEY REDACTED]",
    );
}
function diagnostic(message, evidence, directory) {
  if (typeof message !== "string" || !message.length) return null;
  const references = Array.isArray(evidence) ? evidence : [];
  const artifacts = [
    ...new Set(
      references
        .filter(
          (value) =>
            typeof value === "string" &&
            value.length > 0 &&
            value.length <= 1000 &&
            !/[\r\n\0]/.test(value),
        )
        .map(redactDiagnostic)
        .filter((value) => value.length <= 1000),
    ),
  ].slice(0, 8);
  if (
    !artifacts.length &&
    typeof directory === "string" &&
    path.isAbsolute(directory) &&
    !/[\r\n\0]/.test(directory)
  ) {
    const fallback = redactDiagnostic(path.join(directory, "result.json"));
    if (fallback.length <= 1000) artifacts.push(fallback);
  }
  let body = redactDiagnostic(message);
  if (body.length > diagnosticLimit) {
    const suffix = `\n[Diagnostic truncated by collector; full text remains in ${artifacts.length ? "the referenced source artifacts" : "source task artifacts (reference unavailable)"}.]`;
    body =
      body
        .slice(0, diagnosticLimit - suffix.length)
        .replace(/[\uD800-\uDBFF]$/, "") + suffix;
  }
  return { message: body, artifacts };
}
function retryEvents(job, signalId) {
  if (!Array.isArray(job.contextRetries)) return [];
  const entries = new Map(),
    conflicts = new Set();
  for (const retry of job.contextRetries) {
    if (!retry || typeof retry !== "object") continue;
    const detail = diagnostic(retry.reason, retry.artifacts, retry.directory);
    if (!detail) continue;
    const event = {
      id: "retry:" + digest(JSON.stringify([signalId, retry.attempt])),
      attempt: retry.attempt,
      maxAttempts: retry.maxAttempts,
      fromTokens: retry.from,
      toTokens: retry.to,
      at: retry.at,
      diagnostic: detail,
    };
    if (!validateRetryEvent(event) || event.toTokens !== event.fromTokens * 2)
      continue;
    event.at = iso(event.at);
    if (!event.at) continue;
    const previous = entries.get(retry.attempt);
    if (previous && JSON.stringify(previous) !== JSON.stringify(event))
      conflicts.add(retry.attempt);
    entries.set(retry.attempt, event);
  }
  return [...entries.values()]
    .filter((event) => !conflicts.has(event.attempt))
    .sort((a, b) => a.attempt - b.attempt);
}
function operationalSignals(state, batch) {
  const repos = new Map(
    batch.repositories.flatMap((r) =>
      [r.name, ...r.aliases].map((n) => [n.toLowerCase(), r]),
    ),
  );
  const runs = new Map(batch.runs.map((r) => [r.sourceJobId, r.id]));
  const jobs = new Map((state.jobs || []).map((j) => [String(j.id), j]));
  const rows = new Map();
  function add(record, kind, entity, result, extra = {}) {
    const repo = repos.get(record.repository?.toLowerCase()),
      prNumber = record.number || record.pull_number;
    if (!repo || !Number.isSafeInteger(prNumber) || prNumber < 1) return;
    const stage =
      kind === "admission"
        ? "admission"
        : kind === "dispatch"
          ? "dispatch"
          : result?.kind === "publication_failed"
            ? "publication"
            : record.state === "queued"
              ? "queue"
              : "execution";
    const state = result?.alert
      ? "failed"
      : ["complete", "blocked"].includes(result?.kind)
        ? "succeeded"
        : result?.kind === "skipped"
          ? "cancelled"
          : result?.kind === "retrying"
            ? "queued"
            : ["queued", "running", "cancelled", "superseded"].includes(
                  result?.kind,
                )
              ? result.kind
              : "unknown";
    const id = "signal:" + digest(JSON.stringify([repo.id, kind, entity]));
    const retries = kind === "review" ? retryEvents(record, id) : [];
    const failure =
      kind === "review" && state === "failed"
        ? diagnostic(
            record.failureDiagnostics?.message,
            record.failureDiagnostics?.artifacts,
            record.directory,
          )
        : null;
    rows.set(id, {
      id,
      repositoryId: repo.id,
      entityId: String(entity),
      kind,
      runId: runs.get(String(record.jobId || record.id)) || null,
      requestId: record.request_id || record.ciRequestId || null,
      generation: null,
      previousNotificationId:
        kind === "review" ? `job:${record.id}:failed` : null,
      prNumber,
      headSha: record.head_sha || record.head || null,
      baseSha: record.base_sha || record.base || null,
      baseRef: record.base_ref || record.baseRef || null,
      stage,
      state,
      reason: result?.reason
        ? reasonCode(
            result.reason,
            result.alert ? "unclassified_failure" : null,
          )
        : null,
      changedAt: iso(record.finishedAt || record.updatedAt || record.createdAt),
      startedAt: iso(
        state === "running"
          ? record.startedAt
          : record.updatedAt || record.createdAt,
      ),
      current: true,
      ...(retries.length ? { retryEvents: retries } : {}),
      ...(failure ? { failureDiagnostic: failure } : {}),
      ...extra,
    });
  }
  for (const job of jobs.values())
    add(
      job,
      "review",
      [job.id, iso(job.createdAt), job.head || ""].join(":"),
      jobOutcome(job),
    );
  for (const [kind, receipts] of [
    ["ci", Object.values(state.ciReceipts || {})],
    ["webhook", state.deliveries || []],
  ]) {
    for (const receipt of receipts) {
      const job = jobs.get(String(receipt.jobId)),
        admission = receipt.pendingAdmission || receipt.lastAdmission;
      const identity = `${kind}:${receipt.request_id || receipt.id}:${iso(receipt.createdAt)}`;
      if (
        admission &&
        Number.isSafeInteger(admission.generation) &&
        admission.generation > 0
      ) {
        add(receipt, "admission", identity + ":" + admission.generation, null, {
          generation: admission.generation,
          previousNotificationId: `${kind}:${receipt.request_id || receipt.id}:admission:${admission.generation}`,
          state: ["cancelled", "superseded", "skipped"].includes(receipt.state)
            ? "cancelled"
            : admission.state === "failed"
              ? "failed"
              : receipt.pendingAdmission
                ? "queued"
                : "succeeded",
          reason: reasonCode(
            admission.reason || receipt.reason,
            admission.state === "failed" ? "admission_failed" : null,
          ),
          changedAt: iso(admission.finishedAt || admission.requestedAt),
          startedAt: iso(admission.requestedAt),
        });
      }
      // A linked job owns execution failures; do not notify the same failure twice.
      if (!job && !admission)
        add(receipt, "dispatch", identity, receiptOutcome(receipt, null), {
          previousNotificationId: `${kind}:${receipt.request_id || receipt.id}:${receipt.createdAt}`,
        });
    }
  }
  return [...rows.values()];
}
function metric(sourceId, component, dimension, values, now, from = now) {
  const at = new Date(now).toISOString();
  return {
    id: `${component}:${instanceId}:${at}:${dimension}`,
    sourceId,
    component,
    dimension,
    instanceId,
    from: new Date(from).toISOString(),
    at,
    values,
    histograms: [],
    completeness: "partial",
  };
}
function hostMetrics(sourceId, resource, now) {
  if (!resource) return [];
  const ratio = (used, total) =>
    Number.isFinite(used) && total > 0
      ? Math.max(0, Math.min(100, (used / total) * 100))
      : null;
  return [
    metric(
      sourceId,
      "review_host",
      "host",
      {
        cpu_percent: Number.isFinite(resource.cpu?.busy)
          ? Math.max(0, resource.cpu.busy)
          : null,
        io_wait_percent: Number.isFinite(resource.cpu?.iowait)
          ? Math.max(0, resource.cpu.iowait)
          : null,
        memory_percent: ratio(
          resource.memoryTotalBytes - resource.memoryAvailableBytes,
          resource.memoryTotalBytes,
        ),
      },
      now,
    ),
    ...(resource.volumes || []).map((v) =>
      metric(
        sourceId,
        "review_host",
        v.label,
        {
          disk_percent: ratio(v.totalBytes - v.availableBytes, v.totalBytes),
        },
        now,
      ),
    ),
  ];
}
module.exports = { operationalSignals, metric, hostMetrics };
