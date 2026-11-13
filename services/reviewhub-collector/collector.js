// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const fs = require("node:fs"),
  path = require("node:path");
const { Analytics } = require("../github-review/analytics.js");
const { AgentUsage } = require("../github-review/agent-usage.js");
const { repositoryMetadata } = require("./repository-metadata.js");
const { hostResources } = require("../github-review/monitor-data.js");
const { bootstrapAudit } = require("./database/bootstrap.js");
const { readState } = require("./database/state-source.js");
const { normalize } = require("./normalize.js");
const { collectActions, policyOptions } = require("./actions.js");
const { backendAdmissions } = require("./backend-admission.js");
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
  options.policy = policyOptions(options.policy);
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
async function collect({
  options,
  config,
  store,
  saved,
  now = Date.now(),
  metadataReader = repositoryMetadata,
  resourcesReader = hostResources,
  actionsReader = collectActions
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
  const actionInput = {
    config,
    options: options.policy || undefined,
    repositories: batch.repositories,
    previous: new Map(Object.entries(group(records, "actions:"))),
    now
  };
  let actions;
  try {
    actions = await actionsReader(actionInput);
  } catch {
    // Log discovery must not prevent publication of the independent task source.
    actions = await collectActions({ ...actionInput, options: { enabled: false } });
    actions.coverage = actions.coverage.map((row) => ({
      ...row,
      status: "error",
      errorCode: "ACTIONS_UNAVAILABLE"
    }));
    actions.warnings = ["POLICY_LOGS_UNAVAILABLE"];
  }
  const backend = backendAdmissions(input.state, batch);
  batch.clientAttempts = actions.attempts.map((row) => ({
    ...row,
    backend: backend.associate(row)
  }));
  const associations = new Map(batch.clientAttempts.map((row) => [row.id, row.backend]));
  for (const entry of actions.records.values())
    if (entry.row)
      entry.row.backend = associations.get(entry.row.id) || entry.row.backend;
  batch.clientCoverage = actions.coverage;
  batch.events.push(...backend.events);
  batch.warnings = [...new Set([...batch.warnings, ...actions.warnings])];
  const next = new Map();
  for (const [key, value] of actions.records) next.set("actions:" + key, value);
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
  return { batch, saved: { checkpoint, records: next }, policy: actions.stats };
}
module.exports = { collect, optionsFromFile, repositoryMetadata };
