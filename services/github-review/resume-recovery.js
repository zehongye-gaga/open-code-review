// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";
const fs = require("node:fs"), path = require("node:path");
function recordResumeFallback(service, job, reason) {
  if (job.resumeFallbacks?.at(-1)?.state === "authorized") return job.resumeFallbacks.at(-1);
  if ((job.resumeFallbacks || []).length >= 1) throw Object.assign(new Error("Automatic full-review recovery was already used; operator action is required"), { retryable: false, code: "RESUME_RECOVERY_EXHAUSTED" });
  const entry = { state: "authorized", at: new Date().toISOString(), reason, previousSessionId: job.progress?.sessionId || job.budgetRetries?.at(-1)?.sessionId || null,
    previousDirectory: job.progress?.directory || null, head: job.head, base: job.base,
    requestedBy: job.requestedBy || "default", requestedBudget: job.settings?.options?.budget ?? null,
    effectiveBudget: job.retryBudget ?? job.settings?.options?.budget ?? null, usageBySession: {}, extraTokens: null };
  (job.resumeFallbacks ||= []).push(entry); service.state.save();
  service.log("resume_full_review_recovery", { id: job.id, reason, previousSessionId: entry.previousSessionId });
  return entry;
}
function captureRecovery(job, directory) {
  const entry = job.resumeFallbacks?.at(-1);
  if (!entry || !directory || directory === entry.previousDirectory) return;
  try {
    const report = JSON.parse(fs.readFileSync(path.join(directory, "result.json")));
    if (!report.session_id || report.session_id === entry.previousSessionId) return;
    const usage = Object.fromEntries(["total_tokens", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"]
      .map(key => [key, Number.isSafeInteger(report.summary?.[key]) ? report.summary[key] : null]));
    entry.state = "observed";
    entry.usageBySession[report.session_id] = { directory, ...usage };
    const totals = Object.values(entry.usageBySession).map(row => row.total_tokens);
    entry.extraTokens = totals.every(Number.isSafeInteger) ? totals.reduce((a,b) => a+b,0) : null;
    entry.elapsedSeconds = Math.max(0, (Date.now() - Date.parse(entry.at)) / 1000);
    entry.lastObservedAt = new Date().toISOString();
  } catch { /* Missing native reports leave usage explicitly unknown. */ }
}
module.exports = { recordResumeFallback, captureRecovery };
