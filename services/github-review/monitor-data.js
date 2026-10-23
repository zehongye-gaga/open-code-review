// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { auditRows, repositoryUsage, cpuSample } = require("./monitor-audit.js");
const { Analytics } = require("./analytics.js");
const { runRows, summarize } = require("./analytics-summary.js");

const execute = promisify(execFile);
const activeStates = new Set(["running", "publishing", "error_publishing"]);
const queuedStates = new Set(["queued", "publish_pending", "error_publish_pending"]);
const numeric = (n) => Number.isFinite(n) && n >= 0 ? n : 0;
const timestamp = (value) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const iso = (value) => timestamp(value) ? new Date(value).toISOString() : null;
const canonicalRepo = (value) => typeof value === "string" ? value.toLowerCase() : "";
const age = (value, now) => timestamp(value) ? Math.max(0, (now - timestamp(value)) / 1000) : null;
const latest = (items) => [...items].sort((a, b) => timestamp(b.updatedAt || b.createdAt) - timestamp(a.updatedAt || a.createdAt));
const safeURL = (url) => {
  try { const value = new URL(url); return value.protocol === "https:" && value.hostname === "github.com" ? value.href : null; }
  catch { return null; }
};

function readJSON(file, limit = 16 * 1024 * 1024) {
  if (fs.statSync(file).size > limit) throw new Error("Input exceeds monitor size limit");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readText(file) {
  try { return fs.readFileSync(file, "utf8").trim(); } catch { return null; }
}

function filesystem(directory, label) {
  try {
    const stat = fs.statfsSync(directory);
    return { label, totalBytes: stat.blocks * stat.bsize, availableBytes: stat.bavail * stat.bsize, totalInodes: stat.files, freeInodes: stat.ffree };
  } catch { return { label, totalBytes: null, availableBytes: null }; }
}

let previousCPU;
function hostResources(volumes) {
  const sample = cpuSample(readText("/proc/stat"), previousCPU); previousCPU = sample.counter;
  const mem = readText("/proc/meminfo") || "";
  const memValue = (key) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(mem)?.[1] || 0) * 1024;
  const available = /^MemAvailable:\s+(\d+)/m.exec(readText("/proc/meminfo") || "");
  return { cpu: sample.usage, swapTotalBytes: memValue("SwapTotal"), swapFreeBytes: memValue("SwapFree"), memoryTotalBytes: os.totalmem(), memoryAvailableBytes: available ? Number(available[1]) * 1024 : os.freemem(),
    load: os.loadavg(), cpuCount: os.cpus().length, uptimeSeconds: os.uptime(),
    volumes: volumes.map((volume) => filesystem(volume.path, volume.label)) };
}

async function unitStatus(unit) {
  if (!/^[a-zA-Z0-9_.@-]+\.service$/.test(unit)) throw new Error("Invalid systemd service name");
  try {
    const { stdout } = await execute("systemctl", ["show", unit, "--property=ActiveState,SubState,MainPID,ActiveEnterTimestampMonotonic,NRestarts,ControlGroup"],
      { timeout: 4000, maxBuffer: 16384 });
    const fields = Object.fromEntries(stdout.trim().split("\n").map((line) => {
      const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
    }));
    const memory = readText(path.join("/sys/fs/cgroup", fields.ControlGroup || "missing", "memory.current"));
    return { state: fields.ActiveState || "unknown", substate: fields.SubState || "unknown",
      pid: numeric(Number(fields.MainPID)), restarts: numeric(Number(fields.NRestarts)),
      uptimeSeconds: fields.ActiveState === "active" ? Math.max(0, os.uptime() - Number(fields.ActiveEnterTimestampMonotonic || 0) / 1e6) : 0,
      memoryBytes: memory !== null && /^\d+$/.test(memory) ? Number(memory) : null };
  } catch { return { state: "unknown", substate: "unavailable", memoryBytes: null, pid: null, restarts: null, uptimeSeconds: null }; }
}

async function getHealth(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: "error" });
    const body = await response.json();
    return { reachable: true, ok: response.ok && body.status === "ok", lastPoll: iso(body.lastPoll),
      running: Number.isSafeInteger(body.running) ? body.running : null,
      queued: Number.isSafeInteger(body.queued) ? body.queued : null };
  } catch { return { reachable: false, ok: false, lastPoll: null, running: null, queued: null }; }
}

function ocrRow(job) {
  return { engine: "ocr", id: String(job.id), repository: canonicalRepo(job.repository), number: job.number,
    head: job.head, state: job.state, attempt: numeric(job.attempt), slot: job.slot ?? null,
    createdAt: iso(job.createdAt), startedAt: iso(job.startedAt), updatedAt: iso(job.updatedAt || job.createdAt),
    nextAt: Number.isFinite(job.nextAt) && job.nextAt > 0 ? new Date(job.nextAt).toISOString() : null,
    findings: Number.isFinite(job.result?.findings) ? job.result.findings : null,
    blocking: Number.isFinite(job.result?.blocking) ? job.result.blocking : null,
    resultURL: safeURL(job.result?.summaryURL), incremental: job.range?.mode === "checkpoint",
    resume: Boolean(job.progress?.sessionId),
    coverage: job.progress ? { selected: numeric(job.progress.selected), complete: job.progress.complete === true } : null };
}

function crRow(review, repository, id) {
  const state = String(review.status || "unknown");
  return { engine: "cragent", id, repository: canonicalRepo(repository), number: review.pr?.number, head: review.pr?.head?.sha,
    state, verdict: ["PASS", "FAIL"].includes(review.verdict) ? review.verdict : null,
    attempt: numeric(review.retry_count), updatedAt: iso(review.updated_at), startedAt: iso(review.updated_at),
    nextAt: iso(review.next_attempt_at), findings: null, resultURL: safeURL(review.pr?.html_url) };
}

function statusFor(pr, context, jobs) {
  const commit = pr.commits?.nodes?.[0]?.commit;
  const contexts = commit?.oid === pr.headRefOid ? commit.status?.contexts || [] : [];
  const status = latest(contexts.filter((item) => item.context === context).map((item) => ({ ...item, updatedAt: item.createdAt })))[0];
  const local = latest(jobs.filter((job) => job.head === pr.headRefOid && job.number === pr.number))[0];
  return { state: status?.state?.toLowerCase() || "missing", updatedAt: iso(status?.createdAt),
    url: safeURL(status?.targetUrl), jobState: local?.state || null, attempt: local?.attempt || 0,
    findings: local?.findings ?? null };
}

function joinPulls(githubPulls, config, ocrJobs, crJobs) {
  return githubPulls.map((pr) => {
    const repository = config.repositories.find((item) => item.name === pr.repository);
    const inScope = !pr.isDraft && Boolean(repository) &&
      (!repository.baseBranches?.length || repository.baseBranches.includes("*") || repository.baseBranches.includes(pr.baseRefName));
    return { repository: pr.repository, number: pr.number, title: String(pr.title || ""), url: safeURL(pr.url),
      head: pr.headRefOid, base: pr.baseRefName, draft: Boolean(pr.isDraft), inScope, updatedAt: iso(pr.updatedAt),
      ocr: statusFor(pr, config.statusContext || "ocr-review", ocrJobs.filter((job) => job.repository === pr.repository)),
      cragent: statusFor(pr, config.cragentContext || "codex-insightflow-review", crJobs.filter((job) => job.repository === pr.repository)) };
  });
}

class ReportCache {
  constructor(directory) { this.root = path.join(fs.realpathSync(directory), "runs"); this.cache = new Map(); }

  get(job) {
    if (!job.directory) return null;
    try {
      const file = fs.realpathSync(path.join(job.directory, "result.json"));
      if (!file.startsWith(this.root + path.sep)) return null;
      const stat = fs.statSync(file), key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      if (this.cache.get(file)?.key === key) return this.cache.get(file).value;
      const report = readJSON(file), summary = report.summary;
      if (!summary || !Number.isFinite(summary.total_tokens)) return null;
      const value = { totalTokens: numeric(summary.total_tokens), inputTokens: numeric(summary.input_tokens),
        outputTokens: numeric(summary.output_tokens), cacheReadTokens: numeric(summary.cache_read_tokens),
        files: numeric(summary.files_reviewed), elapsed: typeof summary.elapsed === "string" ? summary.elapsed.slice(0, 40) : null };
      this.cache.set(file, { key, value });
      if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value);
      return value;
    } catch { return null; }
  }
}

const query = `query($owner:String!,$name:String!,$after:String){
  repository(owner:$owner,name:$name){pullRequests(first:100,after:$after,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}){
    pageInfo{hasNextPage endCursor}
    nodes{number title url isDraft updatedAt baseRefName headRefOid
      commits(last:1){nodes{commit{oid status{contexts{context state targetUrl createdAt}}}}}}
  }} rateLimit{remaining resetAt}
}`;

async function githubPulls(config, request = fetch) {
  const token = fs.readFileSync(config.githubTokenFile, "utf8").trim();
  if (!token) throw new Error("Missing GitHub credential");
  const pulls = []; let remaining = null;
  for (const repository of config.repositories) {
    const [owner, name] = repository.name.split("/"); let after = null;
    for (let page = 0; page < 10; page++) {
      const response = await request("https://api.github.com/graphql", { method: "POST", redirect: "error",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "ocr-review-monitor" },
        signal: AbortSignal.timeout(20000), body: JSON.stringify({ query, variables: { owner, name, after } }) });
      if (!response.ok) throw new Error("GitHub request failed");
      const body = await response.json(), batch = body.data?.repository?.pullRequests;
      if (body.errors?.length || !batch || !Array.isArray(batch.nodes)) throw new Error("GitHub response incomplete");
      pulls.push(...batch.nodes.map((pr) => ({ ...pr, repository: repository.name })));
      remaining = body.data.rateLimit?.remaining ?? null;
      if (!batch.pageInfo.hasNextPage) break;
      if (page === 9 || !batch.pageInfo.endCursor) throw new Error("GitHub pagination incomplete");
      after = batch.pageInfo.endCursor;
    }
  }
  return { pulls, remaining };
}

class Monitor {
  constructor(options, dependencies = {}) {
    this.options = options;
    this.now = dependencies.now || Date.now;
    this.unit = dependencies.unit || unitStatus;
    this.health = dependencies.health || getHealth;
    this.github = dependencies.github || githubPulls;
    this.resources = dependencies.resources || hostResources;
    this.config = readJSON(options.ocrConfig);
    if (!Array.isArray(this.config.repositories) || !this.config.stateDirectory) throw new Error("Invalid OCR configuration");
    this.config.repositories = this.config.repositories.map((repository) => ({ ...repository, name: canonicalRepo(repository.name) }));
    this.reports = new ReportCache(this.config.stateDirectory);
    this.analytics = options.analytics ? new Analytics(this.config, options.analytics) : null;
    this.local = null;
    this.remote = { pulls: [], updatedAt: null, error: false, remaining: null };
    this.localBusy = false; this.githubBusy = false;
    this.crCache = new Map();
  }

  async collect() {
    if (this.localBusy) return;
    this.localBusy = true;
    try {
      const now = this.now(), previous = this.local;
      const [ocrUnit, crUnit, health] = await Promise.all([
        this.unit(this.options.ocrUnit || "ocr-review.service"),
        this.options.cragent ? this.unit(this.options.cragent.unit || "cragent.service") : null,
        this.health(this.options.ocrHealthURL || "http://127.0.0.1:8787/healthz"),
      ]);
      let audit = previous?.audit || [], ocrJobs = [], nativeJobs = [], ocrError = false, crError = false, crJobs = [];
      const crSources = [];
      try {
        const state = readJSON(path.join(this.config.stateDirectory, "state.json"));
        if (state.version !== 1 || !Array.isArray(state.jobs)) throw new Error("Invalid OCR state");
        nativeJobs = state.jobs;
        audit = auditRows(state);
        ocrJobs = state.jobs.map(ocrRow);
      } catch { ocrError = true; ocrJobs = previous?.ocrJobs || []; }
      for (const source of this.options.cragent?.states || []) {
        let lastPoll = null, error = false;
        try {
          const state = readJSON(source.file);
          if (!state.reviews || typeof state.reviews !== "object") throw new Error("Invalid CR Agent state");
          this.crCache.set(source.file, Object.entries(state.reviews).map(([id, review]) => crRow(review, source.repository, `${source.name || source.repository}:${id}`)));
        } catch { crError = true; error = true; }
        crJobs.push(...this.crCache.get(source.file) || []);
        try {
          const snapshot = readJSON(path.join(path.dirname(source.file), "current-open-pr-snapshot.json"));
          lastPoll = iso(snapshot.captured_at);
        } catch { crError = true; error = true; }
        crSources.push({ name: source.name || canonicalRepo(source.repository), lastPoll, error });
      }
      if (this.options.cragent && !crSources.length) crError = true;
      const crPoll = crSources.reduce((oldest, source) => Math.min(oldest, timestamp(source.lastPoll)), Infinity);
      const completed = nativeJobs.filter((job) => ["complete", "checkpointed"].includes(job.state) && timestamp(job.updatedAt) >= now - 86400000);
      const usage = { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reports: 0, expectedReports: completed.length };
      const reports = new Map();
      for (const job of completed) {
        const report = this.reports.get(job);
        if (!report) continue;
        reports.set(String(job.id), report); usage.reports++;
        for (const key of ["totalTokens", "inputTokens", "outputTokens", "cacheReadTokens"]) usage[key] += report[key];
      }
      const counts = (jobs) => ({ running: jobs.filter((job) => activeStates.has(job.state)).length,
        queued: jobs.filter((job) => queuedStates.has(job.state)).length });
      const ocrCounts = counts(ocrJobs), crCounts = counts(crJobs);
      let analytics = this.analytics ? previous?.analytics || { enabled: true, pendingFiles: 1 } : { enabled: false };
      if (this.analytics) {
        try {
          if (ocrError) throw new Error("Review state unavailable");
          analytics = { ...await this.analytics.collect(nativeJobs, now), error: false };
        } catch { analytics = { ...analytics, error: true }; }
      }
      this.local = { audit, collectedAt: new Date(this.now()).toISOString(), ocrJobs, crJobs, usage, analytics, completedUsage: completed.map((job) => ({ repository: canonicalRepo(job.repository), report: reports.get(String(job.id)) || null })),
        resources: this.resources(this.options.volumes || [{ label: "Root", path: "/" }, { label: "Review data", path: this.config.stateDirectory }]),
        services: {
          ocr: { ...ocrUnit, ...ocrCounts, running: health.running ?? ocrCounts.running, queued: health.queued ?? ocrCounts.queued,
            reachable: health.reachable, healthy: health.ok && ocrUnit.state === "active" && !ocrError,
            sourceError: ocrError, lastPoll: health.lastPoll, pollSeconds: this.config.pollSeconds || 30,
            concurrency: this.config.prConcurrency || 1, model: this.config.model, provider: this.config.provider,
            budget: this.config.budget ?? 0, blockSeverity: this.config.blockSeverity || "high",
            timeoutSeconds: this.config.timeoutSeconds || 1500 },
          cragent: crUnit ? { ...crUnit, ...crCounts, sourceError: crError, lastPoll: crPoll > 0 && Number.isFinite(crPoll) ? new Date(crPoll).toISOString() : null,
            sources: crSources,
            healthy: crUnit.state === "active" && !crError, concurrency: this.options.cragent.concurrency || null,
            pollSeconds: this.options.cragent.pollSeconds || 120, timeoutSeconds: this.options.cragent.timeoutSeconds || 2700 } : null,
        },
        history: latest([...ocrJobs.filter((job) => ["complete", "checkpointed", "failed"].includes(job.state)),
          ...crJobs.filter((job) => job.state.startsWith("reviewed_") || ["error", "error_published", "error_closed_unpublished"].includes(job.state))])
          .map((job) => ({ ...job, usage: job.engine === "ocr" ? reports.get(job.id) || null : null })) };
    } finally { this.localBusy = false; }
  }

  async refreshGitHub() {
    if (this.githubBusy) return;
    this.githubBusy = true;
    try {
      const result = await this.github(this.config);
      this.remote = { ...result, error: false, updatedAt: new Date(this.now()).toISOString() };
    } catch { this.remote.error = true; }
    finally { this.githubBusy = false; }
  }

  analyticsPull(repository, number) {
    if (!this.analytics || !this.local?.analytics?.collectedAt) return null;
    const runs = runRows(this.analytics.ledger).filter((r) => r.repository === repository && r.number === number)
      .sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt) || Number(b.id) - Number(a.id));
    return { repository, number, collectedAt: this.local.analytics.collectedAt,
      error: this.local.analytics.error, runs };
  }

  snapshot(repository = "") {
    repository = canonicalRepo(repository);
    const now = this.now(), local = this.local;
    const repositories = [...new Set([...this.config.repositories.map((r) => r.name),
      ...(local?.audit || []).map((r) => r.repository),
      ...(local?.ocrJobs || []).map((r) => r.repository), ...(local?.crJobs || []).map((r) => r.repository),
      ...Object.values(this.analytics?.ledger.jobs || {}).map((r) => canonicalRepo(r.repository))])].filter(Boolean).sort();
    if (repository && !repositories.includes(repository)) throw Object.assign(new Error("Unknown repository"), { status: 404 });
    const matches = (row) => !repository || canonicalRepo(row.repository) === repository;
    if (!local) return { version: 1, ready: false, collectedAt: null };
    const stale = age(local.collectedAt, now) > 45;
    const githubStale = !this.remote.updatedAt || age(this.remote.updatedAt, now) > 180;
    const services = Object.fromEntries(Object.entries(local.services).map(([key, service]) => {
      if (!service) return [key, null];
      const pollStale = !service.lastPoll || age(service.lastPoll, now) > Math.max(90, service.pollSeconds * 3);
      const sources = service.sources?.map((source) => ({ ...source, stale: !source.lastPoll || age(source.lastPoll, now) > Math.max(90, service.pollSeconds * 3) }));
      return [key, { ...service, sources, pollStale, healthy: service.healthy && !pollStale && !stale }];
    }));
    let usage = local.usage, analytics = local.analytics;
    if (repository) {
      const completed = local.completedUsage.filter(matches);
      usage = { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reports: 0, expectedReports: completed.length };
      for (const row of completed) if (row.report) {
        usage.reports++;
        for (const key of ["totalTokens", "inputTokens", "outputTokens", "cacheReadTokens"]) usage[key] += row.report[key];
      }
      if (this.analytics && local.analytics.collectedAt) {
        const ledger = this.analytics.ledger;
        const scoped = { ...ledger, jobs: Object.fromEntries(Object.entries(ledger.jobs).filter(([, row]) => matches(row))),
          sessions: Object.fromEntries(Object.entries(ledger.sessions).filter(([, row]) => matches(row))) };
        analytics = summarize(scoped, this.analytics.options, now, { error: local.analytics.error });
      }
    }
    const work = [...local.ocrJobs, ...local.crJobs].filter(matches).filter((job) => activeStates.has(job.state) || queuedStates.has(job.state));
    const scopedCounts = Object.fromEntries(["ocr", "cragent"].map((engine) => [engine, {
      running: work.filter((job) => job.engine === engine && activeStates.has(job.state)).length,
      queued: work.filter((job) => job.engine === engine && queuedStates.has(job.state)).length,
    }]));
    return { version: 1, ready: true, repositories, repository, scopedCounts, collectedAt: local.collectedAt, stale,
      github: { updatedAt: this.remote.updatedAt, stale: githubStale, error: this.remote.error, remaining: this.remote.remaining },
      services, resources: local.resources, usage, analytics,
      audit: (local.audit || []).filter(matches).slice(0, 200),
      repositoryUsage: repositoryUsage(analytics?.pulls || []),
      work: latest(work)
        .map((job) => ({ ...job, elapsedSeconds: age(job.startedAt || job.createdAt || job.updatedAt, now),
          overdue: job.state === "running" && age(job.startedAt || job.updatedAt, now) > (services[job.engine]?.timeoutSeconds || 2700) + 120 })),
      pulls: joinPulls(this.remote.pulls.filter(matches), { ...this.config, cragentContext: this.options.cragent?.statusContext }, local.ocrJobs, local.crJobs),
      history: local.history.filter(matches).slice(0, 80) };
  }
}

module.exports = { Monitor, ReportCache, joinPulls, githubPulls, hostResources, unitStatus, getHealth };
