// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { State } = require("./state.js");
const { jobOutcome } = require("./outcome.js");
const { queueFeedback } = require("./agent-session.js");
const { prepareReview, runReview, publishReview } = require("./review.js");
const { planReview, readProgress, checkpointFor } = require("./progress.js");

const { executionOptions, validateInfrastructure, resolveOptions } = require("./options.js");

const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function configuration(input) {
  const config = { listen: "127.0.0.1", port: 8787, pollSeconds: 30, bootstrapExisting: true,
    binary: "/usr/local/bin/ocr", provider: "openai-codex", model: "gpt-6-astra",
    budget: 0, timeoutSeconds: 1500, fetchTimeoutSeconds: 600, maxAttempts: 3, retrySeconds: 60,
    retentionDays: 7, prConcurrency: 1, dispatchConcurrency: 8, statusContext: "ocr-review", blockSeverity: "high", ...input };
  if (!path.isAbsolute(config.stateDirectory || "")) throw new Error("stateDirectory must be absolute");
  if (!path.isAbsolute(config.binary)) throw new Error("binary must be absolute");
  if (!Array.isArray(config.repositories) || !config.repositories.length) throw new Error("Configure at least one repository");
  const seen = new Set();
  for (const repo of config.repositories) {
    if (!REPOSITORY.test(repo.name) || seen.has(repo.name.toLowerCase()) ||
        !Array.isArray(repo.baseBranches) || !repo.baseBranches.length ||
        repo.baseBranches.some((branch) => typeof branch !== "string" || !branch)) {
      throw new Error("Repositories require a unique owner/repo and baseBranches");
    }
    repo.name = repo.name.toLowerCase();
    seen.add(repo.name.toLowerCase());
  }
  for (const key of ["pollSeconds", "timeoutSeconds", "fetchTimeoutSeconds", "maxAttempts", "retrySeconds", "retentionDays", "prConcurrency", "dispatchConcurrency"]) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  if (!Number.isSafeInteger(config.budget) || config.budget < 0) throw new Error("budget must be non-negative");
  if (!["critical", "high", "medium", "low", "none"].includes(config.blockSeverity)) throw new Error("Invalid blockSeverity");
  if (typeof config.bootstrapExisting !== "boolean") throw new Error("bootstrapExisting must be boolean");
  if (!Number.isSafeInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error("Invalid port");
  validateInfrastructure(config);
  return config;
}

class ReviewService {
  constructor({ config, github, state, log = console.log, prepare = prepareReview, run = runReview, publish = publishReview }) {
    this.config = configuration(config);
    this.github = github;
    this.state = state || new State(this.config.stateDirectory);
    this.log = (event, details = {}) => log(JSON.stringify({ time: new Date().toISOString(), event, ...details }));
    this.prepare = prepare; this.run = run; this.publish = publish;
    this.workers = new Map(); this.stopping = false; this.lastPoll = null; this.pollError = null;
    fs.mkdirSync(path.join(this.config.stateDirectory, "runs"), { recursive: true, mode: 0o700 });
  }

  repo(name) {
    if (typeof name !== "string" || !REPOSITORY.test(name)) return null;
    const explicit = this.config.repositories.find((repo) => repo.name === name.toLowerCase());
    if (explicit) return explicit;
    const org = this.config.infrastructure?.organizations?.find((item) => item.name.toLowerCase() === name.split("/")[0].toLowerCase());
    return org ? { ...org, name: name.toLowerCase(), baseBranches: org.baseBranches || ["*"], discovered: true } : null;
  }
  refresh(job, pr) {
    if (job.state === "cancelled") return null;
    if (job.settings || this.config.infrastructure?.externalDispatch) {
      job.state = "superseded";
      this.state.save();
      return null;
    }
    return this.accept(job.repository, pr);
  }
  get active() { return this.workers.values().next().value || null; }
  coordinates(name) { const [owner, repo] = name.split("/"); return { owner, repo }; }
  eligible(repository, pr, job = {}) {
    const repo = this.repo(repository);
    return repo && pr.state === "open" && (job.ciRequestId || !pr.draft) && (job.ciRequestId || repo.baseBranches.includes("*") || repo.baseBranches.includes(pr.base?.ref)) &&
      pr.base?.repo?.full_name?.toLowerCase() === repo.name && SHA.test(pr.head?.sha) && SHA.test(pr.base?.sha);
  }

  async observe(repository, number, options = {}) {
    if (!this.repo(repository) || !Number.isSafeInteger(number) || number < 1) throw new Error("Repository or PR is not allowed");
    repository = this.repo(repository).name;
    const { data: pr } = await this.github.rest.pulls.get({ ...this.coordinates(repository), pull_number: number });
    const job = this.accept(repository, pr, options);
    await this.flushStatuses();
    return job;
  }

  accept(repository, pr, options = {}) {
    if (this.config.infrastructure?.externalDispatch && !options.settings) return null;
    repository = this.repo(repository)?.name || repository;
    if (!this.eligible(repository, pr, options)) {
      this.state.cancel(repository, pr.number);
      this.abortSuperseded();
      return null;
    }
    const pending = this.state.data.jobs.findLast((job) => job.key === `${repository}#${pr.number}` &&
      ["queued", "running"].includes(job.state));
    const pendingBaseChanged = pending && pending.base !== pr.base.sha;
    const job = this.state.enqueue(repository, pr, { ...options, force: options.force || pendingBaseChanged,
      fullReview: options.fullReview ?? (options.force === true) });
    this.abortSuperseded();
    if (job) this.log("queued", { id: job.id, repository, number: job.number, head: job.head });
    return job;
  }

  abortSuperseded() {
    for (const worker of this.workers.values()) {
      if (worker.job.state === "superseded") worker.controller.abort();
    }
  }

  flushStatuses() {
    if (!this.statusFlush) this.statusFlush = this.sendQueuedStatuses().finally(() => { this.statusFlush = null; });
    return this.statusFlush;
  }

  async sendQueuedStatuses() {
    try {
      for (const job of this.state.data.jobs) {
        if (job.state !== "queued" || job.pendingSent) continue;
        await this.status(job, "pending", `OCR queued for ${job.head.slice(0, 8)}`);
        job.pendingSent = true;
        this.state.save();
      }
      this.statusError = null;
    } catch (error) {
      this.statusError = error.message;
      this.log("queue_status_failed", { error: error.message });
      if (error.persistence) throw error;
    }
  }

  async poll() {
    if (this.config.infrastructure?.externalDispatch) {
      this.lastPoll = new Date().toISOString(); this.pollError = null;
      await this.flushStatuses(); return;
    }
    if (this.polling || this.stopping) return;
    this.polling = true;
    try {
      for (const repository of this.config.repositories) {
        const pulls = [];
        for (let page = 1; ; page++) {
          const { data } = await this.github.rest.pulls.list({ ...this.coordinates(repository.name), page, per_page: 100 });
          pulls.push(...data);
          if (data.length < 100) break;
        }
        const baseline = !this.state.data.initialized[repository.name] && !this.config.bootstrapExisting;
        for (const pr of pulls) this.accept(repository.name, pr, { baseline });
        const open = new Set(pulls.map((pr) => pr.number));
        for (const job of this.state.data.jobs) {
          if (job.repository === repository.name && !open.has(job.number) && ["queued", "running"].includes(job.state)) {
            this.state.cancel(repository.name, job.number);
          }
        }
        this.abortSuperseded();
        this.state.data.initialized[repository.name] = true;
        this.state.save();
      }
      await this.flushStatuses();
      this.lastPoll = new Date().toISOString(); this.pollError = null;
    } catch (error) {
      this.pollError = error.message;
      this.log("poll_failed", { error: error.message });
      if (error.persistence) throw error;
    } finally { this.polling = false; }
  }

  async status(job, state, description, target) {
    if (job.settings?.preview) return;
    if (job.ciRequestId) return this.orgCI.publishJobStatus(job, state, description, target);
    await this.github.rest.repos.createCommitStatus({ ...this.coordinates(job.repository), sha: job.head,
      context: this.config.statusContext, state, description: description.slice(0, 140),
      ...(target ? { target_url: target } : {}) });
  }

  captureProgress(job) {
    if (job.settings?.preview || !job.snapshot || !job.directory) return;
    const progress = readProgress(job.directory, job.snapshot);
    if (!progress) return;
    job.progress = { ...progress, workspace: job.workspace, slot: job.slot };
    const checkpoint = checkpointFor(job, job.snapshot, progress);
    if (checkpoint && !["superseded", "cancelled"].includes(job.state)) {
      this.state.data.checkpoints[job.key] = checkpoint;
      this.log("checkpoint_saved", { id: job.id, head: job.head, findings: progress.findings });
    }
    this.state.save();
  }

  async execute(job, signal, slot = 0) {
    const options = executionOptions(job.settings);
    if (job.retryBudget != null) {
      const infra = this.config.infrastructure || {};
      if (!infra.budgetRetry?.enabled || (infra.dispatchEnabled === false && !job.ciRequestId)) throw Object.assign(new Error("Budget retry is disabled by policy"), { retryable: false });
      const { Infrastructure } = require("./infrastructure.js");
      const actor = job.ciRequestId ? { id: job.requestedBy, role: "admin" } : infra.clients?.find((c) => c.id === job.requestedBy);
      if (!actor) throw Object.assign(new Error("Budget retry client is no longer authorized"), { retryable: false });
      new Infrastructure(this).authorize(job.repository, actor, true);
      resolveOptions(this.config, this.repo(job.repository), job.settings.profile, { ...job.settings.options, budget: job.retryBudget });
      options.budget = job.retryBudget;
    }
    const effective = { ...this.config, ...options, reviewSettings: job.settings || null };
    // A crash can leave a closed native report on disk before progress was saved.
    this.captureProgress(job);
    const outputs = {}, failures = [];
    const core = {
      info: (message) => this.log("review", { id: job.id, message }),
      notice: (message) => this.log("notice", { id: job.id, message }),
      warning: (message) => this.log("warning", { id: job.id, message }),
      setOutput: (key, value) => { outputs[key] = value; },
      setFailed: (message) => { failures.push(message); },
    };
    const context = { repo: this.coordinates(job.repository), eventName: "ocr_service",
      issue: { number: job.number }, allowDraft: !!job.ciRequestId, runId: job.id, runAttempt: job.attempt };
    const current = await this.github.rest.pulls.get({ ...context.repo, pull_number: job.number });
    if (!this.eligible(job.repository, current.data, job) || ((!job.snapshot || job.retryBudget != null) &&
        (current.data.head.sha !== job.head || current.data.base.sha !== job.base || current.data.base.ref !== job.baseRef))) {
      this.refresh(job, current.data);
      return { stale: true };
    }
    // Each slot owns its Git index, refs and working tree for the whole review.
    // Slot zero retains the original path and its existing object cache.
    const root = slot === 0 ? "repositories" : path.join("worker-repositories", String(slot));
    const cwd = path.join(this.config.stateDirectory, root, ...job.repository.split("/"));
    job.workspace = cwd;
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    await this.status(job, "pending", `OCR reviewing ${job.head.slice(0, 8)} (attempt ${job.attempt})`);
    job.phase = "preparation"; this.state.save();
    await this.prepare({ github: this.github, context, core, prNumber: job.number, cwd,
      temp: path.join(this.config.stateDirectory, "runs"), token: this.config.githubAuth?.mode === "app" ? await this.github.getToken() : this.config.gitTokenFile ? fs.readFileSync(this.config.gitTokenFile, "utf8").trim() : await this.github.getToken(),
      checkoutBase: true, signal, expectedHead: job.head, expectedBase: job.base, snapshot: job.snapshot,
      expectedBaseRef: job.baseRef,
      gitTimeoutMs: effective.fetchTimeoutSeconds * 1000 });
    if (signal.aborted) return { stale: true };
    if (outputs.should_review !== "true") {
      this.refresh(job, (await this.github.rest.pulls.get({ ...context.repo, pull_number: job.number })).data);
      return { stale: true };
    }
    job.directory = outputs.result_directory;
    if (options.background && !job.snapshot) {
      const file = path.join(job.directory, "metadata.json");
      const metadata = JSON.parse(fs.readFileSync(file, "utf8"));
      metadata.background += "\n\nOrchestrator context:\n" + options.background;
      fs.writeFileSync(file, JSON.stringify(metadata), { mode: 0o600 });
    }
    const { metadata, resume } = await planReview({ config: effective, job,
      checkpoint: this.state.data.checkpoints[job.key], directory: job.directory, cwd, signal });
    job.snapshot = metadata;
    job.slot = slot;
    job.range = metadata.range;
    this.log("review_range", { id: job.id, ...metadata.range, resume: resume || null });
    this.state.save();
    const saved = job.progress?.fingerprint === metadata.fingerprint && (job.progress.complete || job.progress.skipped) &&
      readProgress(job.progress.directory, metadata);
    if (saved?.complete || saved?.skipped) {
      job.directory = job.progress.directory;
      this.log("reuse_completed_review", { id: job.id, sessionId: saved.sessionId });
    } else {
      try {
        job.phase = "review"; this.state.save();
        await this.run({ core, directory: job.directory, cwd, binary: this.config.binary,
          provider: effective.provider, model: effective.model, budget: effective.budget,
          timeoutMs: effective.timeoutSeconds * 1000, signal, resume, options });
      } finally {
        this.captureProgress(job);
      }
    }
    if (signal.aborted) return { stale: true };
    if (options.preview) {
      const code = JSON.parse(fs.readFileSync(path.join(job.directory, "exit-code.json"), "utf8"));
      if (code !== 0) throw Object.assign(new Error("Native preview failed"), { retryable: false });
      JSON.parse(fs.readFileSync(path.join(job.directory, "result.json"), "utf8"));
      return { preview: true, reviewed: false };
    }
    const observed = await this.github.rest.pulls.get({ ...context.repo, pull_number: job.number });
    if (job.replacement || !this.eligible(job.repository, observed.data, job) || observed.data.head.sha !== job.head ||
        observed.data.base.sha !== job.base || observed.data.base.ref !== job.baseRef) {
      this.refresh(job, observed.data);
      if (!["superseded", "cancelled"].includes(job.state) && !job.progress?.complete && !job.progress?.skipped) {
        throw Object.assign(new Error("Snapshot review incomplete; resume before reviewing the queued head"),
          { retryable: !job.progress?.budgetExceeded });
      }
      return { stale: true, checkpoint: job.progress?.complete || false };
    }
    // Retry incomplete native runs before any findings or diagnostics reach the PR.
    const progress = readProgress(job.directory, job.snapshot);
    if (!progress?.complete && !progress?.skipped) {
      if (progress?.budgetExceeded) throw Object.assign(new Error("Token budget guard stopped review before full coverage"), { retryable: false, budgetExceeded: true });
      throw new Error("Native review incomplete; inspect job artifacts");
    }
    job.phase = "publication"; this.state.save();
    const result = await this.publish({ github: this.github, context, core, directory: job.directory, blockSeverity: effective.blockSeverity });
    if (signal.aborted) return { stale: true };
    if (result?.stale) {
      this.refresh(job, (await this.github.rest.pulls.get({ ...context.repo, pull_number: job.number })).data);
      return result;
    }
    if (failures.length || !result || result.incomplete) {
      if (result?.budgetExceeded) throw Object.assign(new Error("Token budget guard stopped review before full coverage"), { retryable: false, budgetExceeded: true });
      throw new Error("Review or publication incomplete; inspect job artifacts");
    }
    const ranks = { critical: 4, high: 3, medium: 2, low: 1, none: 5 };
    const blocking = result.comments.filter((comment) => (ranks[comment.severity] || 0) >= ranks[effective.blockSeverity]);
    const latest = await this.github.rest.pulls.get({ ...context.repo, pull_number: job.number });
    if (!this.eligible(job.repository, latest.data, job) || latest.data.head.sha !== job.head ||
        latest.data.base.sha !== job.base || latest.data.base.ref !== job.baseRef) {
      this.refresh(job, latest.data);
      return { stale: true };
    }
    if (signal.aborted) return { stale: true };
    const finalResult = { summaryURL: result.summaryURL, findings: result.comments.length, blocking: blocking.length, skipped: result.skipped };
    const outcome = jobOutcome({ ...job, state: "complete", result: finalResult });
    await this.status(job, outcome.commitStatus, outcome.description, result.summaryURL);
    return finalResult;
  }

  async tick() {
    await this.flushStatuses();
    if (this.stopping) return;
    const tasks = [];
    for (let slot = 0; slot < this.config.prConcurrency; slot++) {
      if (this.workers.has(slot)) continue;
      const busy = new Set([...this.workers.values()].map(({ job }) => job.key));
      const job = this.state.next(Date.now(), busy, (candidate) => !candidate.snapshot || candidate.slot === slot ||
        !Number.isInteger(candidate.slot) || candidate.slot >= this.config.prConcurrency);
      if (!job) continue;
      job.state = "running"; job.attempt++; job.startedAt = new Date().toISOString();
      this.state.save();
      const controller = new AbortController();
      this.workers.set(slot, { job, controller });
      tasks.push(this.runJob(job, controller, slot));
    }
    await Promise.all(tasks);
  }

  increaseRetryBudget(job) {
    const infra = this.config.infrastructure || {}, policy = infra.budgetRetry;
    if (!policy?.enabled || (infra.dispatchEnabled === false && !job.ciRequestId) || !job.settings || job.settings.preview || job.replacement ||
        job.attempt >= this.config.maxAttempts || (job.budgetRetries || []).length >= policy.maxRetries) return false;
    const current = job.retryBudget ?? job.settings.options.budget;
    const repository = this.repo(job.repository);
    if (!repository || !Number.isSafeInteger(current) || current < 1) return false;
    const limit = repository.limits?.budget ?? infra.limits?.budget ?? 1000000;
    const next = policy.unlimitedAfter && current >= policy.unlimitedAfter ? 0 : Math.min(limit, current * policy.multiplier);
    if (next !== 0 && next <= current) return false;
    resolveOptions(this.config, repository, job.settings.profile, { ...job.settings.options, budget: next });
    (job.budgetRetries ||= []).push({ attempt: job.attempt, from: current, to: next,
      directory: job.directory, reason: "native_budget_guard", at: new Date().toISOString() });
    job.retryBudget = next;
    this.log("budget_retry_scheduled", { id: job.id, from: current, to: next, retry: job.budgetRetries.length });
    return true;
  }

  async runJob(job, controller, slot) {
    this.log("started", { id: job.id, repository: job.repository, number: job.number, head: job.head, slot });
    try {
      const result = await this.execute(job, controller.signal, slot);
      if (!["superseded", "cancelled"].includes(job.state)) {
        if (this.stopping) { job.state = "queued"; job.nextAt = 0; job.attempt--; }
        else job.state = result.stale ? (result.checkpoint ? "checkpointed" : "superseded") : "complete";
      }
      if (job.state !== "cancelled") job.result = result;
      delete job.error; delete job.failurePhase;
    } catch (error) {
      if (error.persistence) throw error;
      job.error = error.message; job.failurePhase = job.phase || "execution";
      if (!["superseded", "cancelled"].includes(job.state)) {
        if (this.stopping) { job.state = "queued"; job.nextAt = 0; job.attempt--; }
        else {
          let budgetRetry = false;
          if (error.budgetExceeded) {
            try { budgetRetry = this.increaseRetryBudget(job); }
            catch (policyError) { job.error = `Budget retry rejected: ${policyError.message}`; }
          }
          job.state = (budgetRetry || error.retryable !== false) && job.attempt < this.config.maxAttempts ? "queued" : "failed";
          if (budgetRetry) job.pendingSent = false;
          job.nextAt = Date.now() + this.config.retrySeconds * 1000 * 2 ** (job.attempt - 1);
          try { await this.status(job, job.state === "queued" ? "pending" : "error",
            budgetRetry ? `OCR budget guard; retry scheduled with ${job.retryBudget === 0 ? "unlimited tokens" : `${job.retryBudget} tokens`}` :
              job.state === "queued" ? "OCR incomplete; retry scheduled" : job.error); }
          catch (statusError) { this.log("status_failed", { id: job.id, error: statusError.message }); }
        }
      }
      this.log("job_error", { id: job.id, error: error.message });
    } finally {
      job.updatedAt = new Date().toISOString();
      if (job.directory) {
        try { const now = new Date(); fs.utimesSync(job.directory, now, now); }
        catch (error) { this.log("artifact_timestamp_failed", { id: job.id, error: error.message }); }
      }
      try { queueFeedback(this, job); this.state.save(); } finally { this.workers.delete(slot); }
      this.log("finished", { id: job.id, state: job.state });
    }
  }

  cleanup() {
    const cutoff = Date.now() - this.config.retentionDays * 86400000;
    const directory = path.join(this.config.stateDirectory, "runs");
    const protectedPaths = new Set(this.state.data.jobs.filter((job) => ["queued", "running"].includes(job.state))
      .flatMap((job) => [job.directory, job.progress?.directory]));
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name.startsWith("ocr-pr-") && !protectedPaths.has(name) && fs.statSync(name).mtimeMs < cutoff) {
        fs.rmSync(name, { recursive: true, force: true });
      }
    }
    if (this.state.data.deliveries) this.state.data.deliveries = this.state.data.deliveries.filter((event) =>
      event.state === "pending" || Date.parse(event.updatedAt || event.createdAt) >= cutoff);
    this.state.data.jobs = this.state.data.jobs.filter((job) => ["queued", "running"].includes(job.state) ||
      Date.parse(job.updatedAt || job.createdAt) >= cutoff);
    if (this.state.data.agentFeedback) this.state.data.agentFeedback = this.state.data.agentFeedback.filter((item) =>
      item.state !== "sent" || Date.parse(item.sentAt) >= cutoff);
    this.state.save();
  }

  stop() {
    this.stopping = true;
    for (const worker of this.workers.values()) worker.controller.abort();
  }
}

module.exports = { ReviewService, configuration };
