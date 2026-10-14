// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { resolveCheckpointRange } = require("../../scripts/github-actions/post-review-comments.js");

const exec = promisify(execFile);
const UUID = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{40}$/;
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function fileDigest(file) {
  try { return digest(fs.readFileSync(file)); }
  catch (error) { if (error.code === "ENOENT") return "absent"; throw error; }
}

function globalRules(home) {
  const file = path.join(home, ".opencodereview", "rule.json");
  const identity = [fileDigest(file)];
  if (identity[0] === "absent") return identity;
  const rules = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const entry of rules.rules || []) {
    if (typeof entry.rule === "string" && !/[ \n]/.test(entry.rule) && /\.(md|txt|markdown)$/i.test(entry.rule)) {
      identity.push(fileDigest(path.resolve(path.dirname(file), entry.rule)));
    }
  }
  return identity;
}

async function fingerprint({ config, metadata, cwd, env = process.env }) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(config.binary)) hash.update(chunk);
  const home = env.HOME || os.homedir();
  // Base checkout is immutable, including project rules and their referenced files.
  // OAuth credentials are deliberately absent: token refresh is not a rule change.
  return digest(JSON.stringify(["ocr-service-progress/v1", hash.digest("hex"), metadata.base,
    metadata.background, config.provider, config.model, config.budget,
    fileDigest(path.join(home, ".opencodereview", "config.json")), globalRules(home),
    fileDigest(path.join(cwd, ".opencodereview", "rule.json")),
    Object.entries(env).filter(([key]) => key.startsWith("OCR_LLM_")).sort(([a], [b]) => a.localeCompare(b))]));
}

async function planReview({ config, job, checkpoint, directory, cwd, signal, identify = fingerprint, isAncestor }) {
  const file = path.join(directory, "metadata.json");
  const metadata = JSON.parse(fs.readFileSync(file, "utf8"));
  const identity = await identify({ config, metadata, cwd });
  const previous = job.progress;
  let range;
  if (previous?.fingerprint === identity && previous.head === metadata.head && previous.base === metadata.base) {
    range = { ...previous.range, reason: "retry" };
  } else if (checkpoint && checkpoint.findings !== 0) {
    range = { mode: "full", reason: "unresolved_findings" };
  } else {
    range = await resolveCheckpointRange({ enabled: true, fullReview: job.fullReview,
      prNumber: metadata.number, headSha: metadata.head, baseRef: metadata.base_ref,
      mergeBase: metadata.merge_base, fingerprint: identity,
      read: checkpoint ? { reason: "ok", payload: checkpoint.payload } : { reason: "no_checkpoint" },
      isAncestor: isAncestor || (async (from, to) => {
        try {
          await exec("git", ["-c", "core.hooksPath=/dev/null", "merge-base", "--is-ancestor", from, to],
            { cwd, signal, timeout: config.fetchTimeoutSeconds * 1000 });
          return 0;
        } catch (error) { return Number.isInteger(error.code) ? error.code : -1; }
      }),
    });
    // Explicit reruns should revalidate the same head instead of reviewing an empty range.
    if (range.reason === "same_head_noop") range = { mode: "full", reason: "same_head_rerun" };
  }
  metadata.range = { ...range, from: range.mode === "checkpoint" ? range.from : metadata.merge_base, to: metadata.head };
  metadata.fingerprint = identity;
  fs.writeFileSync(file, JSON.stringify(metadata, null, 2), { mode: 0o600 });
  return { metadata, resume: previous?.fingerprint === identity && previous.workspace === cwd && previous.selected > 0 ? previous.sessionId : undefined };
}

function readProgress(directory, metadata) {
  let result, exitCode = 1;
  try {
    result = JSON.parse(fs.readFileSync(path.join(directory, "result.json"), "utf8"));
  } catch { return null; }
  // A supervisor crash can leave the native report but no recorded process exit.
  // Its session remains resumable; it cannot certify a completed checkpoint yet.
  try { exitCode = JSON.parse(fs.readFileSync(path.join(directory, "exit-code.json"), "utf8")); } catch { /* Unknown exit. */ }
  const m = result?.manifest, coverage = m?.coverage;
  if (m?.schema_version !== "ocr.run-manifest/v1" || m.operation !== "review" ||
      !UUID.test(result.session_id) || result.session_id !== m.run_id || m.input?.mode !== "range" ||
      m.input.resolved_head !== metadata.head || m.input.resolved_base !== metadata.range.from ||
      !SHA.test(metadata.range.from) || !Array.isArray(result.comments) ||
      !Array.isArray(coverage?.selected) || !Array.isArray(coverage?.completed) ||
      !Array.isArray(coverage?.reused) || !Array.isArray(coverage?.failed) || !Array.isArray(coverage?.waived)) return null;
  for (const name of ["selected", "completed", "reused", "failed", "waived"]) {
    if (coverage[name].some((item) => !item || typeof item.item_id !== "string" || !item.item_id)) return null;
  }
  const covered = new Set([...coverage.completed, ...coverage.reused].map((item) => item.item_id));
  const complete = exitCode === 0 && result.status === "complete" && m.terminal_state === "complete" &&
    !m.run_failure && coverage.selected.length > 0 && coverage.failed.length === 0 && coverage.waived.length === 0 &&
    coverage.selected.every((item) => item.item_id && covered.has(item.item_id));
  const skipped = exitCode === 0 && result.status === "skipped" && m.terminal_state === "skipped" &&
    !m.run_failure && Object.values(coverage).every((items) => Array.isArray(items) && items.length === 0);
  return { sessionId: result.session_id, selected: coverage.selected.length, complete, skipped,
    budgetExceeded: result.summary?.budget_exceeded === true,
    findings: result.comments.length, head: metadata.head, base: metadata.base,
    range: metadata.range, fingerprint: metadata.fingerprint, directory };
}

function checkpointFor(job, metadata, progress) {
  if (!progress?.complete || !metadata.fingerprint || !metadata.base_ref) return null;
  return { findings: progress.findings, createdAt: new Date().toISOString(),
    payload: { v: 1, pr: job.number, head: metadata.head, base_ref: metadata.base_ref,
      merge_base: metadata.merge_base, terminal_state: "complete", fingerprint: metadata.fingerprint, run: String(job.id) } };
}

module.exports = { fingerprint, planReview, readProgress, checkpointFor };
