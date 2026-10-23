// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const properties = {
  effort: { type: "string", enum: ["low", "medium", "high"] },
  provider: { type: "string", minLength: 1, maxLength: 100 },
  model: { type: "string", minLength: 1, maxLength: 200 },
  budget: { type: "integer", minimum: 0, maximum: 10000000 },
  maxTokens: { type: "integer", minimum: 1, maximum: 1000000 },
  maxTools: { type: "integer", minimum: 50, maximum: 1000 },
  concurrency: { type: "integer", minimum: 1, maximum: 16 },
  timeout: { type: "integer", minimum: 1, maximum: 120 },
  timeoutSeconds: { type: "integer", minimum: 10, maximum: 7200 },
  fetchTimeoutSeconds: { type: "integer", minimum: 10, maximum: 1800 },
  requestTimeoutSeconds: { type: "integer", minimum: 1, maximum: 1800 },
  maxGitProcs: { type: "integer", minimum: 1, maximum: 32 },
  noFilter: { type: "boolean" },
  exclude: { type: "string", maxLength: 4000 },
  background: { type: "string", maxLength: 50000 },
  ruleSet: { type: "string", maxLength: 100 },
  toolSet: { type: "string", maxLength: 100 },
  reasoningEffort: { type: "string", enum: ["minimal", "low", "medium", "high", "xhigh", "max"] },
  fullReview: { type: "boolean" },
  blockSeverity: { type: "string", enum: ["critical", "high", "medium", "low", "none"] },
};
const presets = {
  light: { effort: "low", budget: 80000, concurrency: 2, timeout: 15 },
  standard: { effort: "medium", budget: 200000, concurrency: 2, timeout: 15 },
  deep: { effort: "high", budget: 500000, concurrency: 2, timeout: 15 },
};
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function validate(value, schema, label = "arguments") {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
    for (const k of Object.keys(value)) {
      if (!own(schema.properties, k)) fail(`Unknown ${label}.${k}`);
      validate(value[k], schema.properties[k], `${label}.${k}`);
    }
    for (const k of schema.required || []) if (!own(value, k)) fail(`Missing ${label}.${k}`);
  } else {
    if (schema.type === "integer" ? !Number.isSafeInteger(value) : typeof value !== schema.type) fail(`Invalid ${label}`);
    if (schema.enum && !schema.enum.includes(value)) fail(`Unsupported ${label}`);
    if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum) fail(`Out of range ${label}`);
    if (schema.minLength !== undefined && value.length < schema.minLength || schema.maxLength !== undefined && value.length > schema.maxLength) fail(`Invalid length ${label}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(`Invalid ${label}`);
  }
}
const schema = { type: "object", properties, additionalProperties: false };
function resolveOptions(config, repository, profile = "standard", overrides = {}) {
  const infra = config.infrastructure || {};
  const profiles = { ...presets, ...infra.profiles };
  if (!own(profiles, profile)) fail("Unknown review profile");
  validate(overrides, schema, "options");
  const options = { provider: config.provider, model: config.model, timeoutSeconds: config.timeoutSeconds,
    fetchTimeoutSeconds: config.fetchTimeoutSeconds, blockSeverity: config.blockSeverity,
    ...profiles[profile], ...repository.reviewDefaults, ...overrides };
  validate(options, schema, "resolved options");
  const providers = infra.providers || { [config.provider]: { models: [config.model] } };
  if (!own(providers, options.provider) || !providers[options.provider].models?.includes(options.model)) fail("Provider/model pair is not allowed", 403);
  if (options.reasoningEffort && !providers[options.provider].reasoningEfforts?.includes(options.reasoningEffort)) fail("Reasoning effort is not supported by this provider", 403);
  if (options.budget === 0 && infra.allowUnlimitedBudget !== true) fail("Unlimited budget is not authorized by server policy", 403);
  const limits = { budget: 1000000, concurrency: 4, timeoutSeconds: 3600, ...infra.limits, ...repository.limits };
  for (const [key, max] of Object.entries(limits)) {
    if (typeof options[key] === "number" && options[key] > max) fail(`Policy limit exceeded: ${key}`, 403);
  }
  const levels = ["low", "medium", "high"];
  if (levels.indexOf(options.effort) < levels.indexOf(repository.minimumEffort || "low")) fail("Review effort is below repository policy", 403);
  const resources = {};
  for (const [key, table] of [["ruleSet", "ruleSets"], ["toolSet", "toolSets"]]) {
    if (!options[key]) continue;
    const entries = infra[table] || {};
    if (!own(entries, options[key])) fail(`Unknown ${key}`);
    const file = entries[options[key]];
    if (typeof file !== "string" || !file.startsWith("/")) fail(`Invalid configured ${key}`);
    resources[key] = { file, digest: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
  }
  const resolvedProvider = options.reasoningEffort ? providers[options.provider].reasoningProviders?.[options.reasoningEffort] : options.provider;
  if (!resolvedProvider) fail("Configure a named native provider for this reasoning effort", 403);
  return { profile, options, resources, resolvedProvider, policyVersion: infra.policyVersion || "1" };
}
function validateInfrastructure(config) {
  const infra = config.infrastructure;
  if (!infra) return;
  for (const key of ["enabled", "externalDispatch", "dispatchEnabled"]) if (infra[key] !== undefined && typeof infra[key] !== "boolean") fail(`infrastructure.${key} must be boolean`);
  if (infra.port !== undefined && (!Number.isSafeInteger(infra.port) || infra.port < 1 || infra.port > 65535)) fail("Invalid infrastructure port");
  if (infra.budgetRetry !== undefined) validate(infra.budgetRetry, { type: "object", properties: {
    enabled: { type: "boolean" }, maxRetries: { type: "integer", minimum: 0, maximum: 5 },
    multiplier: { type: "integer", minimum: 2, maximum: 4 },
  }, required: ["enabled", "maxRetries", "multiplier"] }, "budgetRetry");
  const ids = new Set();
  for (const client of infra.clients || []) {
    if (!client.id || ids.has(client.id) || !["admin", "agent", "dispatcher", "reader"].includes(client.role) ||
        typeof client.tokenFile !== "string" || !client.tokenFile.startsWith("/") ||
        client.role !== "admin" && !Array.isArray(client.repositories)) fail("Invalid infrastructure client");
    ids.add(client.id);
  }
  for (const org of infra.organizations || []) if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(org.name)) fail("Invalid organization");
  for (const repository of [...config.repositories, ...(infra.organizations || [])]) {
    for (const key of ["requiresAgent", "allowSkip", "agentFallback"]) if (repository[key] !== undefined && typeof repository[key] !== "boolean") fail(`Invalid ${key}`);
    if (repository.minimumEffort && !["low", "medium", "high"].includes(repository.minimumEffort)) fail("Invalid minimumEffort");
    if (repository.reviewDefaults) validate(repository.reviewDefaults, schema, "reviewDefaults");
  }
  for (const profile of Object.values(infra.profiles || {})) validate(profile, schema, "profile");
}
function executionOptions(settings) {
  if (!settings) return {};
  const result = { ...settings.options, provider: settings.resolvedProvider, preview: settings.preview === true };
  for (const [key, entry] of Object.entries(settings.resources || {})) {
    if (crypto.createHash("sha256").update(fs.readFileSync(entry.file)).digest("hex") !== entry.digest) fail(`Configured ${key} changed; submit a new task`, 409);
    result[key === "ruleSet" ? "rule" : "tools"] = entry.file;
  }
  return result;
}
function cliArguments(options = {}) {
  const flags = { effort: "effort", maxTokens: "max-tokens", maxTools: "max-tools", maxGitProcs: "max-git-procs", exclude: "exclude", rule: "rule", tools: "tools" };
  const args = [];
  for (const [key, flag] of Object.entries(flags)) if (options[key] !== undefined) args.push(`--${flag}`, String(options[key]));
  if (options.noFilter) args.push("--no-filter");
  if (options.preview) args.push("--preview");
  return args;
}
module.exports = { schema, presets, resolveOptions, executionOptions, cliArguments, validate, validateInfrastructure, fail };
