// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const { fail } = require("./options.js");
const { receiptTerminal, isRepositorySkip, isBranchSkip } = require("./outcome.js");
const { dispatchFailure, dispatchRetry } = require("./dispatch-control.js");
const { sameRepository, sameSnapshot, closedReceipt, receiptOwner, hasNewerReceipt } = require("./repositories.js");

function queueAdmission(ci, normalized, route, retryKey) {
  if (retryKey !== undefined && (typeof retryKey !== "string" || !/^[0-9]+:[0-9]+$/.test(retryKey) || retryKey.length > 80)) fail("Invalid retry key");
  let r = ci.receipts[normalized.request_id];
  const repository = ci.s.repo(normalized.repository);
  if (!repository) {
    let skipped = false;
    if (!r?.jobId && !(r && isRepositorySkip(r))) {
      r = ci.createReceipt(normalized, route, r);
      r.state = "skipped"; r.reason = "repository_not_enabled"; r.finishedAt = Date.now();
      skipped = true;
    }
    ci.s.state.save();
    if (skipped) ci.s.log("ci_repository_skipped", { repository: r.repository, number: r.pull_number, request_id: r.request_id });
    return ci.view(r);
  }
  let kind;
  if (!r || isRepositorySkip(r)) {
    const previous = repository.githubName && Object.values(ci.receipts).map(peer => receiptOwner(ci.s, peer)).find(peer =>
      peer.repository !== normalized.repository && closedReceipt(peer) && sameSnapshot(ci.s, peer, normalized));
    r = ci.createReceipt(normalized, route, r); r.admissionVerified = false; kind = "new";
    if (previous) {
      r.state = previous.state; r.reason = previous.reason; r.jobId = previous.jobId;
      r.predecessorReceipt = previous.request_id; kind = "reopen";
    }
  } else if (r.successorReceipt) {
    const owner = receiptOwner(ci.s, r);
    if (owner !== r && !owner.pendingAdmission && closedReceipt(owner)) {
      r.state = owner.state; r.reason = owner.reason; r.jobId = owner.jobId;
      r.predecessorReceipt = owner.request_id; delete r.successorReceipt; kind = "reopen";
    }
  }
  const newKey = retryKey !== undefined && Number(retryKey.split(":")[1]) >= 2 && !(r.retryKeys || []).includes(retryKey);
  const job = r.jobId && ci.s.state.data.jobs.find(candidate => candidate.id === r.jobId);
  const reusable = (!r.jobId || job) && (!job || !job.replacement && ["cancelled", "complete"].includes(job.state));
  const failedReopen = r.state === "failed" && r.lastAdmission?.state === "failed" && r.lastAdmission.kind === "reopen";
  if (!r.pendingAdmission && !kind) {
    if (failedReopen && reusable && newKey) kind = "reopen";
    else if (r.state === "failed" && !r.jobId && newKey) kind = "retry";
    else if (isBranchSkip(r) && reusable && !hasNewerReceipt(ci.s, r)) kind = "reopen";
    else if (r.state === "superseded" && reusable && ["pr_closed", "pr_changed_or_closed"].includes(r.reason) &&
        !hasNewerReceipt(ci.s, r)) kind = "reopen";
  }
  if (newKey) { r.retryKeys ||= []; r.retryKeys.push(retryKey); }
  if (kind) {
    r.admissionGeneration = (r.admissionGeneration || 0) + 1;
    const sequence = kind === "new" ? r.sequence : ++ci.s.state.data.sequence;
    r.pendingAdmission = { kind, generation: r.admissionGeneration, sequence, requestedAt: Date.now(), attempts: 0, nextAt: 0 };
  }
  ci.s.state.save();
  if (kind) ci.s.log("ci_admission_queued", { id: r.request_id, kind, generation: r.admissionGeneration });
  return ci.view(r);
}

function resetFailed(ci, r, sequence) {
  if (r.state !== "failed" || r.jobId) return;
  if (ci.dispatching.has(r.request_id)) fail("Previous PR dispatch is still stopping; retry acceptance", 503);
  r.retryHistory ||= [];
  r.retryHistory.push({ state: r.state, reason: r.reason, finishedAt: r.finishedAt,
    dispatchAttempts: r.dispatchAttempts, admission: r.lastAdmission });
  r.state = "accepted"; r.createdAt = Date.now(); r.nextDispatchAt = 0; r.dispatchAttempts = 0;
  r.sequence = sequence;
  for (const key of ["reason", "finishedAt", "finalStatus", "published", "lastDispatchError"]) delete r[key];
}

async function verifyAdmission(ci, r) {
  const pending = r.pendingAdmission;
  if (!pending || ci.verifyingAdmissions.has(r.request_id)) return;
  const start = pending.kind === "new" ? r.createdAt : pending.requestedAt;
  if (Date.now() - start > (ci.config.totalSeconds || 7200) * 1000) {
    ci.stop(r, "failed", "admission_deadline_exceeded"); return;
  }
  if (Date.now() < pending.nextAt) return;
  if (pending.attempts >= 8) { ci.stop(r, "failed", "admission_retries_exhausted"); return; }
  const current = () => ci.receipts[r.request_id] === r && r.pendingAdmission === pending && r.admissionGeneration === pending.generation;
  ci.verifyingAdmissions.add(r.request_id);
  try {
    pending.attempts++; pending.lastAttemptAt = Date.now(); ci.s.state.save();
    await ci.current(r);
    if (!current()) return;
    if (pending.kind === "retry") resetFailed(ci, r, pending.sequence);
    if (pending.kind === "reopen") ci.reopen(r, pending.sequence);
    r.admissionVerified = true;
    r.lastAdmission = { ...pending, state: "verified", finishedAt: Date.now() };
    delete r.pendingAdmission;
    for (const older of Object.values(ci.receipts)) {
      if (older !== r && sameRepository(ci.s, older.repository, r.repository) && older.pull_number === r.pull_number &&
          older.sequence < r.sequence && !receiptTerminal.has(older.state) && !receiptTerminal.has(r.state)) {
        if (older.repository !== r.repository && sameSnapshot(ci.s, older, r)) continue;
        ci.stop(older, "superseded", "new_snapshot");
      }
    }
    ci.s.state.save();
    ci.s.log("ci_admission_verified", { id: r.request_id, kind: pending.kind, attempts: pending.attempts });
  } catch (error) {
    if (error.persistence) throw error;
    if (!current()) return;
    // A policy skip still owns a verified snapshot, including its status writes.
    if (error.code === "PR_TARGET_BRANCH_NOT_ALLOWED") r.admissionVerified = true;
    const failure = dispatchFailure(error), nextAt = dispatchRetry(failure, pending.attempts);
    pending.lastError = { status: error.status || null, code: error.code || null, message: error.message, at: Date.now() };
    if (nextAt === null) ci.stop(r, failure.state, failure.retryable ? "admission_retries_exhausted" :
      [401, 403, 404].includes(error.status) ? "repository_access_failed" : failure.reason);
    else { pending.nextAt = nextAt; ci.s.state.save(); }
    ci.s.log("ci_admission_rejected", { id: r.request_id, stage: "snapshot_verification", kind: pending.kind,
      attempts: pending.attempts, nextAt, status: error.status || null, code: error.code || null, error: error.message });
  } finally { ci.verifyingAdmissions.delete(r.request_id); }
}
module.exports = { queueAdmission, verifyAdmission };
