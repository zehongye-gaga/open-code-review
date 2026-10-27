// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";
const fs = require("node:fs"), crypto = require("node:crypto");
const { resolveOptions } = require("./options.js");
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const semanticKeys = ["provider", "model", "effort", "reasoningEffort", "background", "exclude", "noFilter", "ruleSet", "toolSet"];
function executorVersion(binary) { return digest(fs.readFileSync(binary)); }
function legacyExecutorVersion(binary) { return digest(JSON.stringify(fs.readFileSync(binary).toString("base64"))); }
function policySignature(service, repository) {
  const baseline = resolveOptions(service.config, repository, repository.defaultProfile || "standard");
  return digest(JSON.stringify({ options: Object.fromEntries([...semanticKeys,"blockSeverity"].map(k=>[k,baseline.options[k]])),
    resources: baseline.resources, minimumEffort: repository.minimumEffort || "low", policyVersion: baseline.policyVersion }));
}
function bindPolicy(service, repository, settings) {
  settings.executorVersion = executorVersion(service.config.binary);
  settings.policySignature = policySignature(service, repository);
  return settings;
}
function compatiblePolicy(job, settings) {
  if (!settings) return true;
  const previous = job.settings;
  if (!previous) return false;
  const levels = ["low", "medium", "high", "critical", "none"];
  const oldLevel = levels.indexOf(previous.options?.blockSeverity), newLevel = levels.indexOf(settings.options?.blockSeverity);
  if (previous.policyVersion !== settings.policyVersion || oldLevel < 0 || newLevel < 0 || oldLevel > newLevel) return false;
  if (settings.executorVersion && previous.executorVersion !== settings.executorVersion && previous.executorVersion !== settings.legacyExecutorVersion) return false;
  if (JSON.stringify(previous.resources || {}) !== JSON.stringify(settings.resources || {})) return false;
  if (previous.policySignature && settings.policySignature) return previous.policySignature === settings.policySignature;
  return previous.resolvedProvider === settings.resolvedProvider && semanticKeys.every(key=>previous.options?.[key] === settings.options?.[key]);
}
function currentPolicy(service, job) {
  try {
    const repository = service.repo(job.repository), previous = job.settings;
    if (!previous) return false;
    const settings = resolveOptions(service.config, repository, previous.profile || "standard", previous.policySignature ? previous.options : {});
    bindPolicy(service,repository,settings); settings.legacyExecutorVersion = legacyExecutorVersion(service.config.binary);
    return compatiblePolicy(job, settings);
  } catch { return false; }
}
module.exports = { compatiblePolicy, currentPolicy, executorVersion, legacyExecutorVersion, bindPolicy };
