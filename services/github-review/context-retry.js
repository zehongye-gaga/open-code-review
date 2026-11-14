// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_MAX_TOKENS = 200000;
const MAX_CONTEXT_ATTEMPTS = 3;
const MAX_ALLOWED_TOKENS = 1000000;

function contextRetryConfiguration(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["enabled", "maxTokens"].includes(key))) {
    throw new Error("contextRetry accepts enabled and maxTokens");
  }
  const policy = { enabled: true, maxTokens: MAX_ALLOWED_TOKENS, ...value };
  if (typeof policy.enabled !== "boolean" || !Number.isSafeInteger(policy.maxTokens) ||
      policy.maxTokens < 1 || policy.maxTokens > MAX_ALLOWED_TOKENS) {
    throw new Error("Invalid contextRetry policy");
  }
  return policy;
}

function configuredMaxTokens(options, home = os.homedir()) {
  if (options.maxTokens !== undefined) return options.maxTokens;
  let config;
  try { config = JSON.parse(fs.readFileSync(path.join(home, ".opencodereview", "config.json"), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return DEFAULT_MAX_TOKENS;
    throw new Error("Cannot read native max_tokens configuration", { cause: error });
  }
  if (config?.max_tokens == null || config.max_tokens === 0) return DEFAULT_MAX_TOKENS;
  if (!Number.isSafeInteger(config.max_tokens) || config.max_tokens < 1) throw new Error("Invalid native max_tokens configuration");
  return config.max_tokens;
}

function contextSettings(settings, override) {
  if (override == null) return settings || null;
  return { ...settings, options: { ...settings?.options, maxTokens: override } };
}

function contextTokenLimit(config, repository) {
  const limits = [MAX_ALLOWED_TOKENS, config.contextRetry.maxTokens,
    config.infrastructure?.limits?.maxTokens, repository?.limits?.maxTokens].filter(value => value !== undefined);
  if (limits.some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error("Invalid maxTokens policy limit");
  return Math.min(...limits);
}

function nextContextRetry(job, config, repository, failure) {
  if (!failure?.contextExceeded || !config.contextRetry.enabled || job.settings?.preview || job.replacement) return null;
  const attempt = job.nativeAttempts ?? job.attempt;
  if (attempt >= MAX_CONTEXT_ATTEMPTS) return null;
  const from = job.effectiveMaxTokens;
  if (!Number.isSafeInteger(from) || from < 1) throw new Error("The executed context ceiling is unavailable; cannot safely double it");
  if (failure.maxTokens != null && failure.maxTokens !== from) throw new Error("The observed context ceiling differs from the executed configuration");
  const to = from * 2, limit = contextTokenLimit(config, repository);
  if (!Number.isSafeInteger(to) || to > limit) throw new Error(`Context expansion ${from} -> ${to} exceeds the configured maxTokens limit ${limit}`);
  return { attempt, from, to, previousOverride: job.retryMaxTokens ?? null,
    at: new Date().toISOString(), directory: job.directory, sessionId: failure.sessionId,
    reason: failure.message, failures: failure.failures, artifacts: failure.artifacts || [], maxAttempts: MAX_CONTEXT_ATTEMPTS };
}

module.exports = { contextRetryConfiguration, configuredMaxTokens, contextSettings, contextTokenLimit,
  nextContextRetry, MAX_CONTEXT_ATTEMPTS };
