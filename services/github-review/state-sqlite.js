// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const fs = require("node:fs"), path = require("node:path"), { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const arrays = new Set(["jobs", "deliveries"]);
function flatten(data) {
  const rows = new Map();
  for (const [kind, value] of Object.entries(data)) {
    if (arrays.has(kind)) {
      rows.set(JSON.stringify(["$types", kind]), JSON.stringify("array"));
      for (const [index, item] of value.entries()) {
        if (item.id === undefined) throw Error("State collection entry requires an id");
        const key = JSON.stringify([kind, String(item.id)]);
        if (rows.has(key)) throw Error("Duplicate state collection identity");
        rows.set(key, JSON.stringify({ index, value: item }));
      }
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      rows.set(JSON.stringify(["$types", kind]), JSON.stringify("object"));
      for (const [key, item] of Object.entries(value)) rows.set(JSON.stringify([kind, key]), JSON.stringify(item));
    } else rows.set(JSON.stringify(["$values", kind]), JSON.stringify(value));
  }
  return rows;
}
function inflate(rows, decoded = false) {
  const data = {}, lists = {};
  for (const [key, payload] of rows) {
    const [kind, id] = JSON.parse(key), value = decoded ? payload : JSON.parse(payload);
    if (kind === "$types") data[id] = value === "array" ? [] : {};
    if (kind === "$values") data[id] = value;
  }
  for (const [key, payload] of rows) {
    const [kind, id] = JSON.parse(key);
    if (kind.startsWith("$")) continue;
    const value = decoded ? payload : JSON.parse(payload);
    if (arrays.has(kind)) (lists[kind] ||= []).push(value);
    else Object.defineProperty(data[kind], id, { value, enumerable: true, configurable: true, writable: true });
  }
  for (const [kind, items] of Object.entries(lists)) data[kind] = items.sort((a, b) => a.index - b.index).map((r) => r.value);
  return data;
}
class SQLiteState {
  constructor(file, { readOnly = false } = {}) {
    if (!readOnly) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.closeSync(fs.openSync(file, "a", 0o600)); }
    this.db = new DatabaseSync(file, { readOnly });
    this.db.exec("PRAGMA busy_timeout=1000; PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA temp_store=FILE;");
    const app = this.db.prepare("PRAGMA application_id").get().application_id;
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    const tables = this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n;
    if ((app !== 1329812040 || version !== 1) && (readOnly || app || version || tables)) { this.db.close(); throw Error("Unsupported source state database"); }
    if (!readOnly) this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS state_head(id INTEGER PRIMARY KEY CHECK(id=1),epoch TEXT NOT NULL,revision INTEGER NOT NULL,token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state_commits(revision INTEGER PRIMARY KEY,token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state_rows(key TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state_changes(revision INTEGER NOT NULL,key TEXT NOT NULL,payload TEXT,PRIMARY KEY(revision,key));
      PRAGMA application_id=1329812040; PRAGMA user_version=1;`);
    this.db.exec("BEGIN");
    try {
      this.head = this.db.prepare("SELECT * FROM state_head WHERE id=1").get();
      this.rows = readOnly ? null : this.readRows();
    } finally { this.db.exec("ROLLBACK"); }
  }
  readRows() { return new Map(this.db.prepare("SELECT key,payload FROM state_rows").all().map((r) => [r.key, r.payload])); }
  load() { return this.head ? inflate(this.rows) : null; }
  save(data) {
    const next = flatten(data), changes = [];
    for (const [key, payload] of next) if (this.rows.get(key) !== payload) changes.push({ key, payload });
    for (const key of this.rows.keys()) if (!next.has(key)) changes.push({ key, payload: null });
    const epoch = this.head?.epoch || randomUUID(), revision = (this.head?.revision || 0) + 1;
    const token = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT * FROM state_head WHERE id=1").get();
      if ((current?.revision || 0) !== (this.head?.revision || 0) || current?.epoch !== this.head?.epoch || current?.token !== this.head?.token) throw Error("Concurrent state writer detected");
      if (this.head && !changes.length) { this.db.exec("COMMIT"); return; }
      const upsert = this.db.prepare("INSERT INTO state_rows VALUES (?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload");
      const remove = this.db.prepare("DELETE FROM state_rows WHERE key=?");
      const log = this.db.prepare("INSERT INTO state_changes VALUES (?,?,?)");
      for (const row of changes) {
        if (row.payload === null) remove.run(row.key); else upsert.run(row.key, row.payload);
        log.run(revision, row.key, row.payload);
      }
      this.db.prepare("INSERT INTO state_head VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch,revision=excluded.revision,token=excluded.token").run(epoch, revision, token);
      this.db.prepare("INSERT INTO state_commits VALUES (?,?)").run(revision, token);
      this.db.prepare("DELETE FROM state_commits WHERE revision<?").run(revision - 1000);
      this.db.prepare("DELETE FROM state_changes WHERE revision<=?").run(revision - 1000);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.head = { epoch, revision, token }; this.rows = next;
  }
  close() { this.db.close(); }
}
module.exports = { SQLiteState, flatten, inflate };
