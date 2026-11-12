// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const { createHash } = require("node:crypto");
const iso = (value) => {
  const n = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
};
function backendAdmissions(state, batch) {
  const byRequest = new Map(),
    events = new Map();
  const repositories = new Map(
    batch.repositories.flatMap((r) => [r.name, ...r.aliases].map((name) => [name, r]))
  );
  const runs = new Map(
    batch.runs.map((r) => [r.repositoryId + ":" + r.sourceJobId, r.id])
  );
  const repoFor = (name) => repositories.get(name?.toLowerCase());
  const runFor = (job, repo) => runs.get(repo.id + ":" + job) || null;
  function event(repo, receipt, stage, status, at, generation, reason, jobId) {
    at = iso(at);
    const prNumber = receipt.pull_number || receipt.number;
    if (!repo || !at || !Number.isSafeInteger(prNumber) || prNumber < 1) return;
    const requestId = receipt.request_id || null;
    const id =
      "backend:" +
      createHash("sha256")
        .update(
          JSON.stringify([
            repo.id,
            requestId || receipt.id,
            stage,
            status,
            at,
            generation
          ])
        )
        .digest("hex");
    events.set(id, {
      id,
      repositoryId: repo.id,
      runId: runFor(jobId, repo),
      prNumber,
      headSha: receipt.head_sha || receipt.head || null,
      stage,
      state: status,
      at,
      message: null,
      requestId,
      generation,
      reason
    });
  }
  for (const receipt of Object.values(state.ciReceipts || {})) {
    const repo = repoFor(receipt.repository);
    if (!repo || !receipt.request_id) continue;
    const history = [
      ...(receipt.admissionHistory || []).map((r) => ({
        ...r,
        admission: r.pendingAdmission || r.lastAdmission
      })),
      ...(receipt.reopenHistory || []),
      ...(receipt.retryHistory || []),
      { ...receipt, admission: receipt.pendingAdmission || receipt.lastAdmission }
    ];
    const entries = new Map();
    for (const record of history) {
      const admission = record.admission;
      const at = iso(admission?.requestedAt || record.createdAt);
      if (!at) continue;
      const generation =
        Number.isSafeInteger(admission?.generation) && admission.generation > 0
          ? admission.generation
          : null;
      const key = `${at}:${generation}`;
      const state = admission?.state || record.state || "accepted";
      const entry = {
        generation,
        acceptedAt: at,
        runId: runFor(record.jobId, repo),
        state,
        reused: record.dispatchMethod ? record.dispatchMethod === "reused_existing" : null
      };
      entries.set(key, entry);
      if (generation)
        event(
          repo,
          receipt,
          "admission",
          record.reason === "repository_not_enabled" ? "skipped" : "generation_accepted",
          at,
          generation,
          null,
          record.jobId
        );
      if (admission?.reason === "admission_deadline_exceeded")
        event(
          repo,
          receipt,
          "admission",
          "timeout",
          admission.finishedAt,
          generation,
          admission.reason,
          record.jobId
        );
      if (entry.reused)
        event(repo, receipt, "dispatch", "reused", at, generation, null, record.jobId);
    }
    byRequest.set(receipt.request_id, {
      repositoryId: repo.id,
      headSha: receipt.head_sha,
      baseSha: receipt.base_sha,
      prNumber: receipt.pull_number,
      entries: [...entries.values()]
    });
  }
  for (const receipt of [
    ...Object.values(state.ciReceipts || {}),
    ...(state.deliveries || [])
  ]) {
    if (receipt.fallbackReason === "agent_ack_timeout")
      event(
        repoFor(receipt.repository),
        receipt,
        "dispatch",
        "timeout",
        receipt.fallbackAt,
        receipt.admissionGeneration || null,
        "agent_ack_timeout",
        receipt.jobId
      );
  }
  for (const job of state.jobs || [])
    for (const end of job.executionOutcomes || []) {
      if (end.reason === "native_execution_timeout")
        event(
          repoFor(job.repository),
          { ...job, request_id: job.ciRequestId },
          "execution",
          "timeout",
          end.at,
          null,
          end.reason,
          job.id
        );
    }
  return {
    events: [...events.values()],
    associate(attempt) {
      const backend = byRequest.get(attempt.requestId);
      return backend &&
        backend.repositoryId === attempt.repositoryId &&
        backend.headSha === attempt.headSha &&
        backend.baseSha === attempt.baseSha &&
        backend.prNumber === attempt.prNumber
        ? [
            ...new Map(
              [...(attempt.backend || []), ...backend.entries].map((r) => [
                r.acceptedAt + ":" + r.generation,
                r
              ])
            ).values()
          ]
        : attempt.backend || [];
    }
  };
}
module.exports = { backendAdmissions };
