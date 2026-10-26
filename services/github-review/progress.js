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

async function fingerprint({ config, metadata, cwd, env = process.env, forCheckpoint = false }) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(config.binary)) hash.update(chunk);
  const home = env.HOME || os.homedir();
  const settings = structuredClone(config.reviewSettings || null);
  if (forCheckpoint && settings) {
    for (const key of ["budget", "background", "fullReview"]) delete settings.options?.[key];
  }
  // Base checkout is immutable, including project rules and their referenced files.
  // OAuth credentials are deliberately absent: token refresh is not a rule change.
  return digest(JSON.stringify(["ocr-service-progress/v1", hash.digest("hex"), metadata.base,
    forCheckpoint ? "checkpoint/v2" : metadata.background, config.provider, config.model, forCheckpoint ? null : config.budget, settings,
    fileDigest(path.join(home, ".opencodereview", "config.json")), globalRules(home),
    fileDigest(path.join(cwd, ".opencodereview", "rule.json")),
    Object.entries(env).filter(([key]) => key.startsWith("OCR_LLM_")).sort(([a], [b]) => a.localeCompare(b))]));
}

async function planReview({ config, job, checkpoint, directory, cwd, signal, identify = fingerprint, isAncestor }) {
  const file = path.join(directory, "metadata.json");
  const metadata = JSON.parse(fs.readFileSync(file, "utf8"));
  const identity = await identify({ config, metadata, cwd });
  const checkpointIdentity = await identify({ config, metadata, cwd, forCheckpoint: true });
  const previous = job.progress;
  let compatible = previous?.fingerprint === identity;
  if (!compatible && previous?.budgetExceeded) {
    const increase = (job.budgetRetries || []).find((retry) => retry.directory === previous.directory &&
      retry.reason === "native_budget_guard" && Number.isSafeInteger(retry.from) && retry.from > 0 &&
      retry.to === config.budget && (retry.to === 0 || retry.to > retry.from));
    // A recorded budget increase changes capacity, not completed review evidence.
    if (increase) compatible = previous.fingerprint === await identify({
      config: { ...config, budget: increase.from }, metadata, cwd,
    });
  }
  compatible &&= previous?.head === metadata.head && previous?.base === metadata.base;
  if (!compatible) delete metadata.incrementalExclude;
  let range;
  if (compatible && previous.documentationFallback) metadata.documentationFallback = true;
  if (compatible) {
    range = { ...previous.range, reason: "retry" };
  } else {
    range = await resolveCheckpointRange({ enabled: true, fullReview: job.fullReview,
      prNumber: metadata.number, headSha: metadata.head, baseRef: metadata.base_ref,
      mergeBase: metadata.merge_base, fingerprint: checkpointIdentity,
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
  if (!compatible && range.mode === "checkpoint" && checkpoint.findings !== 0) {
    if (!Array.isArray(checkpoint.findingPaths) || checkpoint.findingPaths.length === 0) {
      range = { mode: "full", reason: "missing_finding_paths" };
    } else {
      const diffPaths = async (from) => (await exec("git", ["-c", "core.hooksPath=/dev/null", "diff",
        "--name-only", "--no-renames", "-z", from, metadata.head, "--"],
        { cwd, signal, timeout: config.fetchTimeoutSeconds * 1000, maxBuffer: 8 * 1024 * 1024 })).stdout.split("\0").filter(Boolean);
      try {
        const changed = await diffPaths(range.from), all = await diffPaths(metadata.merge_base);
        // Native excludes are case-insensitive globs; only encode literal safe paths.
        const keep = new Set([...changed, ...checkpoint.findingPaths].map((name) => name.toLowerCase()));
        const excluded = all.filter((name) => !keep.has(name.toLowerCase()));
        if (excluded.some((name) => !/^[a-zA-Z0-9_./ -]+$/.test(name)) || excluded.join(",").length > 24000) {
          range = { mode: "full", reason: "unsafe_incremental_paths" };
        } else {
          metadata.incrementalExclude = excluded;
          range = { ...range, mode: "incremental_files", reason: "changes_and_previous_findings", changedSince: range.from, excludedFiles: excluded.length, revalidateFiles: checkpoint.findingPaths.length };
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        range = { mode: "full", reason: "incremental_paths_unavailable" };
      }
    }
  }
  metadata.checkpointFingerprint = checkpointIdentity;
  metadata.range = { ...range, from: range.mode === "checkpoint" ? range.from : metadata.merge_base, to: metadata.head };
  metadata.fingerprint = identity;
  fs.writeFileSync(file, JSON.stringify(metadata, null, 2), { mode: 0o600 });
  return { metadata, resume: compatible && previous.workspace === cwd && previous.selected > 0 ? previous.sessionId : undefined };
}

function readProgress(directory, metadata) {
  let result, documentationFallback = false, exitCode = 1;
  try {
    result = JSON.parse(fs.readFileSync(path.join(directory, "result.json"), "utf8"));
  } catch { return null; }
  // A supervisor crash can leave the native report but no recorded process exit.
  // Its session remains resumable; it cannot certify a completed checkpoint yet.
  try { exitCode = JSON.parse(fs.readFileSync(path.join(directory, "exit-code.json"), "utf8")); } catch { /* Unknown exit. */ }
  try { documentationFallback = JSON.parse(fs.readFileSync(path.join(directory, "metadata.json"), "utf8")).documentationFallback === true; } catch { /* Older artifacts have no fallback metadata. */ }
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
  return { documentationFallback, sessionId: result.session_id, selected: coverage.selected.length, complete, skipped,
    budgetExceeded: result.summary?.budget_exceeded === true,
    findingPaths: result.comments.every((comment) => typeof comment.path === "string" && comment.path)
      ? [...new Set(result.comments.map((comment) => comment.path))] : [],
    findings: result.comments.length, head: metadata.head, base: metadata.base,
    range: metadata.range, fingerprint: metadata.fingerprint, directory };
}

function checkpointFor(job, metadata, progress) {
  if (!progress?.complete || !metadata.fingerprint || !metadata.base_ref) return null;
  return { findings: progress.findings, findingPaths: progress.findingPaths || [], createdAt: new Date().toISOString(),
    payload: { v: 1, pr: job.number, head: metadata.head, base_ref: metadata.base_ref,
      merge_base: metadata.merge_base, terminal_state: "complete", fingerprint: metadata.checkpointFingerprint || metadata.fingerprint, run: String(job.id) } };
}

module.exports = { fingerprint, planReview, readProgress, checkpointFor };
