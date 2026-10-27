// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { runPostReviewComments } = require("../../scripts/github-actions/post-review-comments.js");

const exec = promisify(execFile);
const { cliArguments } = require("./options.js");
const { publishRoundSummary } = require("./round-summary.js");
const SHA = /^[0-9a-f]{40}$/;

function childEnvironment(source = process.env) {
  const names = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "CODEX_HOME",
    "XDG_CONFIG_HOME", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE",
    "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"];
  return Object.fromEntries(Object.entries(source).filter(([key]) => names.includes(key) || key.startsWith("OCR_LLM_")));
}

async function resolvePullRequest({ github, context, core, prNumber }) {
  if (!/^[1-9][0-9]*$/.test(String(prNumber)) || !Number.isSafeInteger(Number(prNumber))) {
    throw new Error("A positive integer pull request number is required");
  }
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: Number(prNumber) });
  if (pr.state !== "open" || (pr.draft && !context.allowDraft)) {
    core.notice("Skipping a closed or draft pull request");
    return null;
  }
  if (context.eventName === "pull_request_target" && context.payload?.pull_request?.head?.sha !== pr.head?.sha) {
    core.notice("Skipping an event superseded by a newer PR head");
    return null;
  }
  if (!SHA.test(pr.head?.sha) || !SHA.test(pr.base?.sha) ||
      pr.base?.repo?.full_name?.toLowerCase() !== `${context.repo.owner}/${context.repo.repo}`.toLowerCase()) {
    throw new Error("The PR does not have a valid head and base in this repository");
  }
  return {
    number: Number(prNumber), head: pr.head.sha, base: pr.base.sha, base_ref: pr.base.ref,
    background: `Pull request #${prNumber}: ${pr.title}\n\n${pr.body || ""}`.slice(0, 50000),
  };
}

async function prepareReview({ github, context, core, prNumber, cwd = process.cwd(),
  temp, token, checkoutBase = false, signal, expectedHead, expectedBase, expectedBaseRef, snapshot, gitTimeoutMs = 600000 }) {
  core.setOutput("should_review", "false");
  const metadata = snapshot ? { ...snapshot } : await resolvePullRequest({ github, context, core, prNumber });
  if (!metadata) return;
  if ((expectedHead && metadata.head !== expectedHead) || (expectedBase && metadata.base !== expectedBase) ||
      (expectedBaseRef && metadata.base_ref !== expectedBaseRef)) return;
  if (!temp || !path.isAbsolute(temp)) throw new Error("Review storage must be an absolute directory");

  // Git receives its short-lived credential only for fetch, never via argv or a config file.
  const gitEnv = { ...childEnvironment(), GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  if (token) {
    gitEnv.GIT_CONFIG_COUNT = "1";
    gitEnv.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    gitEnv.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  }
  const git = async (args) => (await exec("git", ["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false", ...args], { cwd, env: gitEnv, timeout: gitTimeoutMs, signal })).stdout.trim();
  if (!fs.existsSync(path.join(cwd, ".git"))) {
    await git(["init"]);
    await git(["remote", "add", "origin", `https://github.com/${context.repo.owner}/${context.repo.repo}.git`]);
  }
  if (snapshot) {
    if (!SHA.test(metadata.base) || !SHA.test(metadata.head)) throw new Error("Invalid saved snapshot");
    try {
      await git(["cat-file", "-e", `${metadata.base}^{commit}`]);
      await git(["cat-file", "-e", `${metadata.head}^{commit}`]);
    } catch (error) {
      if (signal?.aborted) throw error;
      await git(["fetch", "--no-tags", "--no-recurse-submodules", "origin", metadata.base, metadata.head]);
    }
  } else {
    await git(["fetch", "--no-tags", "--no-recurse-submodules", "origin",
      `+${metadata.base}:refs/ocr/base`, `+refs/pull/${metadata.number}/head:refs/ocr/head`]);
    if (await git(["rev-parse", "refs/ocr/head"]) !== metadata.head) {
      core.notice("The PR changed during fetch; its newer event will review the new head");
      return;
    }
  }
  metadata.merge_base = await git(["merge-base", metadata.base, metadata.head]);
  if (!SHA.test(metadata.merge_base)) throw new Error("Could not resolve the PR merge base");
  if (checkoutBase) {
    await git(["checkout", "--force", "--detach", metadata.base]);
    await git(["clean", "-ffdqx"]);
  }

  const directory = fs.mkdtempSync(path.join(temp, "ocr-pr-"));
  metadata.telemetry = { repository: `${context.repo.owner}/${context.repo.repo}`.toLowerCase(),
    jobId: String(context.runId), attempt: context.runAttempt, workspace: cwd,
    preparedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(directory, "metadata.json"), JSON.stringify(metadata, null, 2), { mode: 0o600 });
  core.setOutput("result_directory", directory);
  core.setOutput("should_review", "true");
  core.info(`Reviewing PR #${metadata.number}: ${metadata.merge_base}..${metadata.head}`);
}

async function runReview({ core, directory, binary = "/usr/local/bin/ocr", cwd = process.cwd(),
  model = process.env.OCR_CODEX_MODEL || "gpt-6-astra",
  budget = process.env.OCR_MAX_TOKENS_BUDGET || "0", provider = "openai-codex",
  signal, timeoutMs = 25 * 60 * 1000, resume, requireResume = false, onResumeFallback, onFreshStart, options = {} }) {
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, "metadata.json"), "utf8"));
  const from = metadata.range?.from || metadata.merge_base;
  if (!SHA.test(metadata.head) || !SHA.test(from)) throw new Error("Invalid review range");
  if (requireResume && !resume) throw Object.assign(new Error("Budget recovery requires a compatible saved session"), { retryable: false, code: "RESUME_REQUIRED" });
  if (resume && !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(resume)) throw new Error("Invalid resume session");
  if (!/^(0|[1-9][0-9]*)$/.test(String(budget)) || !Number.isSafeInteger(Number(budget))) {
    throw new Error("OCR_MAX_TOKENS_BUDGET must be a non-negative integer");
  }
  if (metadata.incrementalExclude?.length) {
    options = { ...options, exclude: [options.exclude, ...metadata.incrementalExclude].filter(Boolean).join(",") };
  }
  if (metadata.documentationFallback && !options.rule) {
    const rule = path.join(directory, "documentation-rule.json");
    fs.writeFileSync(rule, JSON.stringify({ rules: [], include: ["*.md", "**/*.md", "*.markdown", "**/*.markdown"] }), { mode: 0o600 });
    options = { ...options, rule };
  }
  const stdout = fs.openSync(path.join(directory, "result.json"), "w", 0o600);
  const stderr = fs.openSync(path.join(directory, "stderr.log"), "w", 0o600);
  const env = childEnvironment();
  if (options.requestTimeoutSeconds) env.OCR_LLM_TIMEOUT = String(options.requestTimeoutSeconds);
  let code = 1, startError;
  try {
    code = await new Promise((resolve, reject) => {
      const child = spawn(binary, ["review", "--repo", cwd, "--from", from,
        "--to", metadata.head, "--provider", provider, "--model", model,
        "--audience", "agent", "--format", "json", "--concurrency", String(options.concurrency || 2), "--timeout", String(options.timeout || 15),
        "--max-tokens-budget", String(budget), "--background", metadata.background,
        ...cliArguments(options), ...(resume && !options.preview ? ["--resume", resume] : [])],
      { cwd, env, stdio: ["ignore", stdout, stderr] });
      let forceTimer, terminating = false;
      const terminate = () => {
        // A second SIGTERM makes native OCR exit before flushing its manifest.
        if (terminating) return;
        terminating = true;
        child.kill("SIGTERM");
        forceTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
        forceTimer.unref();
      };
      const timer = setTimeout(terminate, timeoutMs);
      if (signal?.aborted) terminate();
      else signal?.addEventListener("abort", terminate, { once: true });
      child.once("error", reject);
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        clearTimeout(forceTimer);
        signal?.removeEventListener("abort", terminate);
        if (startError) reject(startError);
        else resolve(exitCode === null ? 1 : exitCode);
      });
      try { if (!resume && child.pid && onFreshStart) onFreshStart(child.pid); }
      catch (error) { startError = error; terminate(); }
    });
  } catch (error) {
    if (startError || error.persistence) throw error;
    fs.writeSync(stderr, `Could not run installed OCR: ${error.message}\n`);
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
  fs.writeFileSync(path.join(directory, "exit-code.json"), JSON.stringify(code));
  core.info(`OCR exited with code ${code}; report and diagnostics are saved in the job directory`);
  if (code === 0 && !signal?.aborted && !requireResume && !options.preview && !options.rule && !metadata.documentationFallback) {
    const report = JSON.parse(fs.readFileSync(path.join(directory, "result.json"), "utf8"));
    if (report.status === "skipped" && report.manifest?.terminal_state === "skipped") {
      const { stdout: changed } = await exec("git", ["-c", "core.hooksPath=/dev/null", "diff", "--name-only", "--diff-filter=AMRT", "-z", from, metadata.head, "--"],
        { cwd, signal, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
      const paths = changed.split("\0").filter(Boolean);
      if (paths.length && paths.every((name) => /\.(md|markdown)$/i.test(name))) {
        for (const name of ["result.json", "stderr.log", "exit-code.json"]) {
          fs.renameSync(path.join(directory, name), path.join(directory, `documentation-skipped-${name}`));
        }
        metadata.documentationFallback = true;
        fs.writeFileSync(path.join(directory, "metadata.json"), JSON.stringify(metadata, null, 2), { mode: 0o600 });
        core.notice("Retrying the unchanged documentation-only range with Markdown enabled; explicit exclusions still apply");
        return runReview({ core, directory, binary, cwd, model, budget, provider, signal, timeoutMs, onResumeFallback, onFreshStart, options });
      }
    }
  }
  if (resume && code !== 0 && !signal?.aborted && fs.statSync(path.join(directory, "result.json")).size === 0 &&
      /^Error: (load resume session:|resume rejected:|resume session ")/m.test(fs.readFileSync(path.join(directory, "stderr.log"), "utf8"))) {
    if (requireResume && !onResumeFallback) throw Object.assign(new Error("Budget recovery session was rejected; recovery must be recorded before a full rerun"), { retryable: false, code: "RESUME_REJECTED" });
    if (onResumeFallback) await onResumeFallback("native_resume_rejected");
    for (const name of ["result.json", "stderr.log", "exit-code.json"]) {
      fs.renameSync(path.join(directory, name), path.join(directory, `resume-rejected-${name}`));
    }
    core.notice("The saved session could not be resumed; starting this snapshot afresh");
    if (metadata.incrementalExclude?.length) options = { ...options, exclude: options.exclude.split(",").filter((p) => !metadata.incrementalExclude.includes(p)).join(",") };
    return runReview({ core, directory, binary, cwd, model, budget, provider, signal, timeoutMs, onResumeFallback, onFreshStart, options });
  }
}

async function publishReview({ github, context, core, directory, blockSeverity = "high", post = runPostReviewComments }) {
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, "metadata.json"), "utf8"));
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: metadata.number });
  if (pr.state !== "open" || (pr.draft && !context.allowDraft) || pr.head.sha !== metadata.head || pr.base.sha !== metadata.base ||
      (metadata.base_ref && pr.base.ref !== metadata.base_ref)) {
    core.notice("Skipping publication because the PR changed or closed during review");
    return { stale: true };
  }
  const resultPath = path.join(directory, "result.json");
  let result;
  try { result = JSON.parse(fs.readFileSync(resultPath, "utf8")); } catch { /* The publisher reports missing output. */ }
  if (result?.manifest?.input?.resolved_head && result.manifest.input.resolved_head !== metadata.head) {
    core.setFailed("OCR returned a result for a different head; no comments were published");
    return;
  }
  let failedComments = 0;
  let publicationFailures;
  let summaryURL = "";
  let exitCode = 1;
  try { exitCode = JSON.parse(fs.readFileSync(path.join(directory, "exit-code.json"), "utf8")); } catch { /* Missing execution is a failure. */ }
  const verified = result?.manifest?.input?.resolved_head === metadata.head && Array.isArray(result.comments) &&
    (!metadata.range || result.manifest.input.resolved_base === metadata.range.from);
  const skipped = verified && result?.status === "skipped" && result?.manifest?.terminal_state === "skipped";
  const complete = verified && result?.status === "complete" && result?.manifest?.terminal_state === "complete";
  const incomplete = exitCode !== 0 || (!complete && !skipped);
  let publicationPath = resultPath;
  if (!verified) {
    publicationPath = path.join(directory, "publication-error.json");
    fs.writeFileSync(publicationPath, JSON.stringify({ comments: [],
      message: "The review did not produce a verifiable result. Check the service job diagnostics." }), { mode: 0o600 });
  }
  await post({
    github, context, fs, prNumber: metadata.number, resultPath: publicationPath, stderrPath: path.join(directory, "stderr.log"),
    stickySummary: true, incremental: true,
    summaryPublisher: (args) => publishRoundSummary({ ...args, metadata, result, blockSeverity, incomplete, skipped, runId: context.runId }),
    checkpointEnabled: Boolean(metadata.fingerprint), checkpointBaseRef: metadata.base_ref,
    checkpointMergeBase: metadata.merge_base, checkpointFingerprint: metadata.fingerprint,
    rangeMode: metadata.range?.mode, rangeTo: metadata.head,
    reviewIncomplete: incomplete, reviewSkipped: skipped && !incomplete,
    core: { ...core, setOutput(name, value) {
      if (name === "comments_failed") failedComments = Number(value);
      if (name === "publication_failures") publicationFailures = Number(value);
      if (name === "summary_comment_url") summaryURL = value;
      core.setOutput(name, value);
    } },
  });
  failedComments = publicationFailures ?? failedComments;
  if (incomplete || failedComments > 0 || !summaryURL) {
    core.setFailed("Review or publication was incomplete; inspect the summary and saved artifacts");
  }
  return { incomplete: incomplete || failedComments > 0 || !summaryURL, skipped, summaryURL,
    comments: Array.isArray(result?.comments) ? result.comments : [],
    budgetExceeded: result?.summary?.budget_exceeded === true };
}

module.exports = { resolvePullRequest, prepareReview, runReview, publishReview, childEnvironment };
