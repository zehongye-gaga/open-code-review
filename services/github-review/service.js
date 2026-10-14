// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { State } = require("./state.js");
const { prepareReview, runReview, publishReview } = require("./review.js");

const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function configuration(input) {
  const config = { listen: "127.0.0.1", port: 8787, pollSeconds: 30, bootstrapExisting: true,
    binary: "/usr/local/bin/ocr", provider: "openai-codex", model: "gpt-6-astra",
    budget: 0, timeoutSeconds: 1500, fetchTimeoutSeconds: 600, maxAttempts: 3, retrySeconds: 60,
    retentionDays: 7, prConcurrency: 1, statusContext: "ocr-review", blockSeverity: "high", ...input };
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
  for (const key of ["pollSeconds", "timeoutSeconds", "fetchTimeoutSeconds", "maxAttempts", "retrySeconds", "retentionDays", "prConcurrency"]) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  if (!Number.isSafeInteger(config.budget) || config.budget < 0) throw new Error("budget must be non-negative");
  if (!["critical", "high", "medium", "low", "none"].includes(config.blockSeverity)) throw new Error("Invalid blockSeverity");
  if (typeof config.bootstrapExisting !== "boolean") throw new Error("bootstrapExisting must be boolean");
  if (!Number.isSafeInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error("Invalid port");
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

  repo(name) { return typeof name === "string" && this.config.repositories.find((repo) => repo.name === name.toLowerCase()); }
  get active() { return this.workers.values().next().value || null; }
  coordinates(name) { const [owner, repo] = name.split("/"); return { owner, repo }; }
  eligible(repository, pr) {
    const repo = this.repo(repository);
    return repo && pr.state === "open" && !pr.draft && repo.baseBranches.includes(pr.base?.ref) &&
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
    repository = this.repo(repository)?.name || repository;
    if (!this.eligible(repository, pr)) {
      this.state.cancel(repository, pr.number);
      this.abortSuperseded();
      return null;
    }
    const pendingBaseChanged = this.state.data.jobs.some((job) => job.key === `${repository}#${pr.number}` &&
      ["queued", "running"].includes(job.state) && job.base !== pr.base.sha);
    const job = this.state.enqueue(repository, pr, { ...options, force: options.force || pendingBaseChanged });
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
    await this.github.rest.repos.createCommitStatus({ ...this.coordinates(job.repository), sha: job.head,
      context: this.config.statusContext, state, description: description.slice(0, 140),
      ...(target ? { target_url: target } : {}) });
  }

  async execute(job, signal, slot = 0) {
    const outputs = {}, failures = [];
    const core = {
      info: (message) => this.log("review", { id: job.id, message }),
      notice: (message) => this.log("notice", { id: job.id, message }),
      warning: (message) => this.log("warning", { id: job.id, message }),
      setOutput: (key, value) => { outputs[key] = value; },
      setFailed: (message) => { failures.push(message); },
    };
    const context = { repo: this.coordinates(job.repository), eventName: "ocr_service",
      issue: { number: job.number }, runId: job.id, runAttempt: job.attempt };
    const current = await this.github.rest.pulls.get({ ...context.repo, pull_number: job.number });
    if (!this.eligible(job.repository, current.data) || current.data.head.sha !== job.head || current.data.base.sha !== job.base) {
      this.accept(job.repository, current.data);
      return { stale: true };
    }
    // Each slot owns its Git index, refs and working tree for the whole review.
    // Slot zero retains the original path and its existing object cache.
    const root = slot === 0 ? "repositories" : path.join("worker-repositories", String(slot));
    const cwd = path.join(this.config.stateDirectory, root, ...job.repository.split("/"));
    job.workspace = cwd;
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    await this.status(job, "pending", `OCR reviewing ${job.head.slice(0, 8)} (attempt ${job.attempt})`);
    await this.prepare({ github: this.github, context, core, prNumber: job.number, cwd,
      temp: path.join(this.config.stateDirectory, "runs"), token: this.github.getToken(),
      checkoutBase: true, signal, expectedHead: job.head, expectedBase: job.base,
      gitTimeoutMs: this.config.fetchTimeoutSeconds * 1000 });
    if (signal.aborted) return { stale: true };
    if (outputs.should_review !== "true") {
      await this.observe(job.repository, job.number, { force: true });
      return { stale: true };
    }
    job.directory = outputs.result_directory;
    this.state.save();
    await this.run({ core, directory: job.directory, cwd, binary: this.config.binary,
      provider: this.config.provider, model: this.config.model, budget: this.config.budget,
      timeoutMs: this.config.timeoutSeconds * 1000, signal });
    if (signal.aborted) return { stale: true };
    const result = await this.publish({ github: this.github, context, core, directory: job.directory });
    if (result?.stale) {
      await this.observe(job.repository, job.number, { force: true });
      return result;
    }
    if (failures.length || !result || result.incomplete) {
      if (result?.budgetExceeded) throw Object.assign(new Error("Token budget exceeded; adjust the budget and request a rerun"), { retryable: false });
      throw new Error("Review or publication incomplete; inspect job artifacts");
    }
    const ranks = { critical: 4, high: 3, medium: 2, low: 1, none: 5 };
    const blocking = result.comments.filter((comment) => (ranks[comment.severity] || 0) >= ranks[this.config.blockSeverity]);
    const latest = await this.github.rest.pulls.get({ ...context.repo, pull_number: job.number });
    if (!this.eligible(job.repository, latest.data) || latest.data.head.sha !== job.head || latest.data.base.sha !== job.base) {
      this.accept(job.repository, latest.data);
      return { stale: true };
    }
    await this.status(job, blocking.length ? "failure" : "success",
      blocking.length ? `OCR found ${blocking.length} blocking finding(s)` : `OCR complete: ${result.comments.length} finding(s)`, result.summaryURL);
    return { summaryURL: result.summaryURL, findings: result.comments.length, blocking: blocking.length, skipped: result.skipped };
  }

  async tick() {
    await this.flushStatuses();
    if (this.stopping) return;
    const tasks = [];
    for (let slot = 0; slot < this.config.prConcurrency; slot++) {
      if (this.workers.has(slot)) continue;
      const busy = new Set([...this.workers.values()].map(({ job }) => job.key));
      const job = this.state.next(Date.now(), busy);
      if (!job) break;
      job.state = "running"; job.attempt++; job.startedAt = new Date().toISOString();
      this.state.save();
      const controller = new AbortController();
      this.workers.set(slot, { job, controller });
      tasks.push(this.runJob(job, controller, slot));
    }
    await Promise.all(tasks);
  }

  async runJob(job, controller, slot) {
    this.log("started", { id: job.id, repository: job.repository, number: job.number, head: job.head, slot });
    try {
      const result = await this.execute(job, controller.signal, slot);
      if (job.state !== "superseded") {
        if (this.stopping) { job.state = "queued"; job.nextAt = 0; job.attempt--; }
        else job.state = result.stale ? "superseded" : "complete";
      }
      job.result = result;
      delete job.error;
    } catch (error) {
      if (error.persistence) throw error;
      job.error = error.message;
      if (job.state !== "superseded") {
        if (this.stopping) { job.state = "queued"; job.nextAt = 0; job.attempt--; }
        else {
          job.state = error.retryable !== false && job.attempt < this.config.maxAttempts ? "queued" : "failed";
          job.nextAt = Date.now() + this.config.retrySeconds * 1000 * 2 ** (job.attempt - 1);
          try { await this.status(job, "error", job.state === "queued" ? "OCR incomplete; retry scheduled" : job.error); }
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
      try { this.state.save(); } finally { this.workers.delete(slot); }
      this.log("finished", { id: job.id, state: job.state });
    }
  }

  cleanup() {
    const cutoff = Date.now() - this.config.retentionDays * 86400000;
    const directory = path.join(this.config.stateDirectory, "runs");
    const protectedPaths = new Set(this.state.data.jobs.filter((job) => ["queued", "running"].includes(job.state)).map((job) => job.directory));
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name.startsWith("ocr-pr-") && !protectedPaths.has(name) && fs.statSync(name).mtimeMs < cutoff) {
        fs.rmSync(name, { recursive: true, force: true });
      }
    }
    this.state.data.jobs = this.state.data.jobs.filter((job) => ["queued", "running"].includes(job.state) ||
      Date.parse(job.updatedAt || job.createdAt) >= cutoff);
    this.state.save();
  }

  stop() {
    this.stopping = true;
    for (const worker of this.workers.values()) worker.controller.abort();
  }
}

module.exports = { ReviewService, configuration };
