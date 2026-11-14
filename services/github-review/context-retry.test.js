// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { contextRetryConfiguration, configuredMaxTokens, nextContextRetry, contextSettings } = require("./context-retry.js");

test("the executed ceiling follows native CLI, saved config and default precedence", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-context-config-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(configuredMaxTokens({}, home), 200000);
  fs.mkdirSync(path.join(home, ".opencodereview"));
  const file = path.join(home, ".opencodereview", "config.json");
  fs.writeFileSync(file, JSON.stringify({ max_tokens: 300000 }));
  assert.equal(configuredMaxTokens({}, home), 300000);
  assert.equal(configuredMaxTokens({ maxTokens: 400000 }, home), 400000);
  fs.writeFileSync(file, JSON.stringify({ max_tokens: 0 }));
  assert.equal(configuredMaxTokens({}, home), 200000);
  fs.writeFileSync(file, JSON.stringify({ max_tokens: -1 }));
  assert.throws(() => configuredMaxTokens({}, home), /Invalid native max_tokens/);
});

test("context expansion doubles the effective ceiling and stops at the third execution", () => {
  const config = { contextRetry: contextRetryConfiguration() };
  const failure = { contextExceeded: true, maxTokens: null, message: "raw context failure", failures: [], sessionId: "session" };
  let job = { attempt: 1, effectiveMaxTokens: 200000, directory: "/run-1" };
  const first = nextContextRetry(job, config, {}, failure);
  assert.equal(first.from, 200000); assert.equal(first.to, 400000); assert.equal(first.previousOverride, null);
  job = { ...job, attempt: 2, effectiveMaxTokens: 400000, retryMaxTokens: 400000 };
  const second = nextContextRetry(job, config, {}, failure);
  assert.equal(second.to, 800000); assert.equal(second.previousOverride, 400000);
  assert.equal(nextContextRetry({ ...job, attempt: 3 }, config, {}, failure), null);
  assert.equal(nextContextRetry(job, config, {}, { ...failure, contextExceeded: false }), null);
  assert.equal(nextContextRetry(job, { contextRetry: contextRetryConfiguration({ enabled: false }) }, {}, failure), null);
  assert.throws(() => nextContextRetry(job, config, { limits: { maxTokens: 600000 } }, failure), /400000 -> 800000.*600000/);
  assert.throws(() => nextContextRetry(job, config, {}, { ...failure, maxTokens: 200000 }), /differs/);
});

test("recovery does not mutate requested settings or accept an unbounded ceiling", () => {
  const settings = { profile: "deep", options: { budget: 0, maxTokens: 200000 } };
  const effective = contextSettings(settings, 400000);
  assert.equal(settings.options.maxTokens, 200000);
  assert.equal(effective.options.maxTokens, 400000);
  assert.equal(effective.options.budget, 0);
  assert.equal(contextSettings(undefined, null), null);
  for (const invalid of [null, { enabled: "yes" }, { maxTokens: 0 }, { maxTokens: 1000001 }, { maxAttempts: 5 }]) {
    assert.throws(() => contextRetryConfiguration(invalid), /contextRetry/);
  }
});
