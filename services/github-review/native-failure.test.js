// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readNativeFailure } = require("./native-failure.js");

const sessionId = "88b8caef-7f0d-4407-9e0a-47ea90cff0bb";
const otherId = "e7b17b97-96a5-42d7-afc1-f8d439759257";
const promptReason = "prompt exceeded the configured token budget";
const compressionReason = "stopped because context compression exceeded its threshold";
const threshold = "prompt tokens (162461) exceed 80% of max_tokens(200000) [round 1]";
const encoded = cwd => cwd.replace(/^([A-Za-z]):[\\/]/, "$1_").replace(/^[\\/]+/, "").replace(/[\\/]/g, "-");

function fixture(t, failed = [{ path: "a.js", fingerprint: "fp-a", reason: promptReason }]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-native-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "artifact"), cwd = path.join(root, "workspace"), home = path.join(root, "home");
  const sessionDirectory = path.join(home, ".opencodereview", "sessions");
  const file = path.join(sessionDirectory, encoded(cwd), `${sessionId}.jsonl`);
  fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(path.dirname(file), { recursive: true });
  const report = { status: "partial", session_id: sessionId, groups: [], manifest: {
    run_id: sessionId, terminal_state: "partial", input: { resolved_base: "base", resolved_head: "head" },
    coverage: { failed },
  } };
  const metadata = { head: "head", range: { from: "base" }, telemetry: { workspace: cwd } };
  const start = { type: "session_start", sessionId, cwd, diffFrom: "base", diffTo: "head" };
  const save = () => {
    fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify(report));
    fs.writeFileSync(path.join(directory, "metadata.json"), JSON.stringify(metadata));
  };
  const log = records => fs.writeFileSync(file, records.map(record => typeof record === "string" ? record : JSON.stringify(record)).join("\n") + "\n");
  save();
  return { directory, cwd, home, sessionDirectory, file, report, metadata, start, save, log };
}

test("native preflight failures retain the exact threshold and original multiline error", async t => {
  const h = fixture(t);
  const detail = `${threshold}\nOriginal diagnostic:\n${"error-detail ".repeat(600)}`;
  h.log([h.start, { type: "review_item_failed", sessionId, filePath: "a.js", fingerprint: "fp-a", error: detail }]);
  const failure = await readNativeFailure(h);
  assert.equal(failure.contextExceeded, true);
  assert.equal(failure.sessionId, sessionId);
  assert.equal(failure.inputTokens, 162461);
  assert.equal(failure.maxTokens, 200000);
  assert.deepEqual(failure.failures, [{ path: "a.js", reason: promptReason, detail }]);
  assert.ok(failure.message.includes(detail));
  assert.equal(failure.diagnosticsUnavailable, undefined);
  assert.deepEqual(failure.artifacts, [path.join(h.directory, "result.json"), h.file]);
});

test("compression reasons remain visible but missing diagnostics prevent automatic expansion", async t => {
  const h = fixture(t, [{ path: "a.js", reason: compressionReason }]);
  const failure = await readNativeFailure(h);
  assert.equal(failure.contextExceeded, false);
  assert.equal(failure.inputTokens, null);
  assert.equal(failure.maxTokens, null);
  assert.ok(failure.message.includes(compressionReason));
  assert.ok(failure.diagnosticsUnavailable.some(reason => reason.includes("session log unavailable")));
  assert.ok(failure.message.includes("automatic context expansion is disabled"));
  assert.ok(failure.message.includes(h.file));
  assert.deepEqual(failure.artifacts, [path.join(h.directory, "result.json")]);
});

test("compression stops caused by authentication, network and rate errors never expand", async t => {
  for (const raw of [
    "provider HTTP 401: invalid API key",
    "provider HTTP 429: rate_limit_exceeded\nrequest-id: rate-123",
    "fetch failed: ECONNRESET\noriginal network diagnostics",
    "request timed out while compressing context",
    "provider HTTP 503: context_length_exceeded was not evaluated",
    "API error (429): context_length_exceeded was not evaluated",
    '{"status":401,"message":"maximum context length was not evaluated"}',
  ]) {
    const h = fixture(t, [{ path: "a.js", reason: compressionReason }, { path: "b.js", reason: compressionReason }]);
    h.report.groups = [{ files: ["b.js", "a.js"] }]; h.save();
    h.log([h.start, { type: "llm_error", sessionId, filePath: "a.js,b.js", taskType: "memory_compression_task", error: raw }]);
    const failure = await readNativeFailure(h);
    assert.equal(failure.contextExceeded, false, raw);
    assert.ok(failure.failures.every(item => item.detail === raw));
    assert.ok(failure.message.includes(raw));
  }
});

test("unrelated errors cannot replace matching compression failure evidence", async t => {
  const h = fixture(t, [{ path: "a.js", reason: compressionReason }]);
  const unrelated = { type: "llm_error", sessionId, filePath: "unrelated.js", error: "provider HTTP 401" };
  for (const records of [[h.start], [h.start, unrelated]]) {
    h.log(records);
    const failure = await readNativeFailure(h);
    assert.equal(failure.contextExceeded, false);
    assert.match(failure.message, /Missing matching failure records for 1 compression items/);
  }
  h.log([h.start, unrelated, { type: "review_item_failed", sessionId, filePath: "a.js", error: compressionReason }]);
  const failure = await readNativeFailure(h);
  assert.equal(failure.contextExceeded, true);
  assert.doesNotMatch(failure.message, /HTTP 401/);
});

test("every compression item needs matching evidence from its own snapshot", async t => {
  const h = fixture(t, [
    { path: "a.js", fingerprint: "fp-a", reason: compressionReason },
    { path: "b.js", fingerprint: "fp-b", reason: compressionReason },
  ]);
  const a = { type: "review_item_failed", sessionId, filePath: "a.js", fingerprint: "fp-a", error: compressionReason };
  const b = { type: "review_item_failed", sessionId, filePath: "b.js", fingerprint: "fp-b", error: compressionReason };
  h.log([h.start, a, { ...b, fingerprint: "previous-snapshot" }]);
  let failure = await readNativeFailure(h);
  assert.equal(failure.contextExceeded, false);
  assert.match(failure.message, /Missing matching failure records for 1 compression items/);
  h.log([h.start, a, b]);
  failure = await readNativeFailure(h);
  assert.equal(failure.contextExceeded, true);
});

test("mixed failures and run failures never request automatic context expansion", async t => {
  const h = fixture(t, [
    { path: "a.js", reason: promptReason }, { path: "b.js", reason: "provider returned HTTP 401\ninvalid API key" },
  ]);
  h.log([h.start]);
  let failure = await readNativeFailure(h);
  assert.equal(failure.contextExceeded, false);
  assert.ok(failure.message.includes("provider returned HTTP 401\ninvalid API key"));
  h.report.manifest.coverage.failed.pop();
  h.report.manifest.run_failure = { classification: "internal", message: "failed to persist native result" };
  h.save();
  failure = await readNativeFailure(h);
  assert.equal(failure.contextExceeded, false);
  assert.ok(failure.message.includes("failed to persist native result"));
});

test("group LLM errors attach only to failed files and never expose prompts or tool results", async t => {
  const h = fixture(t, [{ path: "a.js", reason: compressionReason }, { path: "b.js", reason: compressionReason }]);
  h.report.groups = [{ label: "related", files: ["b.js", "a.js"] }]; h.save();
  const raw = "provider HTTP 400\ncontext_length_exceeded\nrequest-id: request-123";
  h.log([
    h.start,
    { type: "llm_request", sessionId, filePath: "a.js,b.js", messages: [{ content: "private prompt should not be copied" }] },
    { type: "tool_call", sessionId, filePath: "a.js,b.js", error: "private tool contents should not be copied" },
    { type: "llm_error", sessionId, filePath: "a.js,b.js", taskType: "main_task", error: raw },
    { type: "llm_error", sessionId, filePath: "unrelated.js", error: "unrelated failure" },
    { type: "review_item_failed", sessionId, filePath: "a.js", error: "main_task did not complete before stopping (round 1/3)" },
  ]);
  const failure = await readNativeFailure(h);
  assert.equal(failure.contextExceeded, true);
  assert.ok(failure.failures.every(item => item.detail.includes(raw)));
  assert.match(failure.failures[0].detail, /round 1\/3/);
  assert.doesNotMatch(failure.message, /private prompt|private tool|unrelated failure/);
});

test("session start must match the result session, authoritative workspace and commit range", async t => {
  for (const changed of [{ sessionId: otherId }, { cwd: "/unrelated" }, { diffFrom: "old-base" }, { diffTo: "new-head" }]) {
    const h = fixture(t);
    h.log([{ ...h.start, ...changed }, { type: "review_item_failed", sessionId, filePath: "a.js", error: threshold }]);
    const failure = await readNativeFailure(h);
    assert.equal(failure.contextExceeded, false);
    assert.equal(failure.failures[0].detail, undefined);
    assert.equal(failure.inputTokens, null);
    assert.ok(failure.message.includes(promptReason));
    assert.ok(failure.diagnosticsUnavailable.some(reason => reason.includes("identity does not match")));
  }
});

test("artifact identity mismatches reject session diagnostics before reading unrelated data", async t => {
  for (const change of [h => { h.report.manifest.run_id = otherId; }, h => { h.metadata.telemetry.workspace = "/other"; }, h => { h.metadata.head = "different"; }]) {
    const h = fixture(t); change(h); h.save();
    h.log([h.start, { type: "review_item_failed", sessionId, filePath: "a.js", error: "must not be read" }]);
    const failure = await readNativeFailure(h);
    assert.equal(failure.contextExceeded, false);
    assert.doesNotMatch(failure.message, /must not be read/);
    assert.ok(failure.diagnosticsUnavailable.length > 0);
  }
});

test("another workspace or session cannot provide diagnostics for a missing log", async t => {
  const h = fixture(t);
  const otherWorkspace = path.join(h.sessionDirectory, encoded(`${h.cwd}/other`));
  fs.mkdirSync(otherWorkspace, { recursive: true });
  const poison = JSON.stringify({ ...h.start, cwd: `${h.cwd}/other` }) + "\n" +
    JSON.stringify({ type: "review_item_failed", sessionId, filePath: "a.js", error: "wrong task error" });
  fs.writeFileSync(path.join(otherWorkspace, `${sessionId}.jsonl`), poison);
  fs.writeFileSync(path.join(path.dirname(h.file), `${otherId}.jsonl`), poison);
  const failure = await readNativeFailure(h);
  assert.equal(failure.failures[0].detail, undefined);
  assert.doesNotMatch(failure.message, /wrong task error/);
  assert.ok(failure.diagnosticsUnavailable.some(reason => reason.includes("session log unavailable")));
});

test("records from another session or mismatched file fingerprints are ignored", async t => {
  const h = fixture(t);
  h.log([
    h.start,
    { type: "review_item_failed", sessionId: otherId, filePath: "a.js", fingerprint: "fp-a", error: "wrong session error" },
    { type: "review_item_failed", sessionId, filePath: "a.js", fingerprint: "old-fingerprint", error: "wrong snapshot error" },
    { type: "review_item_failed", sessionId, filePath: "a.js", fingerprint: "fp-a", error: threshold },
  ]);
  const failure = await readNativeFailure(h);
  assert.equal(failure.failures[0].detail, threshold);
  assert.doesNotMatch(failure.message, /wrong session error|wrong snapshot error/);
  assert.ok(failure.diagnosticsUnavailable.some(reason => reason.includes("another session")));
});

test("minimal and malformed manifests remain readable without enabling expansion for unknown failures", async t => {
  const h = fixture(t, [{ fingerprint: "fp-a", reason: promptReason }, null, {}]);
  h.log([h.start, { type: "review_item_failed", sessionId, filePath: "a.js", fingerprint: "fp-a", error: threshold }]);
  let failure = await readNativeFailure(h);
  assert.equal(failure.contextExceeded, false);
  assert.equal(failure.failures[0].path, null);
  assert.equal(failure.failures[0].detail, threshold);
  assert.equal(failure.failures.length, 3);
  fs.writeFileSync(path.join(h.directory, "result.json"), JSON.stringify({ message: "native error original text", manifest: {} }));
  failure = await readNativeFailure(h);
  assert.equal(failure.contextExceeded, false);
  assert.ok(failure.message.includes("native error original text"));
  fs.writeFileSync(path.join(h.directory, "result.json"), "{");
  failure = await readNativeFailure(h);
  assert.equal(failure.contextExceeded, false);
  assert.ok(failure.diagnosticsUnavailable.some(reason => reason.includes("result unavailable")));
});

test("home locates the exact session and metadata can supply a missing workspace", async t => {
  const h = fixture(t);
  h.log([h.start, { type: "review_item_failed", sessionId, filePath: "a.js", error: threshold }]);
  const failure = await readNativeFailure({ directory: h.directory, home: h.home });
  assert.equal(failure.failures[0].detail, threshold);
  assert.equal(failure.contextExceeded, true);
});

test("streamed diagnostics survive oversized prompt records and report every skipped record", async t => {
  const h = fixture(t);
  const oversized = JSON.stringify({ type: "llm_request", sessionId, messages: [{ content: "x".repeat(8 * 1024 * 1024) }] });
  h.log([h.start, oversized, { type: "review_item_failed", sessionId, filePath: "a.js", error: threshold }]);
  const failure = await readNativeFailure(h);
  assert.equal(failure.failures[0].detail, threshold);
  assert.equal(failure.inputTokens, 162461);
  assert.ok(failure.diagnosticsUnavailable.some(reason => reason.includes("record was not loaded")));
});

test("malformed diagnostic records and missing starts are explicit, and no UUID means no session path", async t => {
  const h = fixture(t);
  h.log([h.start, '{"type":"llm_error",', { type: "review_item_failed", sessionId, filePath: "a.js", error: threshold }]);
  let failure = await readNativeFailure(h);
  assert.equal(failure.failures[0].detail, threshold);
  assert.ok(failure.diagnosticsUnavailable.some(reason => reason.includes("Invalid session diagnostic record")));
  h.log([{ type: "review_item_failed", sessionId, filePath: "a.js", error: threshold }]);
  failure = await readNativeFailure(h);
  assert.equal(failure.failures[0].detail, undefined);
  assert.ok(failure.diagnosticsUnavailable.some(reason => reason.startsWith("Matching session start record was not found")));
  h.report.session_id = "../other"; h.report.manifest.run_id = "../other"; h.save();
  failure = await readNativeFailure(h);
  assert.equal(failure.contextExceeded, false);
  assert.equal(failure.sessionId, null);
  assert.ok(failure.diagnosticsUnavailable.some(reason => reason.startsWith("Native result has no valid session UUID")));
  assert.equal((await readNativeFailure()).contextExceeded, false);
});

test("native startup failures retain stderr when the report is missing, invalid or incomplete", async t => {
  for (const result of [null, "", "{", JSON.stringify({ message: "report initialization failed" })]) {
    const h = fixture(t);
    const reportFile = path.join(h.directory, "result.json");
    if (result === null) fs.unlinkSync(reportFile); else fs.writeFileSync(reportFile, result);
    const raw = "Error: could not initialize provider: HTTP 401 invalid API key\nrequest-id: startup-123\n";
    fs.writeFileSync(path.join(h.directory, "stderr.log"), raw);
    const failure = await readNativeFailure(h);
    assert.equal(failure.contextExceeded, false);
    assert.ok(failure.message.includes(raw));
    assert.ok(failure.message.includes(reportFile));
    assert.ok(failure.failures.some(item => item.reason === raw));
    assert.deepEqual(failure.artifacts, [...(result === null ? [] : [reportFile]), path.join(h.directory, "stderr.log")]);
  }
});

test("large stderr excerpts preserve UTF-8 and explicitly locate the untouched full artifact", async t => {
  const h = fixture(t);
  fs.writeFileSync(path.join(h.directory, "result.json"), "");
  const file = path.join(h.directory, "stderr.log");
  const raw = `Error: upstream failed\n${"\u6d4b\u8bd5".repeat(60000)}\nTAIL-OF-ORIGINAL`;
  fs.writeFileSync(file, raw);
  const failure = await readNativeFailure(h);
  const excerpt = failure.failures[0].reason;
  assert.ok(raw.startsWith(excerpt));
  assert.ok(Buffer.byteLength(excerpt) <= 256 * 1024);
  assert.doesNotMatch(excerpt, /\ufffd|TAIL-OF-ORIGINAL/);
  assert.ok(failure.message.includes(`full artifact: ${file}`));
  assert.match(failure.message, /Stderr exceeds .*initial excerpt/);
  assert.equal(fs.readFileSync(file, "utf8"), raw);
});

test("group diagnostics have a total byte limit instead of multiplying large errors per file", async t => {
  const failed = ["a.js", "b.js", "c.js"].map(name => ({ path: name, reason: compressionReason }));
  const h = fixture(t, failed);
  h.report.groups = [{ files: failed.map(row => row.path) }]; h.save();
  const raw = `context_length_exceeded\n${"\u6d4b\u8bd5".repeat(60000)}\nEND-OF-ERROR`;
  h.log([h.start, { type: "llm_error", sessionId, filePath: "a.js,b.js,c.js", error: raw }]);
  const original = fs.readFileSync(h.file);
  const failure = await readNativeFailure(h);
  const retainedBytes = failure.failures.reduce((total, item) => total +
    Buffer.byteLength(item.path || "") + Buffer.byteLength(item.reason) + Buffer.byteLength(item.detail || ""), 0);
  assert.ok(retainedBytes <= 512 * 1024);
  assert.equal(failure.contextExceeded, true);
  assert.ok(failure.failures.some(item => item.detail === raw));
  assert.match(failure.message, /total limit; remaining text was omitted/);
  assert.ok(failure.message.includes(`full artifact: ${h.file}`));
  assert.doesNotMatch(failure.message, /\ufffd/);
  assert.deepEqual(fs.readFileSync(h.file), original);
});

test("bounded scans cannot classify compression when unread session records may contain another error", async t => {
  const h = fixture(t, [{ path: "a.js", reason: compressionReason }]);
  h.log([h.start]);
  const size = 64 * 1024 * 1024 + 4096;
  const handle = fs.openSync(h.file, "r+");
  try { fs.ftruncateSync(handle, size); }
  finally { fs.closeSync(handle); }
  const failure = await readNativeFailure(h);
  assert.equal(failure.contextExceeded, false);
  assert.match(failure.message, /Session scan exceeds .*remaining records were not loaded/);
  assert.match(failure.message, /automatic context expansion is disabled/);
  assert.ok(failure.message.includes(`full artifact: ${h.file}`));
  assert.equal(fs.statSync(h.file).size, size);
});

test("excessive failed items and malformed-record notices cannot grow the diagnostic result without limit", async t => {
  const h = fixture(t, Array.from({ length: 1000 }, (_, index) => ({ path: `file-${index}.js`, reason: compressionReason })));
  h.log([h.start, ...Array.from({ length: 100 }, () => '{"type":"llm_error",')]);
  const failure = await readNativeFailure(h);
  assert.equal(failure.contextExceeded, false);
  assert.equal(failure.failures.length, 256);
  assert.ok(failure.diagnosticsUnavailable.length <= 19);
  assert.match(failure.message, /remaining items were not loaded/);
  assert.match(failure.message, /Additional diagnostic notices omitted/);
  assert.match(failure.message, /automatic context expansion is disabled/);
  assert.ok(failure.message.includes(path.join(h.directory, "result.json")));
});

test("large pure preflight failures can expand without copying every failed item into diagnostics", async t => {
  const h = fixture(t, Array.from({ length: 1000 }, (_, index) => ({ path: `file-${index}.js`, reason: promptReason })));
  h.log([h.start]);
  let failure = await readNativeFailure(h);
  assert.equal(failure.contextExceeded, true);
  assert.equal(failure.failures.length, 256);
  assert.match(failure.message, /remaining items were not loaded/);
  for (const reason of ["provider HTTP 401: invalid API key", compressionReason]) {
    h.report.manifest.coverage.failed.at(-1).reason = reason;
    h.save();
    failure = await readNativeFailure(h);
    assert.equal(failure.contextExceeded, false, "Classification must inspect items beyond the diagnostic output limit");
  }
});
