// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { State } = require("./state.js"), { SQLiteState } = require("./state-sqlite.js");
const { AuditSQLite } = require("./audit-sqlite.js"), { StateSync } = require("./state-sync.js");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-sync-"));
  const initial = { version: 1, sequence: 1, initialized: {}, pulls: {}, checkpoints: {}, jobs: [{ id: 1, repository: "org/repo", number: 1, state: "complete", result: { findings: 2 } }], deliveries: [], ciReceipts: {}, agentSessions: {} };
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(initial));
  const state = new State(dir, { sqlite: true }), store = new AuditSQLite(path.join(dir, "audit.db"));
  const sync = new StateSync(path.join(dir, "state.db"), store);
  t.after(() => { state.database.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, state, store, sync, initial };
}
test("one-time import checkpoints data; subsequent sync consumes only changed records and deletions", (t) => {
  const f = fixture(t); assert.deepEqual(f.sync.read(), f.initial); assert.equal(f.sync.status.mode, "bootstrap");
  const old = f.sync.status.revision;
  assert.deepEqual(f.sync.read(), f.initial); assert.equal(f.sync.status.changedRows, 0); assert.equal(f.sync.status.revision, old);
  f.state.data.jobs[0].result.findings = 3; f.state.save();
  assert.equal(f.sync.read().jobs[0].result.findings, 3); assert.equal(f.sync.status.changedRows, 1);
  f.state.data.jobs = []; f.state.data.ciReceipts.a = { state: "accepted" }; f.state.save();
  const value = f.sync.read(); assert.deepEqual(value.jobs, []); assert.equal(value.ciReceipts.a.state, "accepted");
  fs.writeFileSync(f.state.file, "invalid legacy snapshot");
  assert.deepEqual(new StateSync(path.join(f.dir, "state.db"), f.store).read(), value);
  const reopened = new State(f.dir, { sqlite: true });
  try { assert.deepEqual(reopened.data, value); } finally { reopened.database.close(); }
});
test("source transaction failure rolls back state and revision", (t) => {
  const f = fixture(t), before = f.state.database.head.revision;
  f.state.database.db.exec("CREATE TRIGGER fail BEFORE INSERT ON state_changes BEGIN SELECT RAISE(ABORT,'injected'); END");
  f.state.data.jobs[0].result.findings = 10;
  assert.throws(() => f.state.save(), /injected/); assert.equal(f.state.database.head.revision, before);
  assert.equal(f.sync.read().jobs[0].result.findings, 2);
  f.state.database.db.exec("DROP TRIGGER fail"); f.state.save(); assert.equal(f.sync.read().jobs[0].result.findings, 10);
});
test("consumer failure never advances checkpoint and restart safely replays committed changes", (t) => {
  const f = fixture(t); f.sync.read(); const checkpoint = f.store.meta("reviewSourceCheckpoint");
  f.state.data.jobs[0].result.findings = 9; f.state.save();
  f.store.db.exec("CREATE TRIGGER fail BEFORE UPDATE ON review_source_rows BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.throws(() => f.sync.read(), /injected/); assert.deepEqual(f.store.meta("reviewSourceCheckpoint"), checkpoint);
  f.store.db.exec("DROP TRIGGER fail");
  const resumed = new StateSync(path.join(f.dir, "state.db"), f.store); assert.equal(resumed.read().jobs[0].result.findings, 9);
  assert.equal(resumed.read().jobs[0].result.findings, 9); assert.equal(resumed.status.changedRows, 0);
});
test("bounded batches do not split a source revision and missing history resnapshots from SQLite", (t) => {
  const f = fixture(t); f.sync.read();
  for (let i = 0; i < 25; i++) { f.state.data.sequence++; f.state.database.save(f.state.data); }
  f.sync.read(); assert.equal(f.sync.status.pendingRevisions, 5);
  f.sync.read(); assert.equal(f.sync.status.pendingRevisions, 0);
  f.state.data.jobs[0].result.findings = 8; f.state.database.save(f.state.data);
  f.state.database.db.exec("DELETE FROM state_changes"); fs.unlinkSync(f.state.file);
  assert.equal(f.sync.read().jobs[0].result.findings, 8); assert.equal(f.sync.status.mode, "resnapshot");
});
test("database replacement or rollback cannot silently reuse another epoch/checkpoint", (t) => {
  const f = fixture(t); f.sync.read();
  f.state.database.db.prepare("UPDATE state_head SET epoch=?").run("replacement");
  f.sync.read(); assert.equal(f.sync.status.mode, "resnapshot"); assert.equal(f.sync.status.epoch, "replacement");
});
test("a failed compatibility JSON write does not lose the authoritative SQLite commit", (t) => {
  const f = fixture(t); f.state.data.jobs[0].result.findings = 7;
  fs.mkdirSync(f.state.file + ".tmp"); assert.throws(() => f.state.save());
  const reopened = new State(f.dir, { sqlite: true });
  try { assert.equal(reopened.data.jobs[0].result.findings, 7); } finally { reopened.database.close(); }
  assert.equal(f.sync.read().jobs[0].result.findings, 7);
});
test("concurrent source writers are rejected without overwriting committed state", (t) => {
  const f = fixture(t), other = new SQLiteState(path.join(f.dir, "state.db"));
  try {
    f.state.data.sequence++; f.state.save();
    const stale = other.load(); stale.sequence += 10;
    assert.throws(() => other.save(stale), /Concurrent/);
    assert.equal(f.sync.read().sequence, f.state.data.sequence);
  } finally { other.close(); }
});

test("source database backup restores state and revision together", async (t) => {
  const f = fixture(t); f.state.data.sequence++; f.state.save();
  const file = await require("./monitor-sqlite-backup.js").backupMonitor(path.join(f.dir, "state.db"), path.join(f.dir, "backups"), new Date(), true);
  const restored = new SQLiteState(file);
  try { assert.deepEqual(restored.load(), f.state.data); assert.equal(restored.head.revision, f.state.database.head.revision); }
  finally { restored.close(); }
});

test("divergent history at the same epoch/revision is detected by commit identity", (t) => {
  const f = fixture(t); f.sync.read();
  f.state.database.db.exec("UPDATE state_commits SET token='restored-branch'; UPDATE state_head SET token='restored-branch'");
  f.sync.read(); assert.equal(f.sync.status.mode, "resnapshot"); assert.equal(f.sync.status.token, "restored-branch");
});

test("a consumer reloads its projection if another consumer advanced the durable checkpoint", (t) => {
  const f = fixture(t); f.sync.read();
  f.state.data.jobs[0].result.findings = 6; f.state.save();
  new StateSync(path.join(f.dir, "state.db"), f.store).read();
  assert.equal(f.sync.read().jobs[0].result.findings, 6);
  assert.equal(f.sync.status.changedRows, 0);
});

test("rollback export preserves the latest authoritative state without restart normalization", (t) => {
  const f = fixture(t); f.state.data.jobs[0].state = "running"; f.state.database.save(f.state.data);
  require("./state-export.js").exportState(path.join(f.dir, "state.db"), f.state.file);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.state.file, "utf8")), f.state.data);
});

test("an unchanged stale writer cannot overwrite the compatibility export", (t) => {
  const f = fixture(t), other = new State(f.dir, { sqlite: true });
  try {
    f.state.data.sequence++; f.state.save();
    const json = fs.readFileSync(f.state.file, "utf8");
    assert.throws(() => other.save(), /Concurrent/);
    assert.equal(fs.readFileSync(f.state.file, "utf8"), json);
  } finally { other.database.close(); }
});

test("projection limits reject bootstrap and incremental growth without advancing checkpoint", (t) => {
  const f = fixture(t);
  assert.throws(() => new StateSync(path.join(f.dir, "state.db"), f.store, 1).read(), { code: "STATE_TOO_LARGE" });
  assert.equal(f.store.meta("reviewSourceCheckpoint"), null);
  f.sync.read(); const checkpoint = f.store.meta("reviewSourceCheckpoint");
  const limited = new StateSync(path.join(f.dir, "state.db"), f.store, checkpoint.sizeBytes + 10);
  limited.read(); const before = f.store.meta("reviewSourceCheckpoint");
  f.state.data.jobs[0].detail = "x".repeat(30); f.state.save();
  assert.throws(() => limited.read(), { code: "STATE_TOO_LARGE" });
  assert.deepEqual(f.store.meta("reviewSourceCheckpoint"), before);
  assert.equal(f.sync.read().jobs[0].detail.length, 30);
});

test("writer startup reads its head and rows from one snapshot", (t) => {
  const f = fixture(t), original = SQLiteState.prototype.readRows;
  SQLiteState.prototype.readRows = function () {
    f.state.data.sequence++; f.state.save();
    return original.call(this);
  };
  let other;
  try {
    other = new SQLiteState(path.join(f.dir, "state.db"));
    assert.equal(other.head.revision, 1); assert.equal(other.load().sequence, 1);
  } finally { SQLiteState.prototype.readRows = original; other?.close(); }
});

test("projection returned by a consumer remains paired with its checkpoint across a concurrent commit", (t) => {
  const f = fixture(t), transaction = f.store.transaction.bind(f.store);
  let inject = true;
  f.store.transaction = (fn) => {
    const result = transaction(fn);
    if (inject) {
      inject = false; f.state.data.sequence++; f.state.save();
      new StateSync(path.join(f.dir, "state.db"), f.store).read();
    }
    return result;
  };
  assert.equal(f.sync.read().sequence, 1); assert.equal(f.sync.status.revision, 1);
  assert.equal(f.store.meta("reviewSourceCheckpoint").revision, 2);
  assert.equal(f.sync.read().sequence, 2);
});
