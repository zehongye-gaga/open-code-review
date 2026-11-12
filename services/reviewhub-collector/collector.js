// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const fs = require("node:fs"),
  path = require("node:path");
const { Analytics } = require("../github-review/analytics.js");
const { AgentUsage } = require("../github-review/agent-usage.js");
const { GitHubAuth } = require("../github-review/github-auth.js");
const { hostResources } = require("../github-review/monitor-data.js");
const { bootstrapAudit } = require("./database/bootstrap.js");
const { readState } = require("./database/state-source.js");
const { normalize } = require("./normalize.js");
const group = (records, prefix) =>
  Object.fromEntries(
    [...records]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key.slice(prefix.length), value])
  );
function optionsFromFile(file) {
  const options = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    !options ||
    typeof options !== "object" ||
    !path.isAbsolute(options.ocrConfig || "") ||
    !Array.isArray(options.organizations) ||
    !options.organizations.length ||
    options.organizations.some(
      (v) => typeof v !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(v)
    )
  )
    throw Error("Invalid collector source configuration");
  options.intervalSeconds ??= 300;
  if (
    !Number.isInteger(options.intervalSeconds) ||
    options.intervalSeconds < 30 ||
    options.intervalSeconds > 86400
  )
    throw Error("Invalid collection interval");
  options.organizations = options.organizations.map((v) => v.toLowerCase());
  const config = JSON.parse(fs.readFileSync(options.ocrConfig, "utf8"));
  if (
    !config ||
    !path.isAbsolute(config.stateDirectory || "") ||
    !Array.isArray(config.repositories) ||
    config.repositories.some(
      (r) =>
        !r ||
        !/^[\w.-]+\/[\w.-]+$/.test(r.name || "") ||
        (r.githubName !== undefined &&
          (!/^[\w.-]+\/[\w.-]+$/.test(r.githubName || "") ||
            r.githubName.split("/")[0].toLowerCase() !==
              r.name.split("/")[0].toLowerCase()))
    )
  )
    throw Error("Invalid backend configuration");
  const names = new Set();
  for (const repository of config.repositories)
    for (const name of new Set(
      [repository.name, repository.githubName]
        .filter(Boolean)
        .map((v) => v.toLowerCase())
    )) {
      if (names.has(name))
        throw Error("Duplicate configured repository alias");
      names.add(name);
    }
  if (
    !options.analytics ||
    !path.isAbsolute(options.analytics.sessionDirectory || "")
  )
    throw Error("Configure the native session directory");
  config.organizations = options.organizations;
  config.repositories = config.repositories.filter((r) =>
    options.organizations.includes(r.name.split("/")[0].toLowerCase())
  );
  return { options, config };
}
async function repositoryMetadata(config, previous, now, request = fetch) {
  const auth = new GitHubAuth(config, request, Date.now, false),
    result = { ...previous },
    warnings = [];
  for (const repository of config.repositories) {
    const name = repository.name.toLowerCase();
    const previousRow = previous[name];
    if (
      previousRow?.checkedAt &&
      now - Date.parse(previousRow.checkedAt) < 3600000
    ) {
      if (previousRow.access !== "available")
        warnings.push(
          previousRow.access === "unavailable"
            ? "REPOSITORY_ACCESS_UNAVAILABLE"
            : "GITHUB_METADATA_UNVERIFIED"
        );
      continue;
    }
    try {
      const target = repository.githubName || repository.name;
      const response = await auth.request(
        "https://api.github.com/repos/" +
          target.split("/").map(encodeURIComponent).join("/"),
        {
          signal: AbortSignal.timeout(15000),
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "reviewhub-collector",
            "x-github-api-version": "2022-11-28"
          }
        }
      );
      if (response.status === 404) {
        result[name] = {
          ...previousRow,
          access: "unavailable",
          checkedAt: new Date(now).toISOString()
        };
        warnings.push("REPOSITORY_ACCESS_UNAVAILABLE");
        continue;
      }
      if (!response.ok) throw Error("Repository metadata unavailable");
      const body = await response.json();
      if (
        !Number.isSafeInteger(body.id) ||
        body.id < 1 ||
        typeof body.full_name !== "string" ||
        typeof body.default_branch !== "string"
      )
        throw Error("Invalid repository metadata");
      result[name] = {
        providerId: String(body.id),
        name: body.full_name.toLowerCase(),
        defaultBranch: body.default_branch,
        archived: body.archived === true,
        updatedAt: new Date(now).toISOString(),
        checkedAt: new Date(now).toISOString(),
        access: auth.app ? "available" : "unknown"
      };
      if (!auth.app) warnings.push("APP_ACCESS_NOT_VERIFIED");
    } catch {
      result[name] = {
        ...previousRow,
        access: "unknown",
        checkedAt: new Date(now).toISOString()
      };
      warnings.push("GITHUB_METADATA_UNAVAILABLE");
    }
  }
  return { metadata: result, warnings };
}
async function collect({
  options,
  config,
  store,
  saved,
  now = Date.now(),
  metadataReader = repositoryMetadata,
  resourcesReader = hostResources
}) {
  const records = saved.records;
  const sourceRows = new Map(Object.entries(group(records, "state:")));
  const input = readState(
    options.stateSource || path.join(config.stateDirectory, "state.db"),
    saved.checkpoint.state,
    sourceRows
  );
  if (input.state.version !== 1 || !Array.isArray(input.state.jobs))
    throw Error("Invalid task state");
  const meta = records.get("ledger:meta");
  let ledger = meta
    ? {
        ...meta,
        jobs: group(records, "ledger:job:"),
        sessions: group(records, "ledger:session:"),
        artifacts: group(records, "ledger:artifact:")
      }
    : null;
  let historicalAudits = [];
  if (!ledger && options.bootstrapAuditDatabase) {
    const initial = bootstrapAudit(options.bootstrapAuditDatabase);
    ledger = initial.ledger;
    historicalAudits = initial.audits;
  }
  if (!ledger && options.bootstrapLedger) {
    if (
      !path.isAbsolute(options.bootstrapLedger) ||
      fs.statSync(options.bootstrapLedger).size > 64 * 1024 * 1024
    )
      throw Error("Invalid bootstrap ledger");
    ledger = JSON.parse(fs.readFileSync(options.bootstrapLedger, "utf8"));
  }
  const analytics = new Analytics(
    config,
    {
      ...options.analytics,
      directory: options.analytics.directory || config.stateDirectory,
      timeZone: "Asia/Shanghai",
      retentionDays: 90
    },
    { load: () => ledger, save: () => {} }
  );
  const warnings = [];
  await analytics.collect(input.state.jobs, now);
  if (analytics.readErrors) warnings.push("NATIVE_USAGE_PARTIAL");
  if (analytics.pendingFiles) warnings.push("NATIVE_USAGE_PENDING");
  const previousAgent = records.get("agent:meta");
  const agent = new AgentUsage(
    config.infrastructure?.agentDispatch,
    config.stateDirectory,
    fetch,
    {
      load: () =>
        previousAgent
          ? { ...previousAgent, sessions: group(records, "agent:session:") }
          : null,
      save: () => {}
    }
  );
  await agent.collect(input.state.agentSessions, now);
  if (agent.value.error) warnings.push("AGENT_USAGE_UNAVAILABLE");
  const remote =
    options.githubMetadata === false
      ? {
          metadata: group(records, "metadata:"),
          warnings: ["GITHUB_METADATA_DISABLED"]
        }
      : await metadataReader(config, group(records, "metadata:"), now);
  warnings.push(...remote.warnings);
  const resources = resourcesReader(options.volumes || []);
  const batch = normalize({
    config,
    state: input.state,
    ledger: analytics.ledger,
    agent: agent.value,
    metadata: remote.metadata,
    previousRepositories: Object.values(group(records, "repository:")),
    sourceId: store.sourceId,
    intervalSeconds: options.intervalSeconds,
    now,
    resources,
    warnings,
    historicalAudits
  });
  const next = new Map();
  for (const [key, value] of input.rows) next.set("state:" + key, value);
  const { jobs, sessions, artifacts, ...ledgerMeta } = analytics.ledger;
  next.set("ledger:meta", ledgerMeta);
  for (const [prefix, values] of [
    ["ledger:job:", jobs],
    ["ledger:session:", sessions],
    ["ledger:artifact:", artifacts],
    ["metadata:", remote.metadata]
  ])
    for (const [key, value] of Object.entries(values))
      next.set(prefix + key, value);
  // Hidden repositories still need their stable IDs if they are enrolled again.
  for (const [key, value] of records)
    if (key.startsWith("repository:")) next.set(key, value);
  for (const repository of batch.repositories)
    next.set("repository:" + repository.id, repository);
  const { sessions: agentSessions, ...agentMeta } = agent.value;
  next.set("agent:meta", agentMeta);
  for (const [key, value] of Object.entries(agentSessions))
    next.set("agent:session:" + key, value);
  const checkpoint = {
    state: input.checkpoint,
    mode: input.mode,
    changedRows: input.changedRows
  };
  await store.publish(batch, checkpoint, next);
  return { batch, saved: { checkpoint, records: next } };
}
module.exports = { collect, optionsFromFile, repositoryMetadata };
