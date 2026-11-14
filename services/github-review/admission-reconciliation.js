// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const { identity, requestId } = require("./org-ci.js");
const { dispatchFailure } = require("./dispatch-control.js");
const { isRepositorySkip, isBranchSkip } = require("./outcome.js");
const { sameRepository, sameSnapshot, closedReceipt, receiptOwner } = require("./repositories.js");
const defaults = { enabled: false, mode: "observe", intervalSeconds: 900, graceSeconds: 300, maxAdmissionsPerScan: 10 };
function settings(config) { return { ...defaults, ...config.admissionReconciliation }; }
function validateConfiguration(config) {
  const raw = config.admissionReconciliation;
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) throw Error("Invalid admissionReconciliation configuration");
  const c = settings(config);
  if (typeof c.enabled !== "boolean" || !["observe", "repair"].includes(c.mode)) throw Error("Invalid admissionReconciliation mode or enabled flag");
  for (const [key, min, max] of [["intervalSeconds", 300, 86400], ["graceSeconds", 60, 86400], ["maxAdmissionsPerScan", 1, 100]]) {
    if (!Number.isSafeInteger(c[key]) || c[key] < min || c[key] > max) throw Error(`Invalid admissionReconciliation.${key}`);
  }
  if (c.initialBaseline !== undefined && (!Array.isArray(c.initialBaseline) || c.initialBaseline.length > 10000 ||
      c.initialBaseline.some(id => typeof id !== "string" || !/^ocr-ci-[a-f0-9]{64}$/.test(id)))) {
    throw Error("Invalid admissionReconciliation initialBaseline");
  }
  if (c.enabled && (config.gitea || !config.infrastructure?.enabled || !config.infrastructure.externalDispatch || !config.infrastructure.orgCI?.enabled)) {
    throw Error("Admission reconciliation requires the GitHub external-dispatch CI control plane");
  }
  if (c.repositories !== undefined && (!Array.isArray(c.repositories) || !c.repositories.length ||
      c.repositories.some(name => typeof name !== "string" || !config.repositories.some(r => r.name === name)))) {
    throw Error("Reconciliation repositories must be explicitly configured repositories");
  }
  if (c.enabled && (c.repositories || config.repositories.map(r => r.name)).some(name => !name.startsWith("lexmount/"))) {
    throw Error("Admission reconciliation follows the lexmount Policy CI contract");
  }
}
function snapshot(repository, pr) {
  const value = { schema: "ocr-ci/v1", repository, pull_number: pr.number, head_sha: pr.head?.sha,
    base_sha: pr.base?.sha, base_ref: pr.base?.ref };
  return identity({ ...value, request_id: requestId(value) });
}
class AdmissionReconciliation {
  constructor(service, now = Date.now) {
    this.s = service; this.now = now; this.running = false;
    this.initialBaseline = new Set(settings(service.config).initialBaseline || []);
  }
  owner(p) {
    const d = this.s.state.data;
    const closed = r => !r.pendingAdmission && closedReceipt(r);
    let receipt = receiptOwner(this.s, d.ciReceipts?.[p.request_id]);
    if ((!receipt || isRepositorySkip(receipt) || isBranchSkip(receipt) || closed(receipt)) && this.s.repo(p.repository)?.githubName) {
      receipt = Object.values(d.ciReceipts || {}).map(r => receiptOwner(this.s, r)).find(r => r.repository !== p.repository &&
        !isRepositorySkip(r) && !isBranchSkip(r) && !closed(r) && sameSnapshot(this.s, r, p)) || receipt;
    }
    if (isBranchSkip(receipt)) {
      const job = d.jobs.find(j => j.id === receipt.jobId);
      return receipt.jobId && (!job || job.replacement || !["cancelled", "complete"].includes(job.state)) ? "receipt" : null;
    }
    if (receipt && !isRepositorySkip(receipt)) return closed(receipt) ? null : "receipt";
    if (d.jobs.some(j => sameRepository(this.s, j.repository, p.repository) && j.number === p.pull_number && j.head === p.head_sha &&
        j.base === p.base_sha && j.baseRef === p.base_ref && !j.settings?.preview && !["cancelled", "superseded"].includes(j.state))) return "job";
    if ((d.deliveries || []).some(e => sameRepository(this.s, e.repository, p.repository) && e.number === p.pull_number &&
        e.head === p.head_sha && e.base === p.base_sha && ["pending", "failed"].includes(e.state) && e.admitted)) return "delivery";
    return null;
  }
  async tick() {
    const c = settings(this.s.config), now = this.now();
    if (!c.enabled || this.running || this.s.stopping || !this.s.orgCI || now < (this.s.state.data.admissionReconciliation?.nextScanAt || 0)) return;
    this.running = true;
    const data = this.s.state.data;
    data.admissionReconciliation ||= {};
    data.admissionSnapshots ||= {};
    const meta = data.admissionReconciliation, snapshots = data.admissionSnapshots;
    const summary = { observed: 0, missing: 0, admitted: 0, errors: 0, mode: c.mode };
    try {
      meta.startedAt = now; meta.nextScanAt = now + c.intervalSeconds * 1000;
      this.s.state.save();
      const names = (c.repositories || this.s.enrolledRepositories().map(r => r.name)).filter(name => this.s.repo(name));
      const offset = names.length ? (meta.repositoryOffset || 0) % names.length : 0;
      meta.repositoryOffset = names.length ? (offset + 1) % names.length : 0;
      for (const repository of [...names.slice(offset), ...names.slice(0, offset)]) {
        if (this.s.stopping) break;
        try {
          const pulls = [];
          for (let page = 1; ; page++) {
            const { data: items } = await this.s.github.rest.pulls.list({ ...this.s.coordinates(repository), page, per_page: 100 });
            if (!Array.isArray(items)) throw Error("Invalid PR list response");
            pulls.push(...items.map(pr => ({ number: pr.number, state: pr.state, draft: pr.draft, stack: pr.stack,
              head: { sha: pr.head?.sha }, base: { sha: pr.base?.sha, ref: pr.base?.ref,
                repo: { id: pr.base?.repo?.id, full_name: pr.base?.repo?.full_name } } })));
            if (items.length < 100) break;
            if (page >= 100) throw Error("Reconciliation PR page limit reached");
          }
          const seen = new Set();
          for (const pr of pulls) {
            if (this.s.stopping) break;
            // CI draft handling does not override the shared target-branch policy.
            if (!this.s.eligible(repository, pr, { ciRequestId: "reconciliation" })) continue;
            const p = snapshot(repository, pr), key = `${repository}#${pr.number}`;
            seen.add(key); summary.observed++;
            let row = snapshots[key];
            if (row?.request_id !== p.request_id) { snapshots[key] = { ...p, firstSeenAt: now }; row = snapshots[key]; }
            row.lastSeenAt = now; row.owner = this.owner(p); delete row.error;
            if (row.owner) { row.status = "owned"; delete row.missingSinceAt; continue; }
            if (this.initialBaseline.has(p.request_id)) {
              row.status = "baseline"; delete row.missingSinceAt; continue;
            }
            row.missingSinceAt ??= now;
            summary.missing++;
            if (now - row.missingSinceAt < c.graceSeconds * 1000) { row.status = "grace"; continue; }
            row.status = "missing";
            if (c.mode === "observe" || summary.admitted >= c.maxAdmissionsPerScan) continue;
            // The backend verifies this frozen snapshot before dispatching it.
            try {
              const ack = await this.s.orgCI.submit(p, "agent");
              const receipt = this.s.orgCI.receipts[p.request_id];
              if ((receipt.state === "superseded" || isBranchSkip(receipt)) && !receipt.pendingAdmission) {
                row.status = "reopen_blocked"; row.taskId = ack.task_id;
                this.s.state.save(); continue;
              }
              receipt.reconciliation ||= { source: "scheduled_snapshot_scan", at: now };
              row.status = receipt.pendingAdmission ? "verification_pending" : "recovered"; row.taskId = ack.task_id; row.acceptedAt = now;
              if (!receipt.pendingAdmission) row.recoveredAt = now;
              summary.admitted++;
              this.s.state.save();
              this.s.log("ci_reconciliation_accepted", { repository, number: pr.number, head: p.head_sha, request_id: p.request_id });
            } catch (error) {
              if (error.persistence) throw error;
              row.status = "admission_failed"; row.error = error.code || error.message;
              if (dispatchFailure(error).reason === "github_rate_limited") throw error;
              summary.errors++;
              this.s.log("ci_reconciliation_failed", { repository, number: pr.number, error: error.message });
              this.s.state.save();
            }
          }
          if (!this.s.stopping) {
            for (const [key, row] of Object.entries(snapshots)) if (row.repository === repository && !seen.has(key)) delete snapshots[key];
          }
          this.s.state.save();
        } catch (error) {
          if (error.persistence) throw error;
          summary.errors++;
          this.s.log("ci_reconciliation_failed", { repository, error: error.message });
          this.s.state.save();
          const failure = dispatchFailure(error);
          if (failure.reason === "github_rate_limited") {
            meta.nextScanAt = Math.max(meta.nextScanAt, failure.retryAt); break;
          }
        }
      }
      meta.finishedAt = this.now(); meta.summary = summary;
      meta.nextScanAt = Math.max(meta.nextScanAt, meta.finishedAt + c.intervalSeconds * 1000);
      this.s.state.save();
      this.s.log("ci_reconciliation_scan", summary);
      return summary;
    } finally { this.running = false; }
  }
}
module.exports = { AdmissionReconciliation, validateConfiguration, settings, snapshot };
