// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

(function () {
  function needsAction(pr) {
    return [pr.ocr, pr.cragent].some((status) => ["failure", "error"].includes(status.state));
  }

  function tracked(pr, now = Date.now()) {
    return needsAction(pr) || pr.ocr.state !== "missing" || Boolean(pr.ocr.jobState) ||
      ["pending"].includes(pr.cragent.state) ||
      ["queued", "running", "publishing", "publish_pending", "error_publish_pending"].includes(pr.cragent.jobState) ||
      Date.parse(pr.cragent.updatedAt) > now - 86400000 || Date.parse(pr.updatedAt) > now - 86400000;
  }

  function historyResult(job) {
    if (job.state === "complete") {
      if (!Number.isFinite(job.blocking)) return "neutral";
      return job.blocking > 0 ? "failure" : "success";
    }
    if (job.state === "reviewed_pass") return "success";
    if (job.state === "reviewed_fail") return "failure";
    if (job.state === "failed" || job.state.startsWith("error")) return "error";
    return "neutral";
  }

  function connectionState(data, disconnected, now = Date.now()) {
    if (disconnected) return "disconnected";
    if (!data?.ready) return "connecting";
    if (data.stale || now - Date.parse(data.collectedAt) > 45000) return "stale";
    return "connected";
  }

  const view = { needsAction, tracked, historyResult, connectionState };
  if (typeof module !== "undefined" && module.exports) module.exports = view;
  else globalThis.ReviewMonitorView = view;
})();
