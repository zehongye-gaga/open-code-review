// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const date = (value) => { const n = typeof value === "number" ? value : Date.parse(value); return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null; };
const repo = (v) => String(v || "").toLowerCase();
const values = (v) => Array.isArray(v) ? v : Object.values(v || {});
function auditRows(state) {
  const jobs = new Map(values(state.jobs).map((j) => [String(j.id), j]));
  const covered = new Set();
  const row = (event, ingress, job) => {
    if (job) covered.add(String(job.id));
    const creator = job?.requestedBy;
    const actual = creator === "insightflow-agent" ? "agent" : creator?.includes("fallback") ? "direct_fallback" :
      event.dispatchMethod === "reused_existing" ? "unknown" : event.dispatchMethod || (job && (event.route === "direct" || !creator) ? "direct" : "unknown");
    const stages = [["accepted", event.createdAt || job?.createdAt], ["agent_ack", event.agentAcknowledgedAt],
      ["fallback", event.fallbackAt], ["queued", job?.createdAt], ["started", job?.startedAt],
      ["finished", ["complete", "failed", "checkpointed", "superseded"].includes(job?.state) ? job.updatedAt : null],
      ["published", event.published?.at]].map(([stage, at]) => ({ stage, at: date(at) })).filter((s) => s.at).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    return { id: String(event.id || event.request_id || job?.id), ingress, repository: repo(event.repository || job?.repository),
      number: event.number || event.pull_number || job?.number, head: event.head || event.head_sha || job?.head,
      jobId: job ? String(job.id) : null, requestedRoute: event.route || "unknown", actualRoute: actual,
      reused: event.dispatchMethod === "reused_existing", state: job?.state || event.state,
      dispatchState: event.state, attempts: event.attempts || event.dispatchAttempts || 0,
      profile: job?.settings?.profile || null, budget: job?.settings?.options?.budget ?? null,
      findings: job?.result?.findings ?? null, blocking: job?.result?.blocking ?? null,
      fallbackReason: ["agent_ack_timeout", "agent_unacknowledged", "agent_error", "agent_timeout"].includes(event.fallbackReason) ? event.fallbackReason : event.fallbackAt ? "fallback" : null,
      updatedAt: date(job?.updatedAt || event.finishedAt || event.updatedAt || event.createdAt || job?.createdAt), stages };
  };
  const rows = [...values(state.deliveries).map((e) => row(e, "webhook", jobs.get(String(e.jobId)))),
    ...values(state.ciReceipts).map((e) => row(e, "organization_ci", jobs.get(String(e.jobId))))];
  for (const job of jobs.values()) if (!covered.has(String(job.id))) rows.push(row({}, "historical", job));
  return rows.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
}
function repositoryUsage(pulls) {
  const repos = new Map();
  for (const p of pulls) {
    const key = repo(p.repository);
    if (!repos.has(key)) repos.set(key, { repository: key, pullRequests: 0, reviews: 0, usageMissingJobs: 0, failed: 0, sessions: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
    const r = repos.get(key); r.pullRequests++;
    for (const k of ["reviews", "failed", "sessions", "usageMissingJobs"]) r[k] += p[k] || 0;
    for (const k of ["totalTokens", "inputTokens", "outputTokens", "cacheReadTokens"]) r[k] += p.usage?.[k] || 0;
  }
  return [...repos.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}
function cpuSample(text, previous) {
  const parts = /^cpu\s+(.+)$/m.exec(text || "")?.[1].trim().split(/\s+/).map(Number);
  if (!parts || parts.length < 8 || parts.some((v) => !Number.isFinite(v))) return { counter: null, usage: null };
  const counter = { total: parts.slice(0, 8).reduce((a, b) => a + b, 0), idle: parts[3] + parts[4], system: parts[2] + parts[5] + parts[6], iowait: parts[4] };
  const delta = previous ? counter.total - previous.total : 0;
  const usage = delta > 0 ? { busy: Math.max(0, Math.min(100, 100 * (1 - (counter.idle - previous.idle) / delta))),
    system: 100 * (counter.system - previous.system) / delta, iowait: 100 * (counter.iowait - previous.iowait) / delta } : null;
  return { counter, usage };
}
module.exports = { auditRows, repositoryUsage, cpuSample };
