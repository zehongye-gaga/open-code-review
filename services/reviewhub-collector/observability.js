// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const { randomUUID } = require("node:crypto");
const { jobOutcome, receiptOutcome } = require("../github-review/outcome.js");
const { digest, iso } = require("./normalize.js");
const instanceId = randomUUID();
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
