// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const fs = require("node:fs").promises, path = require("node:path"), crypto = require("node:crypto");
const fields = ["input_tokens", "output_tokens", "total_tokens", "cache_read_tokens", "cache_write_tokens"];
const number = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
async function read(file) {
  if ((await fs.stat(file)).size > 64 * 1024 * 1024) throw new Error("Report exceeds read limit");
  return JSON.parse(await fs.readFile(file, "utf8"));
}
async function contained(directory, name) {
  const file = await fs.realpath(path.join(directory, name));
  if (!file.startsWith(directory + path.sep)) throw new Error("Outside run storage");
  return file;
}
function sum(rows, field) {
  const values = rows.map(r => r[field]).filter(v => v !== null && v !== undefined);
  const total = values.reduce((a, b) => a + b, 0);
  return values.length && Number.isSafeInteger(total) ? total : null;
}
function totals(reports) {
  return { ...Object.fromEntries(fields.map(k => [k, sum(reports.map(r => r.tokens), k)])),
    execution_ms: sum(reports, "execution_ms"), report_count: reports.length,
    missing_token_reports: reports.filter(r => fields.slice(0, 3).some(k => r.tokens[k] === null)).length };
}
async function prUsage(service, repository, pullNumber, offset = 0, limit = 20, now = Date.now()) {
  const jobs = service.state.data.jobs.filter(j => j.repository.toLowerCase() === repository && j.number === pullNumber);
  const byId = new Map(jobs.map(j => [String(j.id), j]));
  const directories = new Map();
  for (const j of jobs) {
    for (const directory of [j.directory, j.progress?.directory, ...(j.budgetRetries || []).map(r => r.directory),
      ...(j.resumeFallbacks || []).flatMap(r => [r.previousDirectory, ...Object.values(r.usageBySession || {}).map(u => u.directory)])]) {
      if (directory) directories.set(path.resolve(directory), j);
    }
  }
  let root, scanAvailable = true;
  try {
    root = await fs.realpath(path.join(service.config.stateDirectory, "runs"));
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      try {
        const m = await read(await contained(dir, "metadata.json")), j = byId.get(String(m.telemetry?.jobId));
        if (j && m.head === j.head && m.base === j.base && m.number === j.number) directories.set(dir, j);
      } catch { /* Unattributed artifacts cannot be charged to this PR. */ }
    }
  } catch { scanAvailable = false; }
  const reports = new Map(), missing = new Set();
  for (const [directory, job] of directories) {
    for (const filename of ["result.json", "documentation-skipped-result.json", "resume-rejected-result.json"]) {
      try {
        const real = await fs.realpath(directory);
        if (!root || !real.startsWith(root + path.sep)) throw new Error("Outside report storage");
        const file = await contained(real, filename);
        if (reports.has(file)) continue;
        const m = await read(await contained(real, "metadata.json")), r = await read(file);
        if (m.head !== job.head || m.base !== job.base || m.number !== job.number ||
          (m.telemetry?.jobId != null && String(m.telemetry.jobId) !== String(job.id)) ||
          (m.telemetry?.repository && m.telemetry.repository.toLowerCase() !== repository)) throw new Error("Snapshot mismatch");
        const summary = r.summary || {};
        reports.set(file, { report_id: crypto.createHash("sha256").update(file).digest("hex"), job_id: job.id,
          session_id: typeof r.session_id === "string" ? r.session_id : null,
          status: r.status || null, prepared_at: typeof m.telemetry?.preparedAt === "string" ? m.telemetry.preparedAt : null,
          tokens: Object.fromEntries(fields.map(k => [k, number(summary[k])])),
          execution_ms: number(r.manifest?.elapsed_ms), files_reviewed: number(summary.files_reviewed),
          resumed: r.resume != null, budget_exhausted: summary.budget_exceeded === true });
      } catch (error) { if (filename === "result.json" || error.code !== "ENOENT") missing.add(job.id); }
    }
  }
  const allReports = [...reports.values()];
  const rows = jobs.map(j => {
    const attempts = allReports.filter(r => r.job_id === j.id);
    const active = ["queued", "running"].includes(j.state);
    const start = Date.parse(j.createdAt), end = active ? now : Date.parse(j.updatedAt);
    return { job_id: j.id, head_sha: j.head, base_sha: j.base, base_ref: j.baseRef, state: j.state,
      profile: j.settings?.profile || null, model: j.settings?.options?.model || null,
      requested_budget: j.settings?.options?.budget ?? null, effective_budget: j.retryBudget ?? j.settings?.options?.budget ?? null,
      created_at: j.createdAt || null, latest_started_at: j.startedAt || null, updated_at: j.updatedAt || null,
      wall_ms: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null,
      findings: j.result?.findings ?? null, blocking_findings: j.result?.blocking ?? null,
      review_complete: j.progress?.complete === true, summary_url: j.result?.summaryURL || null,
      retry_count: (j.retryHistory || []).length, budget_upgrade_count: (j.budgetRetries || []).length,
      fresh_recovery_count: (j.resumeFallbacks || []).length,
      usage_pending_or_missing: active || missing.has(j.id) || !attempts.length,
      usage: totals(attempts), reports: attempts };
  });
  let agent = { available: false, tokens: null, reason: "agent_usage_cache_not_configured" };
  if (service.config.prUsage?.agentUsageFile) {
    try {
      const cache = await read(service.config.prUsage.agentUsageFile);
      const sessions = Object.values(cache.sessions || {}).filter(r => r.repository === repository && r.number === pullNumber);
      agent = { available: sessions.length > 0, source: "goclaw_session_tree_counters", observed_at: cache.collectedAt || null,
        stale: cache.error === true || !cache.collectedAt || now - Date.parse(cache.collectedAt) > 180000,
        tokens: sessions.length ? { input_tokens: sum(sessions.map(r => ({ value: number(r.inputTokens) })), "value"),
          output_tokens: sum(sessions.map(r => ({ value: number(r.outputTokens) })), "value"),
          total_tokens: sum(sessions.map(r => ({ value: number(r.totalTokens) })), "value") } : null,
        reason: sessions.length ? null : "no_recorded_agent_usage", session_count: sessions.length };
    } catch { agent.reason = "agent_usage_cache_unavailable"; }
  }
  rows.sort((a, b) => b.job_id - a.job_id);
  return { schema: "ocr.pr-usage/v1", repository, pull_number: pullNumber, observed_at: new Date(now).toISOString(),
    retention_days: service.config.retentionDays, source: "retained_native_invocation_reports",
    notes: ["Each invocation report counts once; resume invocations share a session but have separate token counters.",
      "Cache tokens are included in input tokens; do not add them to total tokens.",
      "Execution time sums native invocation elapsed_ms; wall time includes waiting and stopped time.",
      "Totals cover retained readable reports only, not guaranteed lifetime billing. Running calls may not have a report yet.",
      "Agent routing usage is PR-level and may be stale; it is not included in native totals."],
    native: { ...totals(allReports), jobs_with_pending_or_missing_usage: rows.filter(r => r.usage_pending_or_missing).length,
      report_scan_available: scanAvailable }, agent, job_count: rows.length, jobs: rows.slice(offset, offset + limit),
    offset, limit, next_offset: offset + limit < rows.length ? offset + limit : null };
}
module.exports = { prUsage };
