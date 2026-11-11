// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { State } = require("./state.js"), { readState, flatten, stateDatabase } = require("./state-sqlite.js");
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "state-records-")), state = new State(directory);
  t.after(() => { state.database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const read = () => readState(path.join(directory, "state.db")).data;
  const consistent = () => assert.deepEqual([...state.database.rows].sort(), [...flatten(state.data)].sort());
  return { directory, state, read, consistent };
}
test("SQLite is the default and legacy JSON is imported only before the first database commit", t => {
  const f = fixture(t);
  assert.equal(fs.existsSync(f.state.file), false);
  f.state.data.sequence++; f.state.save();
  fs.writeFileSync(f.state.file, "corrupt obsolete JSON");
  const reopened = new State(f.directory);
  try { assert.equal(reopened.data.sequence, f.state.data.sequence); } finally { reopened.database.close(); }
  assert.equal(fs.readFileSync(f.state.file, "utf8"), "corrupt obsolete JSON");
  assert.equal(fs.statSync(path.join(f.directory, "state.db")).mode & 0o777, 0o600);
});
test("a failed legacy import can be retried without losing jobs, checkpoints or Agent sessions", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "state-import-")), file = path.join(directory, "state.json");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(file, "invalid JSON"); assert.throws(() => new State(directory), SyntaxError);
  assert.throws(() => readState(path.join(directory, "state.db")), /not initialized/);
  const legacy = { version: 1, sequence: 2, jobs: [{ id: 1, state: "running", retryBudget: 0, progress: { sessionId: "resume" } }],
    checkpoints: { "org/repo#1": { head: "head", sessionId: "checkpoint" } }, agentSessions: { binding: { sessionKey: "agent" } } };
  fs.writeFileSync(file, JSON.stringify(legacy));
  const state = new State(directory);
  try {
    assert.equal(state.data.jobs[0].state, "queued"); state.save();
    const saved = readState(path.join(directory, "state.db")).data;
    assert.equal(saved.jobs[0].retryBudget, 0); assert.equal(saved.jobs[0].progress.sessionId, "resume");
    assert.deepEqual(saved.checkpoints, legacy.checkpoints); assert.deepEqual(saved.agentSessions, legacy.agentSessions);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), legacy);
  } finally { state.database.close(); }
});
test("nested updates serialize only the affected records and no-op saves do not advance revision", t => {
  const f = fixture(t); let serialized = 0;
  f.state.data.jobs.push({ id: 1, state: "queued", nested: { retries: [] } },
    { id: 2, state: "complete", toJSON() { serialized++; return { id: 2, state: this.state }; } });
  f.state.save(); serialized = 0;
  const before = f.state.database.head.revision;
  f.state.data.jobs[0].nested.retries.push({ reason: "429", attempt: 1 }); f.state.save();
  assert.equal(serialized, 0);
  const changes = f.state.database.db.prepare("SELECT key FROM state_changes WHERE revision=?").all(before + 1);
  assert.deepEqual(changes.map(row => JSON.parse(row.key)), [["jobs", "1"]]);
  assert.deepEqual(f.read().jobs[0].nested.retries, [{ reason: "429", attempt: 1 }]);
  f.state.save(); assert.equal(f.state.database.head.revision, before + 1); assert.equal(serialized, 0);
  f.consistent();
});
test("scalar updates and deletion never scan all persisted row keys", t => {
  const f = fixture(t), original = f.state.database.rows.keys;
  f.state.database.rows.keys = () => { assert.fail("Scalar saves must not scan retained history"); };
  try {
    f.state.data.sequence++; f.state.save();
    f.state.data.lastSavedAt = "now"; f.state.save();
    delete f.state.data.lastSavedAt; f.state.save();
  } finally { f.state.database.rows.keys = original; }
  assert.equal(f.read().sequence, f.state.data.sequence);
  assert.equal(f.read().lastSavedAt, undefined); f.consistent();
});
test("append, reorder, replacement, nested mutation and deletion preserve collection order and identities", t => {
  const f = fixture(t), data = f.state.data;
  data.jobs.push({ id: 1 }, { id: 2 }, { id: 3 }); f.state.save(); f.consistent();
  data.jobs.reverse(); f.state.save(); f.consistent(); assert.deepEqual(f.read().jobs.map(job => job.id), [3, 2, 1]);
  data.jobs[1] = { id: 4, options: { budget: 1 } }; f.state.save(); f.consistent();
  data.jobs[1].options.budget = 0; f.state.save(); f.consistent();
  data.jobs = data.jobs.filter(job => job.id !== 3); f.state.save(); f.consistent();
  data.jobs[0].options.budget = 200; f.state.save(); assert.equal(f.read().jobs[0].options.budget, 200);
  data.jobs[0].id = 5; f.state.save(); f.consistent();
  data.jobs[0].options.budget = 900; f.state.save(); f.consistent();
  data.jobs.splice(0, 1); f.state.save(); f.consistent();
  delete data.jobs; f.state.save(); f.consistent();
  data.jobs = [{ id: 1 }]; f.state.save(); f.consistent();
  data.jobs.push({ id: 1 }); assert.throws(() => f.state.save(), /Duplicate/);
  data.jobs.pop(); f.state.save(); f.consistent();
});
test("map additions, nested changes, shared settings and deletions survive restart", t => {
  const f = fixture(t), data = f.state.data, shared = { options: { budget: 20 } };
  data.ciReceipts = { a: { state: "accepted", settings: shared } };
  data.jobs.push({ id: 1, settings: shared }); f.state.save();
  data.jobs[0].settings.options.budget = 0; f.state.save(); f.consistent();
  assert.equal(f.read().ciReceipts.a.settings.options.budget, 0);
  data.ciReceipts.a.history = [{ stage: "dispatch" }]; f.state.save();
  data.ciReceipts.a.history[0].stage = "review"; f.state.save(); f.consistent();
  delete data.ciReceipts.a.history[0].stage; delete data.ciReceipts.a; f.state.save(); f.consistent();
  data.ciReceipts = ["legacy"]; f.state.save(); f.consistent();
  data.ciReceipts = { b: { state: "done" } }; f.state.save(); f.consistent();
  delete data.ciReceipts; f.state.save(); f.consistent();
  const reopened = new State(f.directory);
  try { assert.deepEqual(reopened.data, f.read()); } finally { reopened.database.close(); }
});
test("records inserted through ||= containers acquire tracking before later recovery mutations", t => {
  const f = fixture(t), data = f.state.data;
  data.jobs.push({ id: 1, state: "queued" }); f.state.save();
  const job = data.jobs[0];
  (job.resumeFallbacks ||= []).push({ state: "authorized" }); f.state.save();
  const entry = job.resumeFallbacks.at(-1);
  entry.state = "started"; entry.pid = 123; f.state.save();
  assert.equal(f.read().jobs[0].resumeFallbacks[0].state, "started");
  assert.equal(f.read().jobs[0].resumeFallbacks[0].pid, 123);
  const usage = entry.usageBySession ||= {};
  usage.session = { totalTokens: 1 }; f.state.save();
  entry.usageBySession.session.totalTokens = 2; f.state.save();
  assert.equal(f.read().jobs[0].resumeFallbacks[0].usageBySession.session.totalTokens, 2);
  const receipts = data.ciReceipts ||= {};
  receipts.r = { state: "accepted" }; f.state.save();
  data.ciReceipts.r.state = "queued"; f.state.save();
  assert.equal(f.read().ciReceipts.r.state, "queued"); f.consistent();
});
test("recovery initialization returns tracked references that persist across multiple saves", t => {
  const f = fixture(t);
  f.state.data.jobs.push({ id: 1, state: "queued" }); f.state.save();
  const job = f.state.data.jobs[0], service = { state: f.state, log() {} };
  const entry = require("./resume-recovery.js").recordResumeFallback(service, job, "session_missing");
  entry.state = "started"; entry.pid = 123; f.state.save();
  const usage = entry.usageBySession;
  usage.session = { totalTokens: 1 }; f.state.save();
  usage.session.totalTokens = 2; f.state.save();
  const saved = f.read().jobs[0].resumeFallbacks[0];
  assert.equal(saved.state, "started"); assert.equal(saved.pid, 123);
  assert.equal(saved.usageBySession.session.totalTokens, 2); f.consistent();
});
test("whole-state replacement removes old keys and inserts newly added collections", t => {
  const f = fixture(t);
  f.state.data.old = { a: 1 }; f.state.save();
  f.state.data = { version: 1, sequence: 1, jobs: [{ id: "new", state: "queued" }], deliveries: [{ id: "delivery" }] };
  f.state.save(); f.consistent(); assert.equal(f.read().old, undefined);
  f.state.data.jobs[0].state = "complete"; f.state.save(); assert.equal(f.read().jobs[0].state, "complete");
});
test("read-only consumers see committed running jobs without normalization and never fall back to JSON", t => {
  const f = fixture(t);
  f.state.data.jobs.push({ id: 1, state: "running" }); f.state.data.agentFeedback = ["x".repeat(4096)]; f.state.save();
  const file = path.join(f.directory, "state.db");
  assert.throws(() => readState(file, { maxBytes: 1000 }), { code: "STATE_TOO_LARGE" });
  const partial = readState(file, { kinds: ["jobs", "version"], maxBytes: 1000 });
  assert.equal(partial.data.version, 1); assert.equal(partial.data.jobs[0].state, "running"); assert.equal(partial.data.agentFeedback, undefined);
  fs.writeFileSync(f.state.file, JSON.stringify({ version: 1, jobs: [{ id: "stale" }] }));
  assert.equal(stateDatabase({ stateFile: f.state.file }), file);
  assert.equal(stateDatabase({ stateDirectory: f.directory }), file);
  assert.equal(stateDatabase({ stateDatabase: file }), file);
  assert.equal(readState(file).data.jobs[0].id, 1);
  assert.throws(() => readState(path.join(f.directory, "missing.db")));
  assert.equal(fs.existsSync(path.join(f.directory, "missing.db")), false);
});
