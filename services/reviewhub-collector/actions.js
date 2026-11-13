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
    ...value
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
    !Array.isArray(options.workflowNames) ||
    !options.workflowNames.length ||
    options.workflowNames.some((v) => typeof v !== "string" || !v || v.length > 200)
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
  http
}) {
  const options = policyOptions(rawOptions);
  const records = new Map(structuredClone([...previous]));
  const repos = new Map(repositories.map((r) => [r.id, r]));
  const warnings = new Set();
  const attempts = () =>
    [...records]
      .filter(([key, r]) => key.startsWith("run:") && repos.has(r.row.repositoryId))
      .map(([, r]) => r.row);
  for (const [key, r] of records)
    if (key.startsWith("run:") && Date.parse(r.row.at) < now - 90 * DAY)
      records.delete(key);
  const coverage = repositories.map((r) => ({
    id: r.id,
    repositoryId: r.id,
    from:
      records.get("scan:" + r.id)?.from || iso(now - (options?.lookbackDays || 90) * DAY),
    through: records.get("scan:" + r.id)?.through || null,
    checkedAt: iso(now),
    status: options?.enabled ? "syncing" : "disabled",
    errorCode: null
  }));
  if (!options?.enabled)
    return {
      records,
      attempts: attempts(),
      coverage,
      warnings: ["POLICY_LOGS_DISABLED"]
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
  for (const repo of ordered) {
    const ready = [...records].some(
      ([key, r]) =>
        key.startsWith("run:") &&
        !r.done &&
        r.nextAt <= now &&
        repos.has(r.row.repositoryId)
    );
    if (!available(Math.max(Math.ceil(options.maxRequestsPerCycle / 2), ready ? 5 : 1)))
      break;
    visited++;
    const current = coverage.find((r) => r.id === repo.id);
    let scan = records.get("scan:" + repo.id);
    if (!scan?.windows?.length)
      scan = {
        from: iso(now - options.lookbackDays * DAY),
        through: scan?.through || null,
        target: iso(now),
        windows: [{ from: iso(now - options.lookbackDays * DAY), to: iso(now), page: 1 }]
      };
    current.from = scan.from;
    records.set("scan:" + repo.id, scan);
    if (scan.nextAt > now) {
      current.status = "error";
      current.errorCode = scan.error;
      continue;
    }
    const range = scan.windows[0];
    try {
      const query = new URLSearchParams({
        event: "pull_request_target",
        per_page: "100",
        page: String(range.page),
        created: range.from + ".." + range.to
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
          Math.floor((Date.parse(range.from) + Date.parse(range.to)) / 2000) * 1000;
        if (middle <= Date.parse(range.from) || middle >= Date.parse(range.to))
          throw Error("ACTIONS_WINDOW_TOO_DENSE");
        scan.windows.splice(
          0,
          1,
          { from: iso(middle), to: range.to, page: 1 },
          { from: range.from, to: iso(middle), page: 1 }
        );
      } else {
        if (body.total_count > (range.page - 1) * 100 && body.workflow_runs.length === 0)
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
          for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
            const id = `${repo.id}:${run.id}:${attempt}`;
            if (records.has("run:" + id)) continue;
            records.set("run:" + id, {
              nextAt: 0,
              done: false,
              failures: 0,
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
                at: run.created_at,
                finishedAt: null,
                checkedAt: iso(now),
                outcome: "pending",
                reason: "logs_pending",
                elapsedMs: null,
                coverage: "pending",
                url: `https://github.com/${repo.name}/actions/runs/${run.id}/attempts/${attempt}`,
                requests: [],
                backend: []
              }
            });
          }
        }
        if (range.page * 100 < body.total_count && body.workflow_runs.length)
          range.page++;
        else scan.windows.shift();
        if (!scan.windows.length) scan.through = scan.target;
      }
      scan.nextAt = 0;
      scan.error = null;
      current.through = scan.through;
      current.status = scan.windows.length ? "syncing" : "ready";
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
  records.set("meta", { offset: (offset + visited) % Math.max(1, ordered.length) });
  const pending = [...records]
    .filter(
      ([key, r]) =>
        key.startsWith("run:") &&
        !r.done &&
        r.nextAt <= now &&
        repos.has(r.row.repositoryId)
    )
    .sort(
      (a, b) =>
        a[1].nextAt - b[1].nextAt || Date.parse(b[1].row.at) - Date.parse(a[1].row.at)
    );
  for (const [, entry] of pending) {
    if (!available(4)) break;
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
        (j) => j.name === "OCR dispatch" && validId(j.id)
      );
      if (candidates.length !== 1) throw Error("ACTIONS_CLIENT_JOB_UNRESOLVED");
      row.jobId = String(candidates[0].id);
      budget -= 2;
      const log = await http.log(`/repos/${repo.name}/actions/jobs/${row.jobId}/logs`);
      Object.assign(
        row,
        parseClientLog(log, {
          repository: repo.name,
          aliases: repo.aliases,
          repositoryId: repo.providerId,
          runId: row.providerRunId,
          attempt: row.providerAttempt,
          cancelled: run.conclusion === "cancelled"
        })
      );
      entry.done = true;
      entry.failures = 0;
    } catch (error) {
      entry.failures++;
      entry.nextAt = now + Math.min(DAY, 60000 * 2 ** Math.min(10, entry.failures));
      row.reason = /^ACTIONS_[A-Z_0-9]+$/.test(error.message)
        ? error.message.toLowerCase()
        : "actions_unavailable";
      warnings.add("POLICY_LOGS_UNAVAILABLE");
    }
  }
  for (const row of coverage) {
    const scan = records.get("scan:" + row.id);
    if (row.status === "syncing" && scan?.through && !scan.windows.length)
      row.status = "ready";
    const pending = [...records].some(
      ([key, r]) => key.startsWith("run:") && !r.done && r.row.repositoryId === row.id
    );
    if (row.status === "ready" && pending) row.status = "syncing";
    const incomplete = attempts().some(
      (a) => a.repositoryId === row.id && a.coverage !== "complete"
    );
    if (incomplete) warnings.add("POLICY_LOGS_PARTIAL");
  }
  return { records, attempts: attempts(), coverage, warnings: [...warnings] };
}
module.exports = { collectActions, policyOptions };
