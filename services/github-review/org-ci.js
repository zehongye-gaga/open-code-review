// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

// SPDX-License-Identifier: Apache-2.0
"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const { fail, resolveOptions } = require("./options.js");
const { dispatchAgent } = require("./agent-dispatch.js");
const { jobOutcome, receiptOutcome, receiptTerminal: terminal } = require("./outcome.js");
const keys = ["base_ref", "base_sha", "head_sha", "pull_number", "repository"];
function identity(input) {
  if (!input || input.schema !== "ocr-ci/v1" || typeof input.repository !== "string" ||
      !/^lexmount\/[a-z0-9_.-]+$/.test(input.repository) ||
      !Number.isSafeInteger(input.pull_number) || input.pull_number < 1 ||
      !/^[a-f0-9]{40}$/.test(input.head_sha) || !/^[a-f0-9]{40}$/.test(input.base_sha) ||
      typeof input.base_ref !== "string" || !input.base_ref || input.base_ref.length > 1024) fail("Invalid CI coordinates");
  const value = Object.fromEntries(keys.map((k) => [k, input[k]]));
  // Match Python json.dumps(..., ensure_ascii=True), including surrogate pairs.
  const serialized = JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  const id = "ocr-ci-" + crypto.createHash("sha256").update(serialized).digest("hex");
  if (input.request_id !== id) fail("CI request ID does not match snapshot", 409);
  return { schema: "ocr-ci/v1", request_id: id, ...value };
}
class OrgCI {
  constructor(service) {
    this.s = service; this.locks = new Map(); this.dispatching = new Set();
    service.state.data.ciReceipts ||= {};
  }
  get config() { return this.s.config.infrastructure?.orgCI || {}; }
  get receipts() { return this.s.state.data.ciReceipts; }
  async lock(key, fn) {
    const previous = this.locks.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(fn); this.locks.set(key, task);
    try { return await task; } finally { if (this.locks.get(key) === task) this.locks.delete(key); }
  }
  authenticate(token) {
    if (!this.config.tokenFile) fail("Organization CI credentials are not configured", 503);
    const expected = Buffer.from("Bearer " + fs.readFileSync(this.config.tokenFile, "utf8").trim());
    const actual = Buffer.from(typeof token === "string" ? token : "");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) fail("Unauthorized CI credential", 401);
  }
  lookup(input) {
    const normalized = identity(input), record = this.receipts[normalized.request_id];
    if (!record) fail("CI receipt not found", 404);
    return record;
  }
  view(r) {
    return { ...identity(r), outcome: receiptOutcome(r, this.s.state.data.jobs.find((j) => j.id === r.jobId)).kind, state: r.state, durable: true, task_id: r.request_id,
      acceptance: "accepted", scheduler: "backend", contract_version: 2, status_published: !!r.published, commit_status: r.published?.state || null,
      job_id: r.jobId || null, reason: r.reason || null, terminal: terminal.has(r.state) && !!r.published && r.published.state !== "pending" };
  }
  async current(r) {
    const { data } = await this.s.github.rest.pulls.get({ ...this.s.coordinates(r.repository), pull_number: r.pull_number });
    if (!this.s.eligible(r.repository, data, { ciRequestId: r.request_id }) ||
        data.head.sha !== r.head_sha || data.base.sha !== r.base_sha || data.base.ref !== r.base_ref) {
      const error = new Error("PR snapshot is no longer current");
      error.status = 409; error.code = "PR_SNAPSHOT_CHANGED"; error.prClosed = data.state !== "open"; throw error;
    }
    return data;
  }
  stop(r, state, reason) {
    r.state = state; r.reason = reason; r.finishedAt = Date.now();
    const job = this.s.state.data.jobs.find((j) => j.id === r.jobId);
    if (job && ["queued", "running"].includes(job.state)) job.state = "cancelled";
    for (const worker of this.s.workers.values()) if (worker.job.id === r.jobId) worker.controller.abort();
    this.s.state.save();
  }
  async publish(r, state, description, target) {
    return this.lock(`${r.repository}:${r.head_sha}`, async () => {
      const newer = Object.values(this.receipts).some((other) => other.repository === r.repository && other.head_sha === r.head_sha && other.sequence > r.sequence);
      if (newer) { r.published = { state: "failure", suppressed: true }; this.s.state.save(); return; }
      if (r.published?.state === state && r.published?.description === description) return;
      await this.s.writeCommitStatus(r.repository, r.head_sha, state, description, target);
      r.published = { state, description, at: Date.now() }; this.s.state.save();
    });
  }
  async submit(input, route) {
    if (this.config.enabled !== true) fail("Organization CI is staged and not enabled", 503);
    const normalized = identity(input);
    if (!["direct", "agent"].includes(route)) fail("Invalid n8n route");
    return this.lock(normalized.request_id, async () => {
      let r = this.receipts[normalized.request_id];
      if (r) { await this.retrySubmission(r, input.retry_key); await this.reopen(r); await this.refresh(r); return this.view(r); }
      await this.current(normalized);
      if (Object.keys(this.receipts).length >= 25000) fail("CI receipt capacity reached", 503);
      for (const old of Object.values(this.receipts)) {
        if (old.repository === normalized.repository && old.pull_number === normalized.pull_number && !terminal.has(old.state)) this.stop(old, "superseded", "new_snapshot");
      }
      r = this.receipts[normalized.request_id] = { ...normalized, route, state: "accepted", sequence: ++this.s.state.data.sequence,
        createdAt: Date.now(), heartbeatAt: Date.now(), dispatchAttempts: 0, nextDispatchAt: 0 };
      if (input.retry_key !== undefined) await this.retrySubmission(r, input.retry_key);
      this.s.state.save();
      if (await this.reuseExisting(r)) await this.refresh(r);
      else await this.publish(r, "pending", "OCR accepted; waiting for background dispatch");
      return this.view(r);
    });
  }
  async retrySubmission(r, retryKey) {
    if (retryKey === undefined) return;
    if (typeof retryKey !== "string" || !/^[0-9]+:[0-9]+$/.test(retryKey) || retryKey.length > 80) fail("Invalid retry key");
    if (Number(retryKey.split(":")[1]) < 2 || (r.retryKeys || []).includes(retryKey)) return;
    (r.retryKeys ||= []).push(retryKey); this.s.state.save();
    if (r.state !== "failed" || r.jobId || this.dispatching.has(r.request_id)) return;
    await this.current(r);
    (r.retryHistory ||= []).push({ state: r.state, reason: r.reason, finishedAt: r.finishedAt, dispatchAttempts: r.dispatchAttempts });
    r.state = "accepted"; r.createdAt = Date.now(); r.nextDispatchAt = 0; r.dispatchAttempts = 0;
    r.sequence = ++this.s.state.data.sequence;
    for (const key of ["reason", "finishedAt", "finalStatus", "published", "lastDispatchError"]) delete r[key];
    this.s.state.save();
  }
  async status(input) { const r = this.lookup(input); await this.lock(r.request_id, () => this.refresh(r)); return this.view(r); }
  async reopen(r) {
    if (r.state !== "superseded" || !["pr_closed", "pr_changed_or_closed"].includes(r.reason)) return;
    await this.current(r);
    const newer = Object.values(this.receipts).some((other) => other.repository === r.repository &&
      other.pull_number === r.pull_number && other.sequence > r.sequence);
    if (newer) return;
    const job = this.s.state.data.jobs.find((j) => j.id === r.jobId);
    if (this.dispatching.has(r.request_id) || [...this.s.workers.values()].some((w) => w.job.id === r.jobId)) {
      fail("Previous PR dispatch is still stopping; retry acceptance", 503);
    }
    if (r.jobId && !job) return;
    if (job && (job.replacement || !["cancelled", "complete"].includes(job.state))) return;
    const now = Date.now();
    (r.reopenHistory ||= []).push({ at: now, previousState: r.state, previousReason: r.reason,
      createdAt: r.createdAt, finishedAt: r.finishedAt, jobId: r.jobId || null, dispatchAttempts: r.dispatchAttempts });
    r.state = "accepted"; r.createdAt = now; r.heartbeatAt = now; r.nextDispatchAt = 0; r.dispatchAttempts = 0;
    r.sequence = ++this.s.state.data.sequence;
    for (const key of ["reason", "finishedAt", "finalStatus", "published", "lastWorkerStatus", "fallbackAt", "fallbackReason", "dispatchMethod"]) delete r[key];
    if (job) {
      if (job.state === "cancelled") {
        job.state = "queued"; job.nextAt = 0; job.pendingSent = false;
        delete job.error;
      }
      r.state = "queued";
    }
    this.s.state.save();
    await this.publish(r, "pending", "OCR reaccepted after PR reopened");
  }
  async submitReview(args, actor) {
    const id = args.request_id?.replace(/^github:/, "");
    const r = this.receipts[id];
    if (!r || this.config.enabled !== true) fail("No active CI receipt", 409);
    if (actor.id !== "org-ci-dispatcher" && (r.route !== "agent" || actor.id !== this.s.config.infrastructure.agentDispatch?.clientId)) fail("CI submission actor mismatch", 403);
    return this.lock(id, async () => {
      if (terminal.has(r.state)) fail("CI receipt is already terminal", 409);
      for (const key of ["repository", "pull_number", "head_sha", "base_sha"]) if (args[key] !== r[key]) fail("CI submission snapshot mismatch", 409);
      const recovered = this.s.state.data.jobs.find((j) => j.ciRequestId === id);
      if (recovered) { r.jobId = recovered.id; this.s.state.save(); }
      if (r.jobId) return { job_id: r.jobId, state: r.state, deduplicated: true };
      const pr = await this.current(r), repository = this.s.repo(r.repository);
      if (terminal.has(r.state)) fail("CI receipt became terminal", 409);
      const settings = resolveOptions(this.s.config, repository, args.profile || repository.defaultProfile || "standard", args.options || {});
      if (!["low", "medium"].includes(settings.options.blockSeverity)) settings.options.blockSeverity = "medium";
      require("./review-policy.js").bindPolicy(this.s, repository, settings);
      settings.preview = false; settings.options.fullReview = false;
      const j = this.s.accept(r.repository, pr, { force: true, fullReview: false, deduplicateSnapshot: true, settings, ciRequestId: id,
        identity: id, requestId: args.request_id, requestedBy: actor.id });
      r.jobId = j.id; r.state = "queued"; this.s.state.save();
      return { job_id: j.id, state: j.state, deduplicated: false };
    });
  }
  async reuseExisting(r) {
    if (terminal.has(r.state) || r.jobId) return !!r.jobId;
    await this.current(r);
    return this.adoptExisting(r);
  }
  adoptExisting(r) {
    if (terminal.has(r.state) || r.jobId) return !!r.jobId;
    const job = this.s.state.data.jobs.findLast((j) => j.repository === r.repository &&
      j.number === r.pull_number && j.head === r.head_sha && j.base === r.base_sha &&
      j.baseRef === r.base_ref && !j.settings?.preview && require("./review-policy.js").currentPolicy(this.s, j) &&
      (!j.ciRequestId || j.ciRequestId === r.request_id) &&
      ["queued", "running", "complete", "failed", "checkpointed"].includes(j.state));
    if (!job) return false;
    job.ciRequestId = r.request_id; r.jobId = job.id;
    r.dispatchMethod = "reused_existing"; r.state = job.state;
    // refresh owns terminal receipt state and final result publication.
    if (["complete", "failed", "checkpointed"].includes(job.state)) r.state = "queued";
    this.s.state.save();
    return true;
  }
  adoptPending(job) {
    for (const r of Object.values(this.receipts)) {
      if (r.repository === job.repository && r.pull_number === job.number && !r.jobId && !terminal.has(r.state)) this.adoptExisting(r);
    }
  }
  async dispatch(r) {
    if (this.dispatching.has(r.request_id) || r.jobId || terminal.has(r.state) || Date.now() < r.nextDispatchAt) return;
    if (r.dispatchAttempts >= 8) { this.stop(r, "failed", "dispatch_retries_exhausted"); return; }
    this.dispatching.add(r.request_id); r.state = "dispatching"; r.dispatchAttempts++; this.s.state.save();
    try {
      await this.refresh(r);
      if (r.jobId || terminal.has(r.state)) return;
      if (r.route === "agent") {
        try {
          if (this.config.agentReady !== true) fail("Agent MCP cutover is not ready", 409);
          await (this.agentDispatch || dispatchAgent)(this.s, { id: r.request_id, ciRequestId: r.request_id,
            repository: r.repository, number: r.pull_number, head: r.head_sha, base: r.base_sha, action: "organization_ci" });
          if (!r.jobId) await this.reuseExisting(r);
          if (!r.jobId) throw new Error("Agent did not acknowledge this CI receipt");
          r.dispatchMethod ||= "agent";
        } catch (error) {
          if (error.persistence || terminal.has(r.state)) throw error;
          if (!r.jobId) await this.reuseExisting(r);
          if (!r.jobId) {
            r.fallbackAt = Date.now(); r.fallbackReason = ["TimeoutError", "AbortError"].includes(error.name) ? "agent_ack_timeout" : "agent_unacknowledged";
            r.dispatchMethod = "direct_fallback"; this.s.state.save();
            await this.submitReview({ ...r, request_id: `github:${r.request_id}` }, { id: "org-ci-dispatcher", role: "dispatcher" });
          }
        }
      } else await this.submitReview({ ...r, request_id: `github:${r.request_id}` }, { id: "org-ci-dispatcher", role: "dispatcher" });
    } catch (error) {
      if (error.persistence) throw error;
      if (terminal.has(r.state) || r.jobId) return;
      r.lastDispatchError = { status: error.status || null, code: error.code || null, at: Date.now() };
      this.s.log("ci_dispatch_rejected", { id: r.request_id, status: error.status, code: error.code, error: error.message });
      const failure = require("./dispatch-control.js").dispatchFailure(error);
      const nextAt = require("./dispatch-control.js").dispatchRetry(failure, r.dispatchAttempts);
      if (nextAt === null) this.stop(r, failure.state, failure.reason);
      else { r.state = "retrying"; r.nextDispatchAt = nextAt; }
      this.s.state.save();
    } finally { this.dispatching.delete(r.request_id); }
    await this.refresh(r);
  }
  async tick(input) {
    const r = this.lookup(input); r.heartbeatAt = Date.now(); this.s.state.save();
    await this.lock(r.request_id, () => this.refresh(r));
    // Compatibility endpoint: the backend scheduler owns admission and recovery.
    return this.view(r);
  }
  async publishJobStatus(job, state, description, target) {
    const r = this.receipts[job.ciRequestId];
    if (!r) fail("CI receipt disappeared", 409);
    if (terminal.has(r.state)) return;
    if (state !== "pending") {
      await this.current(r);
    }
    if (state !== "pending") {
      r.lastWorkerStatus = { state, description, target }; this.s.state.save(); return;
    }
    await this.publish(r, state, description, target);
  }
  repairable(r) {
    const job = this.s.state.data.jobs.find(j => j.id === r.jobId);
    return r.state === "failed" && ["review_incomplete_or_failed", "n8n_tracking_stalled"].includes(r.reason) &&
      ["complete", "blocked", "skipped"].includes(jobOutcome(job)?.kind) && require("./review-policy.js").currentPolicy(this.s, job);
  }
  async reconcileLegacy(r) {
    if (!this.repairable(r)) return;
    const previous = { state: r.state, reason: r.reason, published: r.published, finishedAt: r.finishedAt };
    try { await this.current(r); }
    catch (error) {
      if (error.code !== "PR_SNAPSHOT_CHANGED") throw error;
      r.reconciliation = { at: Date.now(), previous, result: "superseded" };
      this.stop(r, "superseded", error.prClosed ? "pr_closed" : "pr_snapshot_changed"); return;
    }
    r.reconciliation = { at: Date.now(), previous, result: "verified_backend_outcome" };
    r.state = "queued"; delete r.finalStatus; delete r.reason;
    this.s.state.save();
  }
  async refresh(r) {
    await this.reconcileLegacy(r);
    if (!terminal.has(r.state) && !r.jobId) this.adoptExisting(r);
    const now = Date.now(), j = this.s.state.data.jobs.find((job) => job.id === r.jobId);
    const observed = jobOutcome(j);
    if (!terminal.has(r.state) && !observed?.terminal) {
      if (now - r.createdAt > (this.config.totalSeconds || 7200) * 1000) this.stop(r, "failed", "review_deadline_exceeded");

    }
    if (!terminal.has(r.state)) {
      try { await this.current(r); }
      catch (error) {
        if (error.code === "PR_SNAPSHOT_CHANGED") this.stop(r, "superseded", error.prClosed ? "pr_closed" : "pr_snapshot_changed");
        else if ([401, 403, 404].includes(error.status) && !require("./dispatch-control.js").dispatchFailure(error).retryable) this.stop(r, "failed", "repository_access_failed");
        else throw error;
      }
      const result = jobOutcome(j);
      if (!terminal.has(r.state) && result?.terminal) {
        r.state = result.receiptState; r.reason = result.reason; r.finalStatus = result.commitStatus;
        r.finishedAt = now; this.s.state.save();
      }
    }
    if (terminal.has(r.state)) {
      const result = receiptOutcome(r, j);
      await this.publish(r, r.finalStatus || result.commitStatus, r.state === result.receiptState ? result.description :
        `OCR ${r.state}: ${r.reason || r.state}`, j?.result?.summaryURL);
    } else {
      if (j) r.state = jobOutcome(j)?.receiptState || j.state;
      if (!r.published) await this.publish(r, "pending", "OCR accepted; waiting for background dispatch");
    }
    this.s.state.save();
  }
  async watchdog() {
    if (this.watching) return;
    this.watching = true;
    try {
      for (const r of Object.values(this.receipts)) {
        if (terminal.has(r.state) && r.published?.state && r.published.state !== "pending" && !this.repairable(r)) continue;
        try { await this.lock(r.request_id, () => this.refresh(r)); }
        catch (error) { this.s.log("ci_watchdog_retry", { id: r.request_id, error: error.message }); if (error.persistence) throw error; }
      }
    } finally { this.watching = false; }
  }
}
module.exports = { OrgCI, identity };
