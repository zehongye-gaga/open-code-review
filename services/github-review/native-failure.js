// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const contextReasons = new Set([
  "prompt exceeded the configured token budget",
  "stopped because context compression exceeded its threshold",
]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = value => typeof value === "string" && value.trim().length > 0;
const encoded = cwd => cwd.replace(/^([A-Za-z]):[\\/]/, "$1_").replace(/^[\\/]+/, "").replace(/[\\/]/g, "-");
const SESSION_SCAN_LIMIT = 64 * 1024 * 1024;
const DIAGNOSTIC_LIMIT = 512 * 1024;
const STDERR_LIMIT = 256 * 1024;
const MAX_FAILURES = 256;

function utf8Prefix(text, limit) {
  const bytes = Buffer.from(text);
  let end = Math.min(limit, bytes.length);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function contextError(message) {
  if (/\b(?:HTTP|status(?:[_ -]code)?|API error|error code)\W{0,8}(?:401|403|408|429|500|502|503|504)\b/i.test(message)) return false;
  if (/\b(?:unauthori[sz]ed|forbidden|rate[_ -]?limit(?:[_ -]exceeded)?|invalid.?api.?key|timeout|timed out|ECONN\w*|ENOTFOUND|fetch failed|network error|connection (?:reset|refused|closed))\b/i.test(message)) return false;
  return /context[_ -](?:length|window)[_ -]exceeded|maximum context length|(?:prompt|input) tokens?[^\n]{0,100}exceed|(?:prompt|input)[^\n]{0,100}(?:too long|context (?:length|window))/i.test(message);
}

async function readJSON(file, limit, onRead) {
  const stat = await fs.promises.stat(file);
  if (stat.size > limit) throw Error(`JSON artifact exceeds ${limit} bytes`);
  const text = await fs.promises.readFile(file, "utf8");
  if (onRead) onRead(file);
  return JSON.parse(text);
}

async function sessionRecords(file, visit, notice, onRead) {
  const limit = 8 * 1024 * 1024;
  const stat = await fs.promises.stat(file);
  if (!stat.isFile()) throw Error("Session artifact is not a regular file");
  const truncated = stat.size > SESSION_SCAN_LIMIT;
  let parts = [], size = 0, lineNumber = 0, oversized = false, complete = !truncated, readStarted = false;
  const consume = () => {
    lineNumber++;
    if (oversized) {
      complete = false;
      notice(`Session record ${lineNumber} exceeds ${limit} bytes; record was not loaded`, file);
    }
    else if (size) {
      const line = Buffer.concat(parts, size).toString("utf8");
      // Prompt and tool records contain source code, not failure diagnostics.
      if (/"type"\s*:\s*"(?:session_start|review_item_failed|llm_error)"/.test(line)) {
        let record;
        try { record = JSON.parse(line); }
        catch { complete = false; notice(`Invalid session diagnostic record at line ${lineNumber}`, file); }
        if (record) visit(record);
      }
    }
    parts = []; size = 0; oversized = false;
  };
  if (!stat.size) return complete;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 65536,
    end: Math.min(stat.size, SESSION_SCAN_LIMIT) - 1, signal: AbortSignal.timeout(5000) })) {
    if (!readStarted) { onRead(file); readStarted = true; }
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      const piece = chunk.subarray(start, end);
      size += piece.length;
      if (size > limit) { oversized = true; parts = []; }
      else parts.push(piece);
      if (newline === -1) break;
      consume(); start = newline + 1;
    }
  }
  if (size && !truncated) consume();
  if (truncated) notice(`Session scan exceeds ${SESSION_SCAN_LIMIT} bytes; remaining records were not loaded`, file);
  return complete;
}

async function stderrExcerpt(file) {
  const stat = await fs.promises.stat(file);
  if (!stat.isFile()) throw Error("Stderr artifact is not a regular file");
  const bytes = Buffer.alloc(Math.min(stat.size, STDERR_LIMIT));
  const handle = await fs.promises.open(file, "r");
  let offset = 0;
  try {
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
  } finally { await handle.close(); }
  const decoder = new StringDecoder("utf8"), truncated = stat.size > offset;
  return { text: decoder.write(bytes.subarray(0, offset)) + (truncated ? "" : decoder.end()), truncated };
}

function tokenCounts(text) {
  const match = /prompt tokens\s*\((\d+)\)\s*exceed\s+\d+(?:\.\d+)?%\s+of\s+max_tokens\s*\((\d+)\)/.exec(text);
  if (!match) return null;
  const inputTokens = Number(match[1]), maxTokens = Number(match[2]);
  return Number.isSafeInteger(inputTokens) && inputTokens > 0 && Number.isSafeInteger(maxTokens) && maxTokens > 0
    ? { inputTokens, maxTokens } : null;
}

async function readNativeFailure({ directory, cwd, sessionDirectory, home } = {}) {
  const unavailable = new Set();
  const output = { contextExceeded: false, failures: [], message: "", sessionId: null, inputTokens: null, maxTokens: null, artifacts: [] };
  const recordArtifact = file => output.artifacts.push(path.resolve(file));
  let remaining = DIAGNOSTIC_LIMIT;
  const notice = (message, file) => {
    if (unavailable.size < 16) unavailable.add(`${message}${file ? `; full artifact: ${file}` : ""}`);
    else unavailable.add(`Additional diagnostic notices omitted; inspect original artifacts in ${directory}`);
  };
  const capture = (text, file) => {
    const size = remaining ? Buffer.byteLength(text) : 1;
    if (size <= remaining) { remaining -= size; return text; }
    const kept = remaining ? utf8Prefix(text, remaining) : ""; remaining = 0;
    notice(`Diagnostic text exceeds the ${DIAGNOSTIC_LIMIT}-byte total limit; remaining text was omitted`, file);
    return kept;
  };
  const readStderr = async () => {
    const file = path.join(directory, "stderr.log");
    try {
      const stderr = await stderrExcerpt(file);
      recordArtifact(file);
      if (nonempty(stderr.text)) output.failures.push({ path: null, reason: capture(stderr.text, file) });
      if (stderr.truncated) notice(`Stderr exceeds ${STDERR_LIMIT} bytes; only the initial excerpt was loaded`, file);
    } catch (error) { if (error.code !== "ENOENT") notice(`Native stderr unavailable: ${error.message}`, file); }
  };
  const finish = () => {
    output.message = output.failures.map(failure => [
      failure.path || "(unknown file)", failure.reason, failure.detail,
    ].filter(nonempty).join("\n")).join("\n\n") || "Native review failed without a recorded failure reason";
    if (unavailable.size) {
      output.diagnosticsUnavailable = [...unavailable];
      output.message += `\n\nDiagnostics unavailable:\n${output.diagnosticsUnavailable.join("\n")}`;
    }
    return output;
  };
  if (!nonempty(directory)) {
    notice("Native artifact directory is missing");
    return finish();
  }
  const resultFile = path.join(directory, "result.json");
  let report;
  try { report = await readJSON(resultFile, 32 * 1024 * 1024, recordArtifact); }
  catch (error) {
    notice(`Native result unavailable: ${error.message}`, resultFile);
    await readStderr();
    return finish();
  }
  if (!object(report) || !object(report.manifest) || !Array.isArray(report.manifest.coverage?.failed)) {
    notice("Native result has no valid failure manifest", resultFile);
    if (nonempty(report?.message)) output.failures.push({ path: null, reason: capture(report.message, resultFile) });
    await readStderr();
    return finish();
  }
  const manifest = report.manifest;
  const records = manifest.coverage.failed.slice(0, MAX_FAILURES).map(row => object(row) ? row : {});
  if (manifest.coverage.failed.length > MAX_FAILURES) notice(`More than ${MAX_FAILURES} failed items; remaining items were not loaded`, resultFile);
  output.failures = records.map(row => ({
    path: nonempty(row.path) ? capture(row.path, resultFile) || null : null,
    reason: nonempty(row.reason) ? capture(row.reason, resultFile) || "Failure reason omitted; inspect the original artifact" : "Native review failed without a recorded failure reason",
  }));
  if (manifest.run_failure) {
    const reason = object(manifest.run_failure) ? manifest.run_failure.message || manifest.run_failure.reason : manifest.run_failure;
    output.failures.push({ path: null, reason: nonempty(reason) ? capture(reason, resultFile) || "Failure reason omitted; inspect the original artifact" : "Native run failed without a recorded failure reason" });
  }
  const purePreflight = manifest.coverage.failed.length > 0 && manifest.coverage.failed.every(row => object(row) &&
    nonempty(row.reason) && row.reason.trim() === "prompt exceeded the configured token budget");
  output.contextExceeded = !manifest.run_failure && (purePreflight ||
    manifest.coverage.failed.length <= MAX_FAILURES && records.length > 0 &&
    records.every(row => nonempty(row.reason) && contextReasons.has(row.reason.trim())));
  const compressionItems = new Set(records.flatMap((row, index) => nonempty(row.reason) &&
    row.reason.trim() === "stopped because context compression exceeded its threshold" ? [index] : []));
  const compressionFailure = compressionItems.size > 0;
  const matchedCompression = new Set();
  let identityValid = true;
  const rejectIdentity = message => {
    identityValid = false; output.contextExceeded = false; notice(message, resultFile);
  };
  const id = report.session_id ?? manifest.run_id;
  if (typeof id === "string" && UUID.test(id)) output.sessionId = id;
  else rejectIdentity("Native result has no valid session UUID");
  if (report.session_id != null && manifest.run_id != null && report.session_id !== manifest.run_id) {
    rejectIdentity("Native result session ID does not match its manifest");
  }
  let metadata;
  try { metadata = await readJSON(path.join(directory, "metadata.json"), 1024 * 1024); }
  catch (error) { if (error.code !== "ENOENT") notice(`Native metadata unavailable: ${error.message}`, path.join(directory, "metadata.json")); }
  const workspace = cwd ?? metadata?.telemetry?.workspace;
  const input = object(manifest.input) ? manifest.input : {};
  if (object(metadata)) {
    if (metadata.telemetry?.workspace && workspace !== metadata.telemetry.workspace) {
      rejectIdentity("Native artifact workspace does not match the requested workspace");
    }
    const from = metadata.range?.from || metadata.merge_base;
    if (input.resolved_head && metadata.head && input.resolved_head !== metadata.head ||
        input.resolved_base && from && input.resolved_base !== from) {
      rejectIdentity("Native result commit range does not match its task metadata");
    }
  }
  if (!nonempty(workspace) || !(path.isAbsolute(workspace) || path.win32.isAbsolute(workspace))) {
    if (compressionFailure) output.contextExceeded = false;
    notice("Native workspace is missing or is not absolute", resultFile);
    return finish();
  }
  if (!output.sessionId || !identityValid || output.failures.length === 0) return finish();
  const root = sessionDirectory ?? path.join(home ?? os.homedir(), ".opencodereview", "sessions");
  if (!nonempty(root) || !path.isAbsolute(root)) {
    if (compressionFailure) output.contextExceeded = false;
    notice("Native session directory is not absolute", resultFile);
    return finish();
  }
  const groups = new Map();
  for (const group of Array.isArray(report.groups) ? report.groups : []) {
    if (!Array.isArray(group?.files) || !group.files.every(nonempty)) continue;
    groups.set([...group.files].sort().join(","), new Set(group.files));
  }
  let started = false, scanComplete = false;
  const details = output.failures.map(() => new Set());
  const sessionFile = path.join(root, encoded(workspace), `${output.sessionId}.jsonl`);
  try {
    scanComplete = await sessionRecords(sessionFile, event => {
      if (!object(event)) return;
      if (event.type === "session_start") {
        if (event.sessionId !== output.sessionId || event.cwd !== workspace ||
            input.resolved_head && event.diffTo !== input.resolved_head ||
            input.resolved_base && event.diffFrom !== input.resolved_base) {
          rejectIdentity("Session log identity does not match the native task artifact");
          return;
        }
        started = true;
        return;
      }
      if (!started || !identityValid) return;
      if (event.sessionId !== output.sessionId) {
        notice("Ignored a diagnostic record belonging to another session", sessionFile);
        return;
      }
      if (!["review_item_failed", "llm_error"].includes(event.type) || !nonempty(event.error)) return;
      const members = event.type === "llm_error" ? groups.get(event.filePath) : null;
      const nonContextError = event.type === "llm_error" && !contextError(event.error);
      const counts = tokenCounts(event.error);
      for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const matchesPath = nonempty(row.path) && (event.filePath === row.path || members?.has(row.path));
        const matchesFingerprint = event.type === "review_item_failed" && nonempty(row.fingerprint) && row.fingerprint === event.fingerprint;
        if (!matchesPath && !matchesFingerprint) continue;
        if (event.type === "review_item_failed" && row.fingerprint && event.fingerprint && row.fingerprint !== event.fingerprint) continue;
        if (compressionItems.has(i)) {
          matchedCompression.add(i);
          if (nonContextError) output.contextExceeded = false;
        }
        if (event.error !== output.failures[i].reason && !details[i].has(event.error)) {
          const detail = capture(event.error, sessionFile);
          if (detail) details[i].add(detail);
        }
        if (counts && (output.inputTokens === null || counts.inputTokens > output.inputTokens)) Object.assign(output, counts);
      }
    }, notice, recordArtifact);
    if (!started) notice("Matching session start record was not found", sessionFile);
  } catch (error) { notice(`Native session log unavailable: ${error.message}`, sessionFile); }
  const missingCompression = compressionItems.size - matchedCompression.size;
  if (missingCompression) {
    output.contextExceeded = false;
    unavailable.add(`Missing matching failure records for ${missingCompression} compression items; automatic context expansion is disabled; full artifact: ${sessionFile}`);
  }
  if (compressionFailure && (!started || !scanComplete)) {
    output.contextExceeded = false;
    unavailable.add(`Compression failure diagnostics are incomplete; automatic context expansion is disabled; full artifact: ${sessionFile}`);
  }
  if (identityValid) {
    for (let i = 0; i < details.length; i++) if (details[i].size) output.failures[i].detail = [...details[i]].join("\n\n");
  } else { output.inputTokens = null; output.maxTokens = null; }
  return finish();
}

module.exports = { readNativeFailure };
