// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";
const crypto = require("node:crypto");
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const queued = new Set(["accepted", "dispatching", "queued", "running", "retrying"]);
class DispatchCheck {
  constructor(service) { this.s = service; this.writes = new Map(); }
  get enabled() { return this.s.config.infrastructure?.dispatchCheck?.enabled === true; }
  get context() { return this.s.config.infrastructure?.dispatchCheck?.context || "ocr-dispatch"; }
  watch(repository, number, head) {
    if (!this.enabled) return;
    const checks = this.s.state.data.dispatchChecks ||= {};
    const key = `${repository}:${head}`;
    const entry = checks[key] ||= { repository, head, numbers: [], revision: 0 };
    if (!entry.numbers.includes(number)) entry.numbers.push(number);
    entry.revision++; entry.nextAt = Math.max(0, entry.rateLimitedUntil || 0); entry.retired = false;
    this.s.state.save();
  }
  accepted(repository, pr) {
    const snapshot = job => job && job.repository === repository && job.number === pr.number &&
      job.head === pr.head.sha && job.base === pr.base.sha && job.baseRef === pr.base.ref && !job.settings?.preview;
    const jobs = this.s.state.data.jobs || [];
    const receipts = Object.values(this.s.state.data.ciReceipts || {}).filter(r => r.repository === repository &&
      r.pull_number === pr.number && r.head_sha === pr.head.sha && r.base_sha === pr.base.sha && r.base_ref === pr.base.ref);
    const deliveries = (this.s.state.data.deliveries || []).filter(e => e.repository === repository && e.number === pr.number &&
      e.head === pr.head.sha && e.base === pr.base.sha && e.baseRef === pr.base.ref && e.admitted);
    const entry = this.s.state.data.dispatchChecks[`${repository}:${pr.head.sha}`];
    const key = hash([pr.number, pr.head.sha, pr.base.sha, pr.base.ref]);
    const proofs = entry.acceptances ||= {};
    if (!receipts.length && !deliveries.length) return !!proofs[key];
    const dispatched = id => {
      const job = jobs.find(j => j.id === id);
      return job ? snapshot(job) : !!id && !!proofs[key];
    };
    const accepted = receipts.some(r => dispatched(r.jobId) || queued.has(r.state)) ||
      deliveries.some(e => dispatched(e.jobId) || e.state === "pending");
    if (accepted) proofs[key] ||= { at: Date.now(), number: pr.number, head: pr.head.sha, base: pr.base.sha, baseRef: pr.base.ref };
    else delete proofs[key];
    return accepted;
  }
  async inspect(entry) {
    const pulls = new Map();
    for (const number of entry.numbers) {
      const { data: pr } = await this.s.github.rest.pulls.get({ ...this.s.coordinates(entry.repository), pull_number: number });
      pulls.set(pr.number, pr);
    }
    // A SHA can be shared by different branches and forks, not just the observed head ref.
    for (let page = 1; ; page++) {
      const { data } = await this.s.github.rest.pulls.list({ ...this.s.coordinates(entry.repository), page, per_page: 100 });
      for (const pr of data) if (pr.head.sha === entry.head) pulls.set(pr.number, pr);
      if (data.length < 100) break;
      if (page >= 100) throw new Error("PR lookup limit reached");
    }
    const current = [...pulls.values()].filter(pr => pr.state === "open" && pr.head.sha === entry.head);
    const decisions = current.map(pr => ({ number: pr.number, head: pr.head.sha, base: pr.base.sha, baseRef: pr.base.ref,
      accepted: !!this.s.eligible(entry.repository, pr) && this.accepted(entry.repository, pr) })).sort((a,b) => a.number-b.number);
    const routing = this.s.config.infrastructure;
    const success = routing?.externalDispatch === true && routing?.dispatchEnabled === true && decisions.length > 0 && decisions.every(row => row.accepted);
    return { state: success ? "success" : "failure", fingerprint: hash(decisions), retired: decisions.length === 0, snapshots: decisions,
      description: success ? "OCR dispatch durably accepted for current PR snapshot(s)" : "OCR dispatch missing or ineligible for current PR snapshot(s)" };
  }

  async publish(entry, state, description) {
    await this.s.github.rest.repos.createCommitStatus({ ...this.s.coordinates(entry.repository), sha: entry.head,
      context: this.context, state, description });
    entry.published = { state, at: Date.now() };
    this.s.state.save();
  }
  async refresh(entry) {
    const key = `${entry.repository}:${entry.head}`;
    if (this.writes.has(key)) return this.writes.get(key);
    const write = (async () => {
      const revision = entry.revision;
      try {
        if (!entry.published || entry.checkedRevision !== revision) await this.publish(entry, "pending", "Validating durable OCR dispatch for the current PR target");
        const result = await this.inspect(entry);
        if (entry.revision !== revision) return;
        if (entry.published?.state !== result.state || entry.fingerprint !== result.fingerprint) await this.publish(entry, result.state, result.description);
        if (entry.revision !== revision) {
          await this.publish(entry, "pending", "PR changed during dispatch verification; checking again");
          entry.nextAt = 0; this.s.state.save(); return;
        }
        entry.retired = result.retired;
        entry.fingerprint = result.fingerprint; entry.snapshots = result.snapshots; entry.checkedRevision = revision;
        entry.nextAt = Date.now() + 30000; entry.failures = 0; delete entry.rateLimitedUntil; delete entry.error;
        this.s.state.save();
      } catch (error) {
        if (error.persistence) throw error;
        entry.error = "Dispatch check verification or publication failed";
        const failure = require("./dispatch-control.js").dispatchFailure(error);
        entry.failures = (entry.failures || 0) + 1;
        const delay = failure.retryable ? Math.min(300000, 10000 * 2 ** Math.min(entry.failures - 1, 5)) : 300000;
        entry.nextAt = Math.max(Date.now() + delay, failure.retryAt || 0);
        if (failure.reason === "github_rate_limited") entry.rateLimitedUntil = entry.nextAt;
        else {
          try { await this.publish(entry, "error", "Cannot verify durable OCR dispatch; retry pending"); }
          catch (writeError) { if (writeError.persistence) throw writeError; }
        }
        this.s.state.save();
        this.s.log("dispatch_check_failed", { repository: entry.repository, head: entry.head, status: error.status || null });
      }
    })();
    this.writes.set(key, write);
    try { await write; } finally { this.writes.delete(key); }
  }
  async tick() {
    if (!this.enabled || this.s.stopping) return;
    // Recover a crash after admission was saved but before its watch was registered.
    const sources = [...(this.s.state.data.deliveries || []).filter(e => e.baseRef).map(e => [e.repository, e.number, e.head]),
      ...Object.values(this.s.state.data.ciReceipts || {}).map(r => [r.repository, r.pull_number, r.head_sha])];
    let recovered = 0;
    for (const [repository, number, head] of sources) {
      if (!this.s.state.data.dispatchChecks?.[`${repository}:${head}`]?.numbers.includes(number)) {
        this.watch(repository, number, head);
        if (++recovered >= 8) break;
      }
    }
    for (const entry of Object.values(this.s.state.data.dispatchChecks || {}).filter(e => !e.retired && (e.nextAt || 0) <= Date.now()).sort((a,b) => (a.nextAt || 0)-(b.nextAt || 0)).slice(0, 8)) {
      if ((entry.nextAt || 0) <= Date.now()) await this.refresh(entry);
    }
  }
}
module.exports = { DispatchCheck };
