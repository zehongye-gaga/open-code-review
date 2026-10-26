// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const formatters = new Map();
const stamp = (value) => Date.parse(value) || 0;
const endStates = new Set(["complete", "checkpointed", "failed", "superseded"]);
const successStates = new Set(["complete", "checkpointed"]);
const seconds = (start, end) => stamp(start) && stamp(end) ? Math.max(0, (stamp(end) - stamp(start)) / 1000) : null;

function dayKey(value, timeZone) {
  if (!formatters.has(timeZone)) formatters.set(timeZone, new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }));
  if (!Number.isFinite(new Date(value).getTime())) return null;
  const parts = Object.fromEntries(formatters.get(timeZone).formatToParts(new Date(value)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function shiftDay(day, offset) { return new Date(Date.parse(day + "T12:00:00Z") + offset * 86400000).toISOString().slice(0, 10); }
function weekKey(day) { return shiftDay(day, -((new Date(day + "T12:00:00Z").getUTCDay() + 6) % 7)); }
function emptyUsage() {
  return { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    requests: 0, responses: 0, errors: 0, llmSeconds: 0, toolCalls: 0, toolErrors: 0 };
}
function addUsage(target, source) { for (const key of Object.keys(emptyUsage())) target[key] += source[key] || 0; return target; }
function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return { samples: sorted.length, mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    p95: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1] : null };
}

function bucket(key) {
  return { key, usage: emptyUsage(), jobs: 0, completed: 0, failed: 0, superseded: 0, findings: 0, findingReports: 0,
    clean: 0, withFindings: 0, retriedJobs: 0, retries: 0, sessions: 0, resumed: 0, failedSessions: 0, nativeSeconds: 0,
    severities: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
    coverage: { selected: 0, completed: 0, reused: 0, failed: 0, waived: 0, reports: 0 },
    prs: new Set(), elapsed: [], waits: [] };
}

function jobInto(target, job) {
  target.jobs++; target.prs.add(`${job.repository}#${job.number}`);
  if (successStates.has(job.state)) target.completed++;
  else if (job.state === "failed") target.failed++;
  else target.superseded++;
  target.retries += Math.max(0, job.attempt - 1);
  if (job.attempt > 1) target.retriedJobs++;
  if (job.startedAt) target.elapsed.push(seconds(job.createdAt, job.updatedAt));
  target.waits.push(seconds(job.createdAt, job.firstStartedAt));
  if (successStates.has(job.state) && Number.isFinite(job.findings)) {
    target.findingReports++; target.findings += job.findings;
    if (job.findings) target.withFindings++; else target.clean++;
    for (const [key, count] of Object.entries(job.severities || {})) target.severities[key] += count;
  }
  if (job.coverage) {
    target.coverage.reports++;
    for (const key of ["selected", "completed", "reused", "failed", "waived"]) target.coverage[key] += job.coverage[key] || 0;
  }
}

function finish(target) {
  const { prs, elapsed, waits, ...value } = target;
  return { ...value, pullRequests: prs.size, endToEnd: distribution(elapsed), queueWait: distribution(waits),
    completionRate: value.completed + value.failed ? value.completed / (value.completed + value.failed) : null,
    cacheHitRatio: value.usage.inputTokens ? value.usage.cacheReadTokens / value.usage.inputTokens : null };
}

function runRows(ledger) {
  const sessions = Object.values(ledger.sessions).filter((s) => s.id && !s.ignored && !s.expired);
  const byJob = new Map();
  for (const session of sessions) {
    if (!byJob.has(session.jobId)) byJob.set(session.jobId, []);
    byJob.get(session.jobId).push(session);
  }
  return Object.values(ledger.jobs).map((job) => {
    const runs = byJob.get(job.id) || [], report = job.report;
    const usage = runs.reduce((sum, row) => addUsage(sum, row.usage), emptyUsage());
    const ended = runs.filter((r) => r.endedAt);
    return { id: job.id, repository: job.repository, number: job.number, head: job.head, state: job.state,
      createdAt: job.createdAt, startedAt: job.startedAt || null, firstStartedAt: job.firstStartedAt,
      updatedAt: job.updatedAt, attempt: job.attempt, incremental: job.incremental,
      findings: report?.complete ? report.findings : job.findings, blocking: job.blocking,
      severities: report?.complete ? report.severities : null, coverage: report?.coverage || null,
      usage, sessions: runs.length, resumed: runs.filter((r) => r.resumed).length,
      nativeSeconds: ended.length ? ended.reduce((sum, row) => sum + row.nativeSeconds, 0) : null,
      endToEndSeconds: endStates.has(job.state) ? seconds(job.createdAt, job.updatedAt) : null,
      queueWaitSeconds: seconds(job.createdAt, job.firstStartedAt),
      partialUsage: !runs.length || runs.some((r) => !r.endedAt || r.unreadableRecords > 0 || r.usage.errors > 0) };
  });
}

function summarize(ledger, options, now, health = {}) {
  const today = dayKey(now, options.timeZone), firstDay = shiftDay(today, 1 - options.retentionDays), runs = runRows(ledger);
  const sessions = Object.values(ledger.sessions).filter((s) => s.id && !s.ignored && !s.expired);
  const daily = new Map(), weekly = new Map();
  for (let day = firstDay; day <= today; day = shiftDay(day, 1)) {
    daily.set(day, bucket(day)); weekly.set(weekKey(day), bucket(weekKey(day)));
  }
  const periods = { today: { start: today, end: today }, week: { start: weekKey(today), end: today },
    month: { start: shiftDay(today, -29), end: today }, retained: { start: firstDay, end: today } };
  const totals = Object.fromEntries(Object.keys(periods).map((key) => [key, bucket(key)]));
  const targets = (day) => day && day >= firstDay && day <= today ? [daily.get(day), weekly.get(weekKey(day)),
    ...Object.entries(periods).filter(([, range]) => day >= range.start && day <= range.end).map(([key]) => totals[key])] : [];
  for (const job of runs) if (endStates.has(job.state)) {
    for (const target of targets(dayKey(job.updatedAt, options.timeZone))) jobInto(target, job);
  }
  const phases = {}, pulls = new Map();
  const pull = (repository, number) => {
    const key = `${repository}#${number}`;
    if (!pulls.has(key)) pulls.set(key, { repository, number, usage: emptyUsage(), sessions: 0, resumed: 0,
      runs: [], nativeSeconds: 0 });
    return pulls.get(key);
  };
  for (const row of sessions) {
    for (const [day, usage] of Object.entries(row.days)) for (const target of targets(day)) addUsage(target.usage, usage);
    for (const target of targets(dayKey(row.startedAt, options.timeZone))) { target.sessions++; if (row.resumed) target.resumed++; }
    if (row.endedAt) for (const target of targets(dayKey(row.endedAt, options.timeZone))) {
      target.nativeSeconds += row.nativeSeconds;
      if (["failed", "partial"].includes(row.outcome)) target.failedSessions++;
    }
    for (const [phase, usage] of Object.entries(row.phases)) addUsage(phases[phase] ||= emptyUsage(), usage);
    if (row.number) {
      const p = pull(row.repository, row.number); addUsage(p.usage, row.usage); p.sessions++;
      if (row.resumed) p.resumed++;
      p.nativeSeconds += row.nativeSeconds || 0;
    }
  }
  for (const job of runs) pull(job.repository, job.number).runs.push(job);
  const pullRows = [...pulls.values()].map((p) => {
    p.runs.sort((a, b) => stamp(b.createdAt) - stamp(a.createdAt) || Number(b.id) - Number(a.id));
    const stats = bucket(""); for (const job of p.runs) if (endStates.has(job.state)) jobInto(stats, job);
    const latest = p.runs[0];
    return { repository: p.repository, number: p.number, usage: p.usage, sessions: p.sessions, resumed: p.resumed,
      nativeSeconds: p.nativeSeconds, reviews: p.runs.length, usageMissingJobs: p.runs.filter((r) => !r.sessions).length, completed: stats.completed, failed: stats.failed,
      findings: stats.findings, findingReports: stats.findingReports, retries: p.runs.reduce((n, r) => n + Math.max(0, r.attempt - 1), 0),
      endToEnd: distribution(stats.elapsed), queueWait: distribution(stats.waits),
      latest: latest ? { head: latest.head, state: latest.state, findings: latest.findings, updatedAt: latest.updatedAt,
        incremental: latest.incremental, createdAt: latest.createdAt } : null };
  }).sort((a, b) => stamp(b.latest?.updatedAt) - stamp(a.latest?.updatedAt));
  const dates = [...sessions.flatMap((s) => Object.keys(s.days)),
    ...runs.map((r) => dayKey(r.updatedAt, options.timeZone)).filter((day) => day && day >= firstDay)].sort();
  return { enabled: true, collectedAt: ledger.collectedAt, firstCollectedAt: ledger.firstCollectedAt, timeZone: options.timeZone,
    retentionDays: options.retentionDays, observedSince: dates[0] || null, ...health,
    unreadableRecords: sessions.reduce((n, s) => n + s.unreadableRecords, 0),
    unattributedSessions: sessions.filter((s) => !s.number).length,
    unmatchedJobs: runs.filter((r) => r.startedAt && !r.sessions).length,
    incompleteSessions: sessions.filter((s) => !s.endedAt).length,
    interruptedSessions: sessions.filter((s) => !s.endedAt && ledger.jobs[s.jobId]?.state !== "running").length,
    periods: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, { ...finish(value), ...periods[key] }])),
    daily: [...daily.values()].map(finish), weekly: [...weekly.values()].map(finish), phases, pulls: pullRows };
}

module.exports = { summarize, runRows, dayKey, weekKey, shiftDay, emptyUsage, addUsage };
