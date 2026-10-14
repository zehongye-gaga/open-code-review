// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const { fingerprint, planReview, readProgress, checkpointFor } = require("./progress.js");

const base = "a".repeat(40), head = "b".repeat(40), next = "c".repeat(40);
const sessionId = "11111111-2222-3333-4444-555555555555";
const identity = "1".repeat(64);
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-progress-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const metadata = { number: 1, head: next, base, base_ref: "main", merge_base: base, background: "Requirements" };
  const checkpoint = { findings: 0, payload: { v: 1, pr: 1, head, base_ref: "main", merge_base: base,
    terminal_state: "complete", fingerprint: identity, run: "previous-job" } };
  const config = { binary: path.join(directory, "ocr"), provider: "openai-codex", model: "gpt-test", budget: 0, fetchTimeoutSeconds: 5 };
  fs.writeFileSync(config.binary, "binary-v1");
  fs.writeFileSync(path.join(directory, "metadata.json"), JSON.stringify(metadata));
  return { directory, cwd: directory, metadata, checkpoint, config, job: { number: 1, id: 42 }, identify: async () => identity,
    isAncestor: async () => 0 };
}

test("checkpoint chains advance only after complete coverage of each immutable range", async (t) => {
  const h = fixture(t);
  const planned = await planReview(h);
  assert.equal(planned.metadata.range.mode, "checkpoint");
  assert.equal(planned.metadata.range.from, head);
  assert.equal(planned.metadata.range.to, next);
  const item = { item_id: "file", fingerprint: "diff" };
  const result = { session_id: sessionId, status: "complete", comments: [], manifest: {
    schema_version: "ocr.run-manifest/v1", operation: "review", run_id: sessionId, terminal_state: "complete",
    input: { mode: "range", resolved_base: head, resolved_head: next },
    coverage: { selected: [item], completed: [], reused: [item], failed: [], waived: [] } } };
  const save = () => fs.writeFileSync(path.join(h.directory, "result.json"), JSON.stringify(result));
  save(); fs.writeFileSync(path.join(h.directory, "exit-code.json"), "0");
  let progress = readProgress(h.directory, planned.metadata);
  assert.equal(progress.complete, true);
  const advanced = checkpointFor(h.job, planned.metadata, progress);
  assert.equal(advanced.payload.head, next);
  fs.unlinkSync(path.join(h.directory, "exit-code.json"));
  const unconfirmed = readProgress(h.directory, planned.metadata);
  assert.equal(unconfirmed.sessionId, sessionId);
  assert.equal(unconfirmed.complete, false);
  assert.equal(checkpointFor(h.job, planned.metadata, unconfirmed), null);
  fs.writeFileSync(path.join(h.directory, "exit-code.json"), "0");
  result.manifest.coverage.reused = [null]; save();
  assert.equal(readProgress(h.directory, planned.metadata), null);
  result.manifest.coverage.reused = [item]; save();
  fs.writeFileSync(path.join(h.directory, "metadata.json"), JSON.stringify({ ...h.metadata, head: "d".repeat(40) }));
  assert.equal((await planReview({ ...h, checkpoint: advanced })).metadata.range.from, next);
  result.manifest.coverage.failed = [item]; result.manifest.coverage.reused = [];
  result.status = "partial"; result.manifest.terminal_state = "partial";
  save();
  progress = readProgress(h.directory, planned.metadata);
  assert.equal(progress.complete, false);
  assert.equal(progress.sessionId, sessionId);
  assert.equal(checkpointFor(h.job, planned.metadata, progress), null);
  result.manifest.input.resolved_base = base; save();
  assert.equal(readProgress(h.directory, planned.metadata), null);
});

test("findings, changed rules/base, force pushes and manual reruns require a full review", async (t) => {
  const h = fixture(t);
  const scenarios = [
    { checkpoint: { ...h.checkpoint, findings: 1 }, reason: "unresolved_findings" },
    { checkpoint: { ...h.checkpoint, payload: { ...h.checkpoint.payload, base_ref: "other" } }, reason: "base_changed" },
    { checkpoint: { ...h.checkpoint, payload: { ...h.checkpoint.payload, merge_base: "d".repeat(40) } }, reason: "base_changed" },
    { identify: async () => "2".repeat(64), reason: "config_changed" },
    { isAncestor: async () => 1, reason: "not_ancestor" },
    { isAncestor: async () => 128, reason: "unknown_object" },
    { isAncestor: async () => { throw new Error("git failure"); }, reason: "resolver_error" },
    { job: { fullReview: true }, reason: "manual_full_review" },
    { checkpoint: { ...h.checkpoint, payload: { ...h.checkpoint.payload, pr: 99 } }, reason: "schema_invalid" },
  ];
  for (const scenario of scenarios) {
    const { metadata } = await planReview({ ...h, ...scenario });
    assert.equal(metadata.range.mode, "full", scenario.reason);
    assert.equal(metadata.range.reason, scenario.reason);
    assert.equal(metadata.range.from, base);
  }
});

test("retry pins its original range and session even if a newer checkpoint exists", async (t) => {
  const h = fixture(t);
  const progress = { fingerprint: identity, sessionId, selected: 1, workspace: h.cwd, head: next, base,
    range: { mode: "full", from: base, to: next } };
  const planned = await planReview({ ...h, job: { progress } });
  assert.equal(planned.resume, sessionId);
  assert.equal(planned.metadata.range.from, base);
  assert.equal(planned.metadata.range.reason, "retry");
  assert.equal((await planReview({ ...h, job: { progress: { ...progress, workspace: "/other-worker" } } })).resume, undefined);
  const changed = await planReview({ ...h, job: { progress }, identify: async () => "2".repeat(64) });
  assert.equal(changed.resume, undefined);
  assert.equal(changed.metadata.range.mode, "full");
});

test("the real Git ancestry gate accepts descendants and rejects unrelated heads", async (t) => {
  const h = fixture(t);
  const git = (...args) => execFileSync("git", args, { cwd: h.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  git("commit", "--allow-empty", "-m", "Base");
  const baseline = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-m", "Reviewed");
  const reviewed = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-m", "New change");
  const current = git("rev-parse", "HEAD");
  const checkpoint = { ...h.checkpoint, payload: { ...h.checkpoint.payload, head: reviewed, merge_base: baseline } };
  const metadata = { ...h.metadata, head: current, base: baseline, merge_base: baseline };
  fs.writeFileSync(path.join(h.directory, "metadata.json"), JSON.stringify(metadata));
  assert.equal((await planReview({ ...h, checkpoint, isAncestor: undefined })).metadata.range.from, reviewed);
  git("checkout", "--orphan", "force-pushed"); git("commit", "--allow-empty", "-m", "Unrelated");
  fs.writeFileSync(path.join(h.directory, "metadata.json"), JSON.stringify({ ...metadata, head: git("rev-parse", "HEAD") }));
  assert.equal((await planReview({ ...h, checkpoint, isAncestor: undefined })).metadata.range.reason, "not_ancestor");
});

test("configuration fingerprints include binary, background, base, model and referenced global rules", async (t) => {
  const h = fixture(t), env = { HOME: h.directory };
  const options = { ...h, env };
  const original = await fingerprint(options);
  assert.equal(await fingerprint(options), original);
  for (const changed of [
    { config: { ...h.config, model: "other" } },
    { metadata: { ...h.metadata, background: "Changed requirements" } },
    { metadata: { ...h.metadata, base: head } },
    { env: { ...env, OCR_LLM_EXTRA_BODY: "changed" } },
  ]) assert.notEqual(await fingerprint({ ...options, ...changed }), original);
  const rules = path.join(h.directory, ".opencodereview"); fs.mkdirSync(rules);
  fs.writeFileSync(path.join(rules, "rule.json"), JSON.stringify({ rules: [{ path: "**", rule: "shared.md" }] }));
  fs.writeFileSync(path.join(rules, "shared.md"), "Old rules");
  const withRules = await fingerprint(options);
  fs.writeFileSync(path.join(rules, "shared.md"), "New rules");
  assert.notEqual(await fingerprint(options), withRules);
  const beforeBinaryChange = await fingerprint(options);
  fs.writeFileSync(h.config.binary, "binary-v2");
  assert.notEqual(await fingerprint(options), beforeBinaryChange);
  const beforeOAuth = await fingerprint(options);
  fs.writeFileSync(path.join(h.directory, "auth.json"), "refreshed credentials");
  assert.equal(await fingerprint(options), beforeOAuth);
});
