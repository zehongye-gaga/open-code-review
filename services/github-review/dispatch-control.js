// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";
const { receiptTerminal } = require("./outcome.js");
function key(repository, number) { return JSON.stringify([repository.toLowerCase(), number]); }
async function dispatchTick(service, events = service.githubEvents) {
  if (service.stopping || !events) return;
  const pending = (service.state.data.deliveries || []).filter((event) => event.admitted &&
    !events.admissionWrites.has(event.id) && event.admissionPublished !==
      (event.state === "pending" ? "pending" : event.state === "failed" ? "error" : "success"))
    .map((event) => events.publishAdmission(event));
  if (service.dispatchCheck) pending.push(service.dispatchCheck.tick());
  const candidates = [];
  if (service.config.infrastructure?.externalDispatch) {
    for (const event of service.state.data.deliveries || []) {
      if (event.state === "pending" && event.nextAt <= Date.now()) candidates.push({
        at: Date.parse(event.createdAt) || 0, id: event.id,
        key: key(event.repository, event.kind === "push" ? event.ref : event.number),
        run: (k) => events.process(event, k) });
    }
  }
  if (service.config.infrastructure?.orgCI?.enabled) {
    for (const receipt of Object.values(service.orgCI?.receipts || {})) {
      if (!receipt.jobId && !receiptTerminal.has(receipt.state) && receipt.nextDispatchAt <= Date.now()) candidates.push({
        at: receipt.createdAt, id: receipt.request_id, key: key(receipt.repository, receipt.pull_number),
        run: async (k) => { try { await service.orgCI.dispatch(receipt); }
          finally { events.activeDispatches.delete(k); } } });
    }
  }
  candidates.sort((a, b) => a.at - b.at);
  for (const candidate of candidates) {
    if (events.activeDispatches.size >= (service.config.dispatchConcurrency || 8)) break;
    if (events.activeDispatches.has(candidate.key)) continue;
    events.activeDispatches.set(candidate.key, candidate.id);
    pending.push(candidate.run(candidate.key));
  }
  const results = await Promise.allSettled(pending);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}
function dispatchFailure(error) {
  if (error.code === "PR_SNAPSHOT_CHANGED") return { state: "superseded", reason: error.prClosed ? "pr_closed" : "pr_snapshot_changed", retryable: false };
  const status = error.status;
  const headers = error.response?.headers || {};
  const throttled = status === 429 || status === 403 && (headers["retry-after"] !== undefined || headers["x-ratelimit-remaining"] === "0" || /rate limit|abuse/i.test(error.response?.data?.message || ""));
  if (throttled) {
    const after = Number(headers["retry-after"]), reset = Number(headers["x-ratelimit-reset"]);
    const retryAt = Number.isFinite(after) && after > 0 ? Date.now() + after * 1000 : Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + 60000;
    return { state: "failed", reason: "github_rate_limited", retryable: true, retryAt: Math.max(Date.now() + 1000, retryAt) };
  }
  const permanent = status >= 400 && status < 500 && ![408, 429].includes(status);
  return { state: "failed", reason: ["REPOSITORY_NOT_ALLOWED", "CLIENT_SCOPE_DENIED"].includes(error.code) ? error.code.toLowerCase() : permanent ? "dispatch_configuration_or_access_error" : "dispatch_retries_exhausted", retryable: !permanent };
}
module.exports = { dispatchTick, dispatchFailure };
