// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";

const receiptTerminal = new Set(["complete", "skipped", "failed", "cancelled", "superseded"]);
function outcome(kind, reason, description, extra = {}) {
  const terminal = !["queued", "running", "retrying", "accepted"].includes(kind);
  const failed = ["execution_failed", "publication_failed", "dispatch_failed"].includes(kind);
  return { kind, terminal, alert: failed, receiptState: failed ? "failed" : kind === "blocked" ? "complete" : kind,
    commitStatus: !terminal ? "pending" : failed || ["blocked", "cancelled", "superseded"].includes(kind) ? "failure" : "success",
    reason, description, ...extra };
}
function jobOutcome(job) {
  if (!job) return null;
  const { state, progress = {}, result = {} } = job;
  if (["queued", "running"].includes(state)) return outcome(state === "queued" && job.attempt ? "retrying" : state, null,
    state === "running" ? "OCR review in progress" : "OCR waiting for execution");
  if (["cancelled", "superseded", "checkpointed"].includes(state)) return outcome(state === "checkpointed" ? "superseded" : state,
    state, `OCR ${state}; no current review result`);
  if (state === "failed") return outcome(job.failurePhase === "publication" ? "publication_failed" : "execution_failed",
    job.error || "review_incomplete_or_failed", `OCR ${job.failurePhase === "publication" ? "publication" : "execution"} failed: ${job.error || "unknown"}`);
  if (state === "skipped" && result.reviewed === false) return outcome("skipped", "policy_skip", "OCR skipped by policy; no review was performed");
  if (state !== "complete") return null;
  if (result.preview) return outcome("skipped", "preview_only", "OCR preview complete; no review was performed");
  if (result.skipped === true && progress.skipped === true && progress.selected === 0 &&
      result.findings === 0 && result.blocking === 0 && result.summaryURL) {
    return outcome("skipped", "no_reviewable_items", "OCR skipped: no reviewable items");
  }
  if (progress.complete && !result.skipped && Number.isSafeInteger(result.blocking) && result.blocking >= 0) {
    return outcome(result.blocking ? "blocked" : "complete", null, result.blocking ?
      `OCR found ${result.blocking} blocking finding(s)` : `OCR complete: ${result.findings ?? 0} finding(s)`);
  }
  return outcome("execution_failed", "review_incomplete_or_failed", "OCR failed: review_incomplete_or_failed");
}
function receiptOutcome(receipt, job) {
  // A linked backend job owns execution truth; ingress is only its transport.
  if (["cancelled", "superseded"].includes(receipt.state)) return outcome(receipt.state, receipt.reason, `OCR ${receipt.state}: ${receipt.reason || receipt.state}`);
  const result = jobOutcome(job);
  if (receipt.state === "failed" && ["repository_access_failed", "review_deadline_exceeded"].includes(receipt.reason)) {
    return outcome("dispatch_failed", receipt.reason, `OCR failed: ${receipt.reason}`);
  }
  if (result && !(receipt.state === "failed" && ["cancelled", "superseded"].includes(result.kind))) return result;
  if (receipt.state === "failed") return outcome("dispatch_failed", receipt.reason || receipt.error || receipt.lastError,
    `OCR failed: ${receipt.reason || receipt.error || receipt.lastError || "dispatch_failed"}`);
  return outcome("accepted", null, "OCR accepted; waiting for background dispatch");
}
module.exports = { jobOutcome, receiptOutcome, receiptTerminal };
