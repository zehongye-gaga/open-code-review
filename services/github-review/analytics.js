// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { summarize, dayKey, shiftDay, emptyUsage, addUsage } = require("./analytics-summary.js");

const number = (value) => Number.isFinite(value) && value >= 0 ? value : 0;
const stamp = (value) => Date.parse(value) || 0;
const phases = new Set(["grouping_task", "plan_task", "main_task", "review_filter_task", "re_location_task", "memory_compression_task"]);
const terminal = new Set(["complete", "checkpointed", "failed", "superseded"]);
const counts = (coverage) => coverage ? Object.fromEntries(["selected", "completed", "reused", "failed", "waived"]
  .map((key) => [key, Array.isArray(coverage[key]) ? coverage[key].length : null])) : null;
const encoded = (cwd) => cwd.replace(/^([A-Za-z]):[\\/]/, "$1_").replace(/^[\\/]+/, "").replace(/[\\/]/g, "-");

function json(file) {
  if (fs.statSync(file).size > 32 * 1024 * 1024) throw new Error("Analytics input is too large");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function entries(directory) {
  try { return fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

function atomicJSON(file, value) {
  const fd = fs.openSync(file + ".tmp", "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(file + ".tmp", file);
  const directory = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function record(row, event, timeZone) {
  if (event.type === "session_start") {
    if (event.cwd !== row.cwd) { row.ignored = true; return; }
    row.id = event.sessionId; row.startedAt = event.timestamp;
    row.head = event.diffTo; row.from = event.diffFrom; row.resumed = Boolean(event.resumedFrom);
  }
  if (row.ignored || !row.id) return;
  if (stamp(event.timestamp)) row.lastEventAt = event.timestamp;
  const delta = emptyUsage();
  if (event.type === "llm_request") delta.requests = 1;
  if (event.type === "llm_response") {
    delta.responses = 1;
    delta.inputTokens = number(event.usage?.prompt_tokens);
    delta.outputTokens = number(event.usage?.completion_tokens);
    delta.cacheReadTokens = number(event.usage?.cache_read_tokens);
    delta.cacheWriteTokens = number(event.usage?.cache_write_tokens);
    delta.totalTokens = delta.inputTokens + delta.outputTokens;
    delta.llmSeconds = number(event.duration_ms) / 1000;
    if (!event.usage) row.unreadableRecords++;
  }
  if (event.type === "llm_error") { delta.errors = 1; delta.llmSeconds = number(event.duration_ms) / 1000; }
  if (event.type === "tool_call") { delta.toolCalls = 1; delta.toolErrors = event.ok === false ? 1 : 0; }
  if (Object.values(delta).some(Boolean)) {
    const day = dayKey(event.timestamp, timeZone);
    if (day) addUsage(row.days[day] ||= emptyUsage(), delta);
    else row.unreadableRecords++;
    addUsage(row.usage, delta);
    const phase = phases.has(event.taskType) ? event.taskType : "other";
    addUsage(row.phases[phase] ||= emptyUsage(), delta);
    if (day) addUsage((row.phaseDays[day] ||= {})[phase] ||= emptyUsage(), delta);
  }
  if (event.type === "session_end") {
    row.endedAt = event.timestamp; row.nativeSeconds = number(event.duration_seconds);
    row.outcome = ["complete", "skipped", "failed", "partial"].includes(event.run_manifest?.terminal_state)
      ? event.run_manifest.terminal_state : "unknown";
    row.coverage = counts(event.run_manifest?.coverage);
  }
}

async function ingest(file, row, timeZone, end) {
  let pending = Buffer.alloc(0), discarded = 0, bytes = 0;
  const limit = 8 * 1024 * 1024;
  for await (const chunk of fs.createReadStream(file, { start: row.offset, end: end - 1, highWaterMark: 65536 })) {
    bytes += chunk.length;
    pending = Buffer.concat([pending, chunk]);
    let newline;
    while ((newline = pending.indexOf(10)) !== -1) {
      const line = pending.subarray(0, newline);
      if (discarded || line.length > limit) row.unreadableRecords++;
      else if (line.length) {
        try { record(row, JSON.parse(line.toString("utf8")), timeZone); }
        catch { row.unreadableRecords++; }
      }
      row.offset += discarded + newline + 1;
      discarded = 0; pending = pending.subarray(newline + 1);
    }
    if (pending.length > limit) { discarded += pending.length; pending = Buffer.alloc(0); }
  }
  // A torn last line is retried, never counted or committed as a complete event.
  row.scannedSize = end;
  return bytes;
}

class Analytics {
  constructor(config, options) {
    this.config = config;
    this.options = { retentionDays: 90, timeZone: "Asia/Shanghai", ...options };
    if (!Number.isSafeInteger(this.options.retentionDays) || this.options.retentionDays < 7 || this.options.retentionDays > 366) {
      throw new Error("analytics.retentionDays must be between 7 and 366");
    }
    dayKey(Date.now(), this.options.timeZone);
    for (const field of ["directory", "sessionDirectory"]) {
      if (!path.isAbsolute(this.options[field] || "")) throw new Error(`analytics.${field} must be absolute`);
    }
    fs.mkdirSync(this.options.directory, { recursive: true, mode: 0o700 });
    this.file = path.join(this.options.directory, "ledger.json");
    this.ledger = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : {
      version: 2, timeZone: this.options.timeZone, sessions: {}, jobs: {}, artifacts: {}, firstCollectedAt: null,
    };
    if (this.ledger.version !== 2 || !this.ledger.sessions || !this.ledger.jobs || !this.ledger.artifacts ||
      this.ledger.timeZone !== this.options.timeZone) throw new Error("Invalid analytics ledger or changed time zone");
    this.value = null;
  }

  collectJobs(jobs) {
    for (const job of jobs) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(job.repository || "") || !Number.isSafeInteger(job.number)) continue;
      const id = String(job.id), previous = this.ledger.jobs[id];
      this.ledger.jobs[id] = { ...previous, id, repository: job.repository, number: job.number, head: job.head, base: job.base,
        createdAt: job.createdAt, startedAt: job.startedAt, updatedAt: job.updatedAt || job.createdAt, state: job.state,
        attempt: Math.max(number(job.attempt), previous?.attempt || 0), directory: job.directory,
        workspace: job.workspace, incremental: job.range?.mode === "checkpoint",
        firstStartedAt: previous?.firstStartedAt || (job.attempt === 1 ? job.startedAt : null),
        findings: Number.isFinite(job.result?.findings) ? job.result.findings : null,
        blocking: Number.isFinite(job.result?.blocking) ? job.result.blocking : null,
        sessionId: job.progress?.sessionId || previous?.sessionId };
    }
  }

  collectArtifacts(cutoff) {
    const jobs = Object.values(this.ledger.jobs);
    for (const entry of entries(path.join(this.config.stateDirectory, "runs"))) {
      if (!entry.isDirectory() || !entry.name.startsWith("ocr-pr-")) continue;
      const directory = path.join(this.config.stateDirectory, "runs", entry.name);
      try {
        const file = path.join(directory, "metadata.json"), stat = fs.statSync(file);
        if (stat.mtimeMs < cutoff) continue;
        const previous = this.ledger.artifacts[directory];
        let reportStat;
        try { reportStat = fs.statSync(path.join(directory, "result.json")); } catch { /* Still preparing. */ }
        const signature = `${stat.mtimeMs}:${stat.size}:${reportStat?.mtimeMs}:${reportStat?.size}`;
        if (previous?.signature === signature && previous.jobId && this.ledger.jobs[previous.jobId]) continue;
        const meta = json(file), info = meta.telemetry;
        const matches = jobs.filter((j) => j.number === meta.number && j.head === meta.head && j.base === meta.base);
        const direct = jobs.find((j) => j.directory === directory);
        const repository = info?.repository || direct?.repository || (new Set(matches.map((j) => j.repository)).size === 1 ? matches[0].repository :
          this.config.repositories.length === 1 ? this.config.repositories[0].name : null);
        if (!repository || !Number.isSafeInteger(meta.number)) continue;
        const preparedAt = info?.preparedAt || new Date(stat.mtimeMs).toISOString();
        const candidates = matches.filter((j) => j.repository === repository && stamp(j.createdAt) <= stamp(preparedAt) + 1000)
          .sort((a, b) => stamp(b.createdAt) - stamp(a.createdAt));
        const job = direct || (info?.jobId ? this.ledger.jobs[info.jobId] : candidates[0]);
        const artifact = { signature, repository, number: meta.number, head: meta.head, from: meta.range?.from || meta.merge_base,
          preparedAt, jobId: job?.id || null, workspace: info?.workspace || job?.workspace,
          incremental: meta.range?.mode === "checkpoint" };
        if (reportStat?.size) {
          try {
            const report = json(path.join(directory, "result.json")), manifest = report.manifest;
            if (manifest?.input?.resolved_head === meta.head && manifest?.input?.resolved_base === artifact.from &&
              report.session_id === manifest.run_id) {
              artifact.sessionId = report.session_id;
              artifact.coverage = counts(manifest.coverage);
              artifact.reportComplete = report.status === "complete" && manifest.terminal_state === "complete";
              artifact.severities = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
              for (const comment of report.comments || []) {
                const severity = Object.hasOwn(artifact.severities, comment.severity) ? comment.severity : "unknown";
                artifact.severities[severity]++;
              }
              artifact.findings = Array.isArray(report.comments) ? report.comments.length : null;
            }
          } catch { /* In-progress stdout is not necessarily valid JSON yet. */ }
        }
        this.ledger.artifacts[directory] = artifact;
      } catch (error) { if (error.code !== "ENOENT") this.readErrors++; }
    }
  }

  async collectSessions(cutoff) {
    const workspaces = new Map();
    for (const name of new Set([...this.config.repositories.map((r) => r.name), ...Object.values(this.ledger.jobs).map((j) => j.repository)])) {
      const repository = { name };
      workspaces.set(path.join(this.config.stateDirectory, "repositories", ...repository.name.split("/")), repository.name);
      for (const entry of entries(path.join(this.config.stateDirectory, "worker-repositories"))) {
        if (entry.isDirectory() && /^\d+$/.test(entry.name)) workspaces.set(
          path.join(this.config.stateDirectory, "worker-repositories", entry.name, ...repository.name.split("/")), repository.name);
      }
    }
    const files = [];
    for (const [cwd, repository] of workspaces) {
      const directory = path.join(this.options.sessionDirectory, encoded(cwd));
      for (const entry of entries(directory)) {
        if (entry.isFile() && /^[\w-]+\.jsonl$/.test(entry.name)) files.push({ file: path.join(directory, entry.name), cwd, repository });
      }
    }
    this.pendingFiles = 0; let bytes = 0;
    for (const { file, cwd, repository } of files) {
      try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs < cutoff) continue;
        let row = this.ledger.sessions[file];
        const identity = `${stat.dev}:${stat.ino}`;
        if (!row || row.identity !== identity || stat.size < row.offset) {
          row = { identity, offset: 0, scannedSize: 0, cwd, repository, usage: emptyUsage(), days: {}, phases: {}, phaseDays: {}, unreadableRecords: 0 };
          this.ledger.sessions[file] = row;
        }
        row.modifiedAt = stat.mtimeMs;
        if (row.ignored || stat.size === row.scannedSize) continue;
        if (bytes >= 64 * 1024 * 1024) { this.pendingFiles++; continue; }
        bytes += await ingest(file, row, this.options.timeZone, stat.size);
      } catch (error) { if (error.code !== "ENOENT") this.readErrors++; }
    }
    return bytes;
  }

  associate() {
    const artifacts = Object.values(this.ledger.artifacts);
    for (const artifact of artifacts) {
      const job = this.ledger.jobs[artifact.jobId];
      if (job && artifact.sessionId && job.repository === artifact.repository && job.number === artifact.number &&
        job.head === artifact.head && (job.sessionId === artifact.sessionId ||
        !job.sessionId && job.directory && this.ledger.artifacts[job.directory] === artifact)) {
        job.report = { sessionId: artifact.sessionId, findings: artifact.findings, severities: artifact.severities,
          complete: artifact.reportComplete, coverage: artifact.coverage };
      }
    }
    for (const row of Object.values(this.ledger.sessions)) {
      if (!row.id || row.ignored) continue;
      const exact = artifacts.find((a) => a.sessionId === row.id && a.repository === row.repository);
      const candidates = artifacts.filter((a) => a.repository === row.repository && a.head === row.head && a.from === row.from &&
        (!a.workspace || a.workspace === row.cwd) && stamp(a.preparedAt) <= stamp(row.startedAt) + 1000 &&
        stamp(row.startedAt) - stamp(a.preparedAt) < 3600000).sort((a, b) => stamp(b.preparedAt) - stamp(a.preparedAt));
      const match = exact || candidates[0];
      if (match) { row.jobId = match.jobId; row.number = match.number; row.attribution = exact ? "report" : "time_range"; }
    }
  }

  async collect(jobs, now = Date.now()) {
    this.readErrors = 0;
    const firstDay = shiftDay(dayKey(now, this.options.timeZone), 1 - this.options.retentionDays);
    // Keep a UTC-day margin for source discovery; calendar buckets decide retention.
    const cutoff = Date.parse(firstDay + "T00:00:00Z") - 86400000;
    this.collectJobs(jobs); this.collectArtifacts(cutoff);
    await this.collectSessions(cutoff); this.associate();
    for (const [key, row] of Object.entries(this.ledger.jobs)) {
      if (terminal.has(row.state) && dayKey(row.updatedAt, this.options.timeZone) < firstDay) delete this.ledger.jobs[key];
    }
    for (const [key, row] of Object.entries(this.ledger.sessions)) {
      if (Math.max(stamp(row.lastEventAt), row.modifiedAt || 0) < cutoff) delete this.ledger.sessions[key];
      else {
        for (const day of Object.keys(row.days)) if (day < firstDay) { delete row.days[day]; delete row.phaseDays[day]; }
        row.expired = Boolean(row.lastEventAt && dayKey(row.lastEventAt, this.options.timeZone) < firstDay);
        row.usage = Object.values(row.days).reduce((sum, u) => addUsage(sum, u), emptyUsage());
        row.phases = {};
        for (const day of Object.values(row.phaseDays)) for (const [phase, usage] of Object.entries(day)) {
          addUsage(row.phases[phase] ||= emptyUsage(), usage);
        }
      }
    }
    for (const [key, row] of Object.entries(this.ledger.artifacts)) if (stamp(row.preparedAt) < cutoff) delete this.ledger.artifacts[key];
    this.ledger.firstCollectedAt ||= new Date(now).toISOString();
    this.ledger.collectedAt = new Date(now).toISOString();
    atomicJSON(this.file, this.ledger);
    this.value = summarize(this.ledger, this.options, now, { pendingFiles: this.pendingFiles, readErrors: this.readErrors });
    return this.value;
  }
}

module.exports = { Analytics, ingest, record, encoded };
