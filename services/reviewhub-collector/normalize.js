// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  { createHash } = require("node:crypto");
const { auditRows } = require("../github-review/monitor-audit.js");
const { runRows } = require("../github-review/analytics-summary.js");
const { jobOutcome } = require("../github-review/outcome.js");
const digest = (value) =>
  createHash("sha256").update(String(value)).digest("hex");
const iso = (value) => {
  const n = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
};
const integer = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;
const knownTokens = (value, complete) =>
  value === 0 && !complete ? null : integer(value);
const text = (value, limit = 1000) =>
  typeof value === "string" ? value.slice(0, limit) : null;
const safeURL = (value) => {
  try {
    const u = new URL(value);
    return ["https:", "http:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
};
const runId = (job) =>
  "run:" + digest([job.id, iso(job.createdAt), job.head || ""].join(":"));
const repoName = (name) =>
  typeof name === "string" && /^[\w.-]+\/[\w.-]+$/.test(name)
    ? name.toLowerCase()
    : null;
function repositories(config, previous, metadata, organizations) {
  const allowed = (name) =>
    name && organizations.includes(name.split("/")[0]);
  const result = new Map();
  for (const configured of config.repositories) {
    const name = repoName(configured.name),
      githubName = repoName(configured.githubName);
    if (!allowed(name) || (githubName && !allowed(githubName))) continue;
    const candidate = metadata[name] || metadata[githubName];
    const remote = configured.repositoryId && candidate?.providerId && candidate.providerId !== configured.repositoryId
      ? undefined : candidate;
    const providerId = configured.repositoryId || remote?.providerId;
    const currentName = repoName(remote?.name) || githubName || name;
    if (!allowed(currentName)) continue;
    const candidates = [...result.values(), ...previous],
      names = [name, githubName, currentName].filter(Boolean);
    const existing =
      candidates.find(
        (r) => providerId && r.providerId === providerId
      ) ||
      candidates.find(
        (r) =>
          (!providerId || !r.providerId) &&
          names.some((n) => r.name === n || r.aliases.includes(n))
      );
    const id =
      existing?.id ||
      (providerId
        ? "github:" + providerId
        : "repository:" + digest(name));
    result.set(id, {
      id,
      provider: "github",
      providerId: providerId || existing?.providerId || null,
      name: currentName,
      organization: currentName.split("/")[0],
      aliases: [
        ...new Set(
          [
            ...(existing?.aliases || []),
            existing?.name,
            name,
            githubName,
            currentName
          ]
            .map(repoName)
            .filter(allowed)
        )
      ],
      defaultBranch:
        configured.defaultBranch || remote?.defaultBranch || existing?.defaultBranch || null,
      targetBranches:
        configured?.baseBranches?.filter((v) => typeof v === "string") ||
        existing?.targetBranches ||
        [],
      archived:
        typeof remote?.archived === "boolean"
          ? remote.archived
          : (existing?.archived ?? null),
      access: remote?.access || "unknown",
      enabled:
        typeof configured?.enabled === "boolean"
          ? configured.enabled
          : null,
      sourceUpdatedAt:
        iso(remote?.updatedAt) || existing?.sourceUpdatedAt || null
    });
  }
  return [...result.values()];
}
function normalize({
  config,
  state,
  ledger,
  agent,
  metadata = {},
  previousRepositories = [],
  sourceId,
  intervalSeconds,
  now = Date.now(),
  resources = null,
  warnings = [],
  historicalAudits = []
}) {
  const collectedAt = new Date(now).toISOString();
  const repos = repositories(
    config,
    previousRepositories,
    metadata,
    config.organizations
  );
  const findRepo = (name) => {
    name = repoName(name);
    return repos.find((r) => r.name === name || r.aliases.includes(name));
  };
  const rawJobs = new Map(state.jobs.map((j) => [String(j.id), j]));
  // A session may be discovered under more than one filename after rotation.
  const uniqueSessions = new Map();
  for (const session of Object.values(ledger.sessions)) {
    if (!session.id || session.ignored || session.expired) continue;
    const previous = uniqueSessions.get(session.id);
    if (!previous || (session.offset || 0) > (previous.offset || 0))
      uniqueSessions.set(session.id, session);
  }
  const summaries = new Map(
    runRows({
      ...ledger,
      sessions: Object.fromEntries(
        [...uniqueSessions].filter(([, s]) => s.attribution === "report")
      )
    }).map((r) => [String(r.id), r])
  );
  const runs = [],
    events = [],
    findings = [],
    usage = [];
  const runIds = new Map();
  for (const job of Object.values(ledger.jobs)) {
    const repo = findRepo(job.repository),
      createdAt = iso(job.createdAt),
      updatedAt = iso(job.updatedAt) || createdAt;
    if (
      !repo ||
      !createdAt ||
      !Number.isSafeInteger(job.number) ||
      job.number < 1
    )
      continue;
    const raw = rawJobs.get(String(job.id)),
      summary = summaries.get(String(job.id)),
      outcome = raw ? jobOutcome(raw) : null;
    const id = runId(job);
    runIds.set(String(job.id), id);
    const states = {
      complete: "completed",
      failed: "failed",
      queued: "queued",
      running: "running",
      cancelled: "cancelled",
      superseded: "superseded",
      checkpointed: "superseded"
    };
    let stateName = states[job.state] || "unknown";
    if (outcome?.kind === "execution_failed") stateName = "failed";
    if (outcome?.kind === "publication_failed")
      stateName = job.report?.complete ? "completed" : "unknown";
    const published = Boolean(raw?.result?.summaryURL || raw?.published?.at);
    const verdict =
      outcome?.kind === "blocked"
        ? "blocked"
        : outcome?.kind === "complete"
          ? "passed"
          : "unknown";
    const publication =
      raw?.failurePhase === "publication"
        ? "failed"
        : published
          ? "published"
          : "unknown";
    const current = Boolean(raw);
    const row = {
      id,
      repositoryId: repo.id,
      sourceJobId: String(job.id),
      prNumber: job.number,
      title: text(raw?.title || job.title),
      url:
        safeURL(raw?.url) ||
        `https://github.com/${repo.name}/pull/${job.number}`,
      author: text(raw?.author, 100),
      headSha: text(job.head, 64),
      baseSha: text(raw?.base || job.base, 64),
      baseRef: text(raw?.baseRef, 240),
      state: stateName,
      verdict,
      publication,
      attempt: integer(job.attempt),
      createdAt,
      updatedAt,
      startedAt: iso(job.startedAt),
      finishedAt: ["completed", "failed", "cancelled", "superseded"].includes(
        stateName
      )
        ? updatedAt
        : null,
      executionMs: Number.isFinite(summary?.nativeSeconds)
        ? Math.max(0, summary.nativeSeconds * 1000)
        : null,
      queueMs: Number.isFinite(summary?.queueWaitSeconds)
        ? Math.max(0, summary.queueWaitSeconds * 1000)
        : null,
      findings: integer(summary?.findings),
      blocking: integer(job.blocking),
      current,
      resultUrl: safeURL(raw?.result?.summaryURL),
      nativeTokens: summary?.sessions
        ? knownTokens(
            summary.usage.totalTokens,
            !summary.partialUsage && summary.usage.responses > 0
          )
        : null,
      nativeUsage: !summary?.sessions
        ? "unknown"
        : summary.partialUsage || !summary.usage.responses
          ? "partial"
          : "complete"
    };
    const saved = job.reviewhub;
    if (!raw && saved)
      for (const key of [
        "title",
        "author",
        "baseRef",
        "verdict",
        "publication",
        "resultUrl"
      ])
        row[key] = saved[key] ?? row[key];
    job.reviewhub = Object.fromEntries(
      ["title", "author", "baseRef", "verdict", "publication", "resultUrl"].map(
        (k) => [k, row[k]]
      )
    );
    runs.push(row);
    const artifact = Object.values(ledger.artifacts).find(
      (a) =>
        String(a.jobId) === String(job.id) &&
        a.reportComplete &&
        a.sessionId === job.report?.sessionId
    );
    if (artifact && job.directory) {
      try {
        const root = fs.realpathSync(path.join(config.stateDirectory, "runs")),
          file = fs.realpathSync(path.join(job.directory, "result.json"));
        if (
          !file.startsWith(root + path.sep) ||
          fs.statSync(file).size > 16 * 1024 * 1024
        )
          throw Error("Invalid result path");
        const report = JSON.parse(fs.readFileSync(file, "utf8"));
        if (
          report.session_id !== artifact.sessionId ||
          report.status !== "complete" ||
          !Array.isArray(report.comments)
        )
          continue;
        for (const [i, comment] of report.comments.entries()) {
          if (!comment || typeof comment !== "object") continue;
          findings.push({
            id: "finding:" + digest(id + ":" + artifact.sessionId + ":" + i),
            repositoryId: repo.id,
            runId: id,
            prNumber: job.number,
            severity: ["critical", "high", "medium", "low"].includes(
              comment.severity
            )
              ? comment.severity
              : "unknown",
            title:
              text(comment.title) ||
              text(comment.body || comment.content, 120) ||
              "Review finding",
            description:
              text(
                comment.body || comment.content || comment.description,
                20000
              ) || "",
            file: text(comment.file || comment.path, 2000),
            line:
              Number.isSafeInteger(comment.line) && comment.line > 0
                ? comment.line
                : null,
            at: updatedAt
          });
        }
      } catch {
        warnings.push("RESULT_DETAILS_UNAVAILABLE");
      }
    }
  }
  const stages = {
    accepted: "admission",
    verification_requested: "dispatch",
    verified: "dispatch",
    agent_ack: "dispatch",
    fallback: "dispatch",
    queued: "queue",
    started: "execution",
    finished: "execution",
    published: "publication"
  };
  const audits = new Map(
    [...historicalAudits, ...auditRows(state)].map((row) => [
      row.ingress + ":" + row.id,
      row
    ])
  );
  for (const audit of audits.values()) {
    const repo = findRepo(audit.repository);
    if (!repo || !Number.isSafeInteger(audit.number) || audit.number < 1)
      continue;
    for (const stage of audit.stages || []) {
      if (
        !stages[stage.stage] ||
        (audit.ingress === "historical" && stage.stage === "accepted")
      )
        continue;
      events.push({
        id:
          "event:" +
          digest([audit.ingress, audit.id, stage.stage, stage.at].join(":")),
        repositoryId: repo.id,
        runId: runIds.get(audit.jobId) || null,
        prNumber: audit.number,
        headSha: text(audit.head, 64),
        stage: stages[stage.stage],
        state: stage.stage,
        at: stage.at,
        message: null
      });
    }
  }
  for (const session of uniqueSessions.values()) {
    if (!session.id || session.ignored || session.expired) continue;
    const repo = findRepo(session.repository);
    if (!repo) continue;
    const exact = session.attribution === "report";
    if (exact && !session.reviewhubRunId)
      session.reviewhubRunId = runIds.get(String(session.jobId)) || null;
    for (const [day, dayUsage] of Object.entries(session.days || {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const complete = Boolean(
        session.endedAt &&
        !session.unreadableRecords &&
        !session.usage?.errors &&
        dayUsage.responses > 0
      );
      usage.push({
        id: "native:" + digest(session.id + ":" + day),
        repositoryId: repo.id,
        runId: exact ? session.reviewhubRunId || null : null,
        prNumber:
          exact && Number.isSafeInteger(session.number) ? session.number : null,
        engine: "native",
        timeBasis: "usage_day",
        at: new Date(day + "T00:00:00+08:00").toISOString(),
        inputTokens: knownTokens(dayUsage.inputTokens, complete),
        outputTokens: knownTokens(dayUsage.outputTokens, complete),
        totalTokens: knownTokens(dayUsage.totalTokens, complete),
        // The legacy parser does not distinguish absent cache counters from zero.
        cacheReadTokens: knownTokens(dayUsage.cacheReadTokens, false),
        cacheWriteTokens: knownTokens(dayUsage.cacheWriteTokens, false),
        completeness:
          complete &&
          dayUsage.cacheReadTokens > 0 &&
          dayUsage.cacheWriteTokens > 0
            ? "complete"
            : "partial"
      });
    }
  }
  // Agent counters are PR-scoped cumulative values, never split across review rounds.
  for (const row of Object.values(agent?.sessions || {})) {
    const repo = findRepo(row.repository);
    if (!repo || !Number.isSafeInteger(row.number) || row.number < 1) continue;
    usage.push({
      id: "agent:" + digest(row.id),
      repositoryId: repo.id,
      runId: null,
      prNumber: row.number,
      engine: "agent",
      timeBasis: "observed_total",
      at: iso(row.observedAt) || collectedAt,
      inputTokens: integer(row.inputTokens),
      outputTokens: integer(row.outputTokens),
      totalTokens: integer(row.totalTokens),
      cacheReadTokens: null,
      cacheWriteTokens: null,
      completeness: "partial"
    });
  }
  if (runs.some((r) => r.startedAt && r.nativeUsage === "unknown"))
    warnings.push("NATIVE_USAGE_MISSING");
  const resourceRows = resources
    ? [
        {
          id: collectedAt,
          at: collectedAt,
          cpuPercent: Number.isFinite(resources.cpu?.busy)
            ? Math.max(0, Math.min(100, resources.cpu.busy))
            : null,
          memoryUsedBytes: integer(
            resources.memoryTotalBytes - resources.memoryAvailableBytes
          ),
          memoryTotalBytes: integer(resources.memoryTotalBytes),
          running: state.jobs.filter((j) => j.state === "running").length,
          queued: state.jobs.filter((j) => j.state === "queued").length
        }
      ]
    : [];
  const times = state.jobs
    .map((j) => iso(j.updatedAt || j.createdAt))
    .filter(Boolean)
    .sort();
  return {
    version: 1,
    sourceId,
    collectedAt,
    sourceUpdatedAt: times.at(-1) || null,
    intervalSeconds,
    warnings: [...new Set(warnings)].slice(0, 100),
    repositories: repos,
    runs,
    events,
    findings,
    usage,
    resources: resourceRows
  };
}
module.exports = { normalize, repositories, runId, digest, iso };
