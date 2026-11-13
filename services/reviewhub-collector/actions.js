// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const { actionsHTTP } = require("./actions-http.js");
const { parseClientLog } = require("./client-log.js");
const DAY = 86400000;
const iso = (n) => new Date(n).toISOString();
const validId = (n) => Number.isSafeInteger(n) && n > 0;
const time = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
function policyOptions(value) {
  if (value === undefined || value === false) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid Policy collection options");
  const options = {
    enabled: false,
    lookbackDays: 90,
    maxRequestsPerCycle: 80,
    maxSecondsPerCycle: 60,
    workflowNames: ["OCR Dispatch", "OCR Code Review"],
    telemetrySince: null,
    rescanSeconds: 3600,
    ...value,
  };
  if (
    typeof options.enabled !== "boolean" ||
    !Number.isInteger(options.lookbackDays) ||
    options.lookbackDays < 1 ||
    options.lookbackDays > 90 ||
    !Number.isInteger(options.maxRequestsPerCycle) ||
    options.maxRequestsPerCycle < 4 ||
    options.maxRequestsPerCycle > 500 ||
    !Number.isInteger(options.maxSecondsPerCycle) ||
    options.maxSecondsPerCycle < 1 ||
    options.maxSecondsPerCycle > 120 ||
    (options.telemetrySince !== null && !time(options.telemetrySince)) ||
    !Number.isInteger(options.rescanSeconds) ||
    options.rescanSeconds < 300 ||
    options.rescanSeconds > 86400 ||
    !Array.isArray(options.workflowNames) ||
    !options.workflowNames.length ||
    options.workflowNames.some(
      (v) => typeof v !== "string" || !v || v.length > 200,
    )
  )
    throw Error("Invalid Policy collection options");
  return options;
}
async function collectActions({
  config,
  options: rawOptions,
  repositories,
  previous = new Map(),
  now = Date.now(),
  http,
}) {
  const options = policyOptions(rawOptions);
  const records = new Map(structuredClone([...previous]));
  const repos = new Map(repositories.map((r) => [r.id, r]));
  const warnings = new Set();
  const since = options?.telemetrySince
    ? Date.parse(options.telemetrySince)
    : 0;
  const lower = Math.max(now - (options?.lookbackDays || 90) * DAY, since);
  const exclude = (entry) => {
    entry.done = true;
    entry.nextAt = 0;
    entry.row.outcome = "unknown";
    entry.row.reason = "before_telemetry_start";
    entry.row.coverage = "missing";
    entry.row.checkedAt = iso(now);
  };
  if (since)
    for (const [key, entry] of records) {
      if (
        key.startsWith("run:") &&
        !entry.done &&
        !entry.verifyStart &&
        entry.row.providerAttempt === 1 &&
        Date.parse(entry.row.at) < since
      )
        exclude(entry);
    }
  const attempts = () =>
    [...records]
      .filter(
        ([key, r]) => key.startsWith("run:") && repos.has(r.row.repositoryId),
      )
      .map(([, r]) => r.row);
  for (const [key, r] of records)
    if (key.startsWith("run:") && Date.parse(r.row.at) < now - 90 * DAY)
      records.delete(key);
  const coverage = repositories.map((r) => ({
    id: r.id,
    repositoryId: r.id,
    from: iso(
      Math.max(
        lower,
        Date.parse(records.get("scan:" + r.id)?.from || iso(lower)),
      ),
    ),
    through: records.get("scan:" + r.id)?.through || null,
    checkedAt: iso(now),
    status: options?.enabled ? "syncing" : "disabled",
    errorCode: null,
  }));
  if (!options?.enabled)
    return {
      records,
      attempts: attempts(),
      coverage,
      warnings: ["POLICY_LOGS_DISABLED"],
    };
  http ||= actionsHTTP(config);
  let budget = options.maxRequestsPerCycle;
  const deadline = Date.now() + options.maxSecondsPerCycle * 1000;
  const available = (cost = 1) => budget >= cost && Date.now() < deadline;
  const json = async (route) => {
    if (!available()) throw Error("ACTIONS_CYCLE_BUDGET");
    budget--;
    return http.json(route);
  };
  const ordered = [...repositories];
  const offset = records.get("meta")?.offset || 0;
  ordered.push(...ordered.splice(0, offset % Math.max(1, ordered.length)));
  let visited = 0;
  async function discover(repo, historical = false) {
    const current = coverage.find((r) => r.id === repo.id);
    const key = (historical ? "history:" : "scan:") + repo.id;
    let scan = records.get(key);
    if (!historical && scan && since && Date.parse(scan.from) < since)
      scan = null;
    if (scan?.nextAt > now) {
      if (scan.error) {
        current.status = "error";
        current.errorCode = scan.error;
      }
      return;
    }
    if (!scan?.windows?.length) {
      const from =
        historical || !since
          ? iso(now - options.lookbackDays * DAY)
          : iso(
              Math.max(
                lower,
                scan?.through ? Date.parse(scan.through) - 300000 : lower,
              ),
            );
      scan = {
        from: historical ? from : iso(lower),
        through: scan?.through || null,
        target: iso(now),
        windows: [{ from, to: iso(now), page: 1 }],
      };
    }
    if (!historical) current.from = scan.from;
    records.set(key, scan);
    const range = scan.windows[0];
    try {
      const query = new URLSearchParams({
        event: "pull_request_target",
        per_page: "100",
        page: String(range.page),
        created: range.from + ".." + range.to,
      });
      const body = await json(`/repos/${repo.name}/actions/runs?${query}`);
      if (
        !Number.isSafeInteger(body.total_count) ||
        !Array.isArray(body.workflow_runs) ||
        body.workflow_runs.length > 100
      )
        throw Error("ACTIONS_INVALID_RUNS");
      if (body.total_count > 1000) {
        const middle =
          Math.floor((Date.parse(range.from) + Date.parse(range.to)) / 2000) *
          1000;
        if (middle <= Date.parse(range.from) || middle >= Date.parse(range.to))
          throw Error("ACTIONS_WINDOW_TOO_DENSE");
        scan.windows.splice(
          0,
          1,
          { from: iso(middle), to: range.to, page: 1 },
          { from: range.from, to: iso(middle), page: 1 },
        );
      } else {
        if (
          body.total_count > (range.page - 1) * 100 &&
          body.workflow_runs.length === 0
        )
          throw Error("ACTIONS_INCOMPLETE_PAGE");
        for (const run of body.workflow_runs) {
          if (
            !validId(run.id) ||
            !validId(run.run_attempt) ||
            run.run_attempt > 1000 ||
            !time(run.created_at) ||
            !time(run.updated_at)
          )
            throw Error("ACTIONS_INVALID_RUN");
          if (!options.workflowNames.includes(run.name)) continue;
          if (
            since &&
            Date.parse(run.created_at) < since &&
            Date.parse(run.updated_at) < since
          )
            continue;
          for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
            const id = `${repo.id}:${run.id}:${attempt}`;
            const existing = records.get("run:" + id);
            const started =
              attempt === run.run_attempt && time(run.run_started_at)
                ? run.run_started_at
                : run.created_at;
            if (existing) {
              if (
                existing.row.reason === "before_telemetry_start" &&
                Date.parse(started) >= since
              ) {
                existing.done = false;
                existing.verifyStart = true;
                existing.row.at = started;
                existing.row.outcome = "pending";
                existing.row.reason = "logs_pending";
                existing.row.coverage = "pending";
              }
              continue;
            }
            if (since && Date.parse(started) < since && attempt === 1) continue;
            records.set("run:" + id, {
              nextAt: 0,
              done: false,
              failures: 0,
              verifyStart: Date.parse(run.created_at) < since,
              row: {
                id,
                repositoryId: repo.id,
                providerRunId: String(run.id),
                providerAttempt: attempt,
                jobId: null,
                prNumber: null,
                requestId: null,
                headSha: null,
                baseSha: null,
                baseRef: null,
                at: started,
                finishedAt: null,
                checkedAt: iso(now),
                outcome: "pending",
                reason: "logs_pending",
                elapsedMs: null,
                coverage: "pending",
                url: `https://github.com/${repo.name}/actions/runs/${run.id}/attempts/${attempt}`,
                requests: [],
                backend: [],
              },
            });
          }
        }
        if (range.page * 100 < body.total_count && body.workflow_runs.length)
          range.page++;
        else scan.windows.shift();
        if (!scan.windows.length) scan.through = scan.target;
      }
      scan.nextAt =
        historical && !scan.windows.length
          ? now + options.rescanSeconds * 1000
          : 0;
      scan.error = null;
      if (!historical) {
        current.through = scan.through;
        current.status = scan.windows.length ? "syncing" : "ready";
      }
    } catch (error) {
      scan.error = /^ACTIONS_[A-Z_0-9]+$/.test(error.message)
        ? error.message
        : "ACTIONS_UNAVAILABLE";
      scan.nextAt = now + 5 * 60000;
      current.status = "error";
      current.errorCode = scan.error;
      warnings.add("POLICY_LOGS_UNAVAILABLE");
    }
  }
  for (const repo of ordered) {
    const ready = [...records].some(
      ([key, r]) =>
        key.startsWith("run:") &&
        !r.done &&
        r.nextAt <= now &&
        repos.has(r.row.repositoryId),
    );
    if (
      !available(
        Math.max(Math.ceil(options.maxRequestsPerCycle / 2), ready ? 5 : 1),
      )
    )
      break;
    visited++;
    await discover(repo);
  }
  const historyOffset = records.get("meta")?.historyOffset || 0;
  records.set("meta", {
    offset: (offset + visited) % Math.max(1, ordered.length),
    historyOffset,
  });
  const pending = [...records]
    .filter(
      ([key, r]) =>
        key.startsWith("run:") &&
        !r.done &&
        r.nextAt <= now &&
        repos.has(r.row.repositoryId),
    )
    .sort(
      (a, b) =>
        a[1].nextAt - b[1].nextAt ||
        Date.parse(b[1].row.at) - Date.parse(a[1].row.at),
    );
  let logsProcessed = 0;
  const historyReserve = since && options.maxRequestsPerCycle >= 16 ? 2 : 0;
  for (const [, entry] of pending) {
    if (!available(4 + historyReserve)) break;
    const row = entry.row,
      repo = repos.get(row.repositoryId);
    const route = `/repos/${repo.name}/actions/runs/${row.providerRunId}/attempts/${row.providerAttempt}`;
    try {
      const run = await json(route);
      if (
        String(run.id) !== row.providerRunId ||
        run.run_attempt !== row.providerAttempt ||
        !time(run.run_started_at || run.created_at)
      )
        throw Error("ACTIONS_INVALID_ATTEMPT");
      row.at = run.run_started_at || run.created_at;
      row.checkedAt = iso(now);
      if (since && Date.parse(row.at) < since) {
        exclude(entry);
        continue;
      }
      if (run.status !== "completed") {
        entry.nextAt = now + 60000;
        continue;
      }
      row.outcome = run.conclusion === "cancelled" ? "cancelled" : "unknown";
      row.coverage = "missing";
      const jobs = await json(route + "/jobs?per_page=100");
      if (
        !Array.isArray(jobs.jobs) ||
        !Number.isSafeInteger(jobs.total_count) ||
        jobs.total_count > 100
      )
        throw Error("ACTIONS_INVALID_JOBS");
      const candidates = jobs.jobs.filter(
        (j) => j.name === "OCR dispatch" && validId(j.id),
      );
      if (candidates.length !== 1) throw Error("ACTIONS_CLIENT_JOB_UNRESOLVED");
      row.jobId = String(candidates[0].id);
      budget -= 2;
      const log = await http.log(
        `/repos/${repo.name}/actions/jobs/${row.jobId}/logs`,
      );
      Object.assign(
        row,
        parseClientLog(log, {
          repository: repo.name,
          aliases: repo.aliases,
          repositoryId: repo.providerId,
          runId: row.providerRunId,
          attempt: row.providerAttempt,
          cancelled: run.conclusion === "cancelled",
        }),
      );
      entry.done = true;
      entry.failures = 0;
      logsProcessed++;
    } catch (error) {
      entry.failures++;
      entry.nextAt =
        now + Math.min(DAY, 60000 * 2 ** Math.min(10, entry.failures));
      row.outcome = "pending";
      row.coverage = "pending";
      row.reason = /^ACTIONS_[A-Z_0-9]+$/.test(error.message)
        ? error.message.toLowerCase()
        : "actions_unavailable";
      warnings.add("POLICY_LOGS_UNAVAILABLE");
    }
  }
  if (since) {
    const history = [...repositories];
    history.push(
      ...history.splice(0, historyOffset % Math.max(1, history.length)),
    );
    let scanned = 0;
    for (const repo of history) {
      if (!available()) break;
      scanned++;
      await discover(repo, true);
    }
    records.get("meta").historyOffset =
      (historyOffset + scanned) % Math.max(1, history.length);
  }
  for (const row of coverage) {
    const scan = records.get("scan:" + row.id);
    if (row.status === "syncing" && scan?.through && !scan.windows.length)
      row.status = "ready";
    if (since) {
      const historical = records.get("history:" + row.id);
      row.through =
        scan?.through && historical?.through
          ? iso(
              Math.min(
                Date.parse(scan.through),
                Date.parse(historical.through),
              ),
            )
          : null;
      if (
        row.status === "ready" &&
        (!historical?.through || historical.windows.length)
      )
        row.status = "syncing";
    }
    const pending = [...records].some(
      ([key, r]) =>
        key.startsWith("run:") && !r.done && r.row.repositoryId === row.id,
    );
    if (row.status === "ready" && pending) row.status = "syncing";
    const incomplete = attempts().some(
      (a) =>
        a.repositoryId === row.id &&
        a.coverage !== "complete" &&
        a.reason !== "before_telemetry_start",
    );
    if (incomplete) warnings.add("POLICY_LOGS_PARTIAL");
  }
  const rows = attempts();
  return {
    records,
    attempts: rows,
    coverage,
    warnings: [...warnings],
    stats: {
      ...(http.stats || {}),
      oldestPendingMs: rows.some((r) => r.outcome === "pending")
        ? Math.max(
            ...rows
              .filter((r) => r.outcome === "pending")
              .map((r) => Math.max(0, now - Date.parse(r.at))),
          )
        : 0,
      requestBudgetUsed: options.maxRequestsPerCycle - budget,
      logsProcessed,
      pending: rows.filter((r) => r.outcome === "pending").length,
      beforeTelemetry: rows.filter((r) => r.reason === "before_telemetry_start")
        .length,
      missingResults: rows.filter(
        (r) => r.outcome === "unknown" && r.reason !== "before_telemetry_start",
      ).length,
      budgetExhausted: !available(4),
      telemetrySince: options.telemetrySince,
    },
  };
}
module.exports = { collectActions, policyOptions };
