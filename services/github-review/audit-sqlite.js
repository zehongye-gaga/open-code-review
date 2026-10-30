// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { emptyUsage, runRows, dayKey, shiftDay } = require("./analytics-summary.js");
const { ingest } = require("./analytics.js");
const { auditRows } = require("./monitor-audit.js");
const columns = Object.keys(emptyUsage());

class AuditSQLite {
  constructor(file, { readOnly = false, readSession = ingest, now = Date.now } = {}) {
    this.readSession = readSession; this.now = now;
    if (!path.isAbsolute(file)) throw Error("Database path must be absolute");
    if (!readOnly) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.closeSync(fs.openSync(file, "a", 0o600));
    }
    this.db = new DatabaseSync(file, { readOnly, timeout: 1000 });
    this.db.exec("PRAGMA busy_timeout=1000; PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA temp_store=FILE;");
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    const application = this.db.prepare("PRAGMA application_id").get().application_id;
    const tables = this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n;
    const fresh = !tables && version === 0 && application === 0;
    const owned = tables > 0 && version === 1 && application === 1329812033;
    if (!owned && (readOnly || !fresh)) {
      this.db.close(); throw Error("Unsupported audit database schema");
    }
    if (readOnly) { this.db.exec("PRAGMA query_only=ON"); return; }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, repository TEXT NOT NULL, number INTEGER NOT NULL,
        updated_at TEXT, created_at TEXT, state TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_pr ON jobs(repository,number,created_at DESC,id);
      CREATE INDEX IF NOT EXISTS jobs_updated ON jobs(updated_at);
      CREATE TABLE IF NOT EXISTS sessions (file TEXT PRIMARY KEY, session_id TEXT, repository TEXT NOT NULL,
        number INTEGER, job_id TEXT, active INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_job ON sessions(job_id,active);
      CREATE INDEX IF NOT EXISTS sessions_pr ON sessions(repository,number,active);
      CREATE TABLE IF NOT EXISTS usage_days (file TEXT NOT NULL REFERENCES sessions(file) ON DELETE CASCADE,
        day TEXT NOT NULL, phase TEXT NOT NULL, ${columns.map((c) => `${c} REAL NOT NULL`).join(",")},
        PRIMARY KEY(file,day,phase));
      CREATE INDEX IF NOT EXISTS usage_day ON usage_days(day,phase,file);
      CREATE TABLE IF NOT EXISTS audit (source TEXT NOT NULL,id TEXT NOT NULL,repository TEXT,number INTEGER,
        updated_at TEXT,payload TEXT NOT NULL,PRIMARY KEY(source,id));
      CREATE INDEX IF NOT EXISTS audit_pr ON audit(repository,number,updated_at DESC,id);
      CREATE INDEX IF NOT EXISTS audit_job ON audit(json_extract(payload,'$.jobId'),source);
      CREATE TABLE IF NOT EXISTS sources (file TEXT PRIMARY KEY,identity TEXT NOT NULL,signature TEXT NOT NULL);
      PRAGMA application_id=1329812033; PRAGMA user_version=1;`);
    this.statements = new Map();
  }
  statement(sql) {
    this.statements ||= new Map();
    if (!this.statements.has(sql)) this.statements.set(sql, this.db.prepare(sql));
    return this.statements.get(sql);
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  meta(key, value) {
    if (value !== undefined) this.statement("INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
    const row = this.statement("SELECT value FROM meta WHERE key=?").get(key);
    return row ? JSON.parse(row.value) : null;
  }
  putJob(job) {
    if (!job.id || !/^[\w.-]+\/[\w.-]+$/.test(job.repository) || !Number.isSafeInteger(job.number)) throw Error("Invalid job identity");
    return this.statement(`INSERT INTO jobs VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      repository=excluded.repository,number=excluded.number,updated_at=excluded.updated_at,
      created_at=excluded.created_at,state=excluded.state,payload=excluded.payload WHERE payload<>excluded.payload`)
      .run(String(job.id), job.repository, job.number, job.updatedAt || null, job.createdAt || null, job.state, JSON.stringify(job)).changes;
  }
  putSession(file, row) {
    const payload = JSON.stringify(row);
    const changed = this.statement(`INSERT INTO sessions VALUES (?,?,?,?,?,?,?) ON CONFLICT(file) DO UPDATE SET
      session_id=excluded.session_id,repository=excluded.repository,number=excluded.number,job_id=excluded.job_id,
      active=excluded.active,payload=excluded.payload WHERE payload<>excluded.payload`)
      .run(file, row.id || null, row.repository, row.number || null, row.jobId || null, row.id && !row.ignored && !row.expired ? 1 : 0, payload).changes;
    if (!changed) return 0;
    this.statement("DELETE FROM usage_days WHERE file=?").run(file);
    const insert = this.statement(`INSERT INTO usage_days VALUES (${Array(columns.length + 3).fill("?").join(",")})`);
    const add = (day, phase, usage) => insert.run(file, day, phase, ...columns.map((c) => usage[c] || 0));
    for (const [day, usage] of Object.entries(row.days || {})) add(day, "total", usage);
    for (const [day, phases] of Object.entries(row.phaseDays || {})) for (const [phase, usage] of Object.entries(phases)) add(day, phase, usage);
    return 1;
  }
  importLedger(ledger, { retentionDays = 90 } = {}) {
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 7 || retentionDays > 366) throw Error("Invalid retention window");
    if (this.meta("bootstrap")) throw Error("Ledger already imported; use incremental collection");
    if (ledger.version !== 2 || !ledger.timeZone || !ledger.jobs || !ledger.sessions) throw Error("Unsupported ledger");
    const batches = (items, fn) => {
      for (let start = 0; start < items.length; start += 100) this.transaction(() => items.slice(start, start + 100).forEach(fn));
    };
    batches(Object.values(ledger.jobs), (job) => this.putJob(job));
    batches(Object.entries(ledger.sessions), ([file, row]) => this.putSession(file, row));
    this.transaction(() => {
      this.meta("timeZone", ledger.timeZone); this.meta("retentionDays", retentionDays); this.meta("collectedAt", ledger.collectedAt);
      this.meta("bootstrap", { completedAt: new Date().toISOString(), sourceCollectedAt: ledger.collectedAt });
    });
  }
  importAudit(state) {
    const rows = auditRows(state), insert = this.statement(`INSERT INTO audit VALUES (?,?,?,?,?,?) ON CONFLICT(source,id)
      DO UPDATE SET repository=excluded.repository,number=excluded.number,updated_at=excluded.updated_at,
      payload=excluded.payload WHERE payload<>excluded.payload`);
    let changes = 0;
    for (let start = 0; start < rows.length; start += 100) this.transaction(() => {
      for (const row of rows.slice(start, start + 100)) {
        if (row.ingress === "historical" && this.statement("SELECT 1 FROM audit WHERE source<>'historical' AND json_extract(payload,'$.jobId')=? LIMIT 1").get(row.jobId)) continue;
        if (row.ingress !== "historical" && row.jobId) changes += this.statement("DELETE FROM audit WHERE source='historical' AND id=?").run(row.jobId).changes;
        changes += insert.run(row.ingress, row.id, row.repository, row.number || null, row.updatedAt, JSON.stringify(row)).changes;
      }
    });
    return changes;
  }
  async ingestSession(file, maxBytes = 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw Error("Invalid ingestion budget");
    const current = this.statement("SELECT payload FROM sessions WHERE file=?").get(file);
    if (!current) throw Error("Unknown session source; register attribution before ingestion");
    const row = JSON.parse(current.payload), fd = fs.openSync(file, "r");
    try {
      const stat = fs.fstatSync(fd), identity = `${stat.dev}:${stat.ino}`;
      // Rotation needs reconciliation, never silently re-add an already counted session.
      if (identity !== row.identity || stat.size < row.offset) throw Error("Session source replaced or truncated");
      if (stat.size === row.scannedSize) return { bytes: 0, changed: false };
      const end = Math.min(stat.size, row.offset + maxBytes);
      const offset = row.offset;
      const bytes = await this.readSession(file, row, this.meta("timeZone"), end, { fd });
      const finalStat = fs.fstatSync(fd), pathStat = fs.statSync(file);
      if (finalStat.size < end || `${pathStat.dev}:${pathStat.ino}` !== identity) throw Object.assign(Error("Session source changed during ingestion"), { bytes });
      if (row.offset === offset && end < stat.size) throw Object.assign(Error("Session line exceeds ingestion batch; source requires reconciliation"), { bytes });
      row.modifiedAt = stat.mtimeMs;
      const firstDay = shiftDay(dayKey(this.now(), this.meta("timeZone")), 1 - this.meta("retentionDays"));
      row.expired = Boolean(row.lastEventAt && dayKey(row.lastEventAt, this.meta("timeZone")) < firstDay);
      for (const day of Object.keys(row.days)) if (day < firstDay) { delete row.days[day]; delete row.phaseDays[day]; }
      row.usage = Object.values(row.days).reduce((sum, value) => {
        for (const key of columns) sum[key] += value[key] || 0;
        return sum;
      }, emptyUsage());
      row.phases = {};
      for (const phases of Object.values(row.phaseDays)) for (const [phase, value] of Object.entries(phases)) {
        const target = row.phases[phase] ||= emptyUsage();
        for (const key of columns) target[key] += value[key] || 0;
      }
      let changed;
      try { changed = this.transaction(() => {
        if (this.statement("SELECT payload FROM sessions WHERE file=?").get(file)?.payload !== current.payload) throw Error("Concurrent session update; retry collection");
        return this.putSession(file, row);
      }); }
      catch (error) { error.bytes = bytes; throw error; }
      return { bytes, changed: Boolean(changed), pending: end < stat.size };
    } finally { fs.closeSync(fd); }
  }
  daily({ repository = "", start, end, phase = "total" }) {
    return this.statement(`SELECT d.day,${columns.map((c) => `SUM(d.${c}) AS ${c}`).join(",")}
      FROM usage_days d JOIN sessions s ON s.file=d.file
      WHERE d.day>=? AND d.day<=? AND d.phase=? AND s.active=1 ${repository ? "AND s.repository=?" : ""}
      GROUP BY d.day ORDER BY d.day`).all(start, end, phase, ...(repository ? [repository] : []));
  }
  runs(repository, number, limit = 100, offset = 0) {
    checkPage(limit, offset);
    const jobs = this.statement("SELECT payload FROM jobs WHERE repository=? AND number=? ORDER BY created_at DESC,CAST(id AS INTEGER) DESC LIMIT ? OFFSET ?")
      .all(repository, number, limit, offset);
    return jobs.map(({ payload }) => {
      const job = JSON.parse(payload), result = runRows({ jobs: { [job.id]: job }, sessions: {} })[0];
      const aggregate = this.statement(`SELECT count(*) AS sessions,
        ${columns.map((c) => `COALESCE(SUM(json_extract(payload,'$.usage.${c}')),0) AS ${c}`).join(",")},
        COALESCE(SUM(CASE WHEN json_extract(payload,'$.resumed') THEN 1 ELSE 0 END),0) AS resumed,
        SUM(CASE WHEN json_extract(payload,'$.endedAt') IS NOT NULL THEN 1 ELSE 0 END) AS ended,
        SUM(CASE WHEN json_extract(payload,'$.endedAt') IS NOT NULL THEN json_extract(payload,'$.nativeSeconds') ELSE 0 END) AS nativeSeconds,
        MAX(CASE WHEN json_extract(payload,'$.endedAt') IS NULL OR json_extract(payload,'$.unreadableRecords')>0
          OR json_extract(payload,'$.usage.errors')>0 THEN 1 ELSE 0 END) AS partial
        FROM sessions WHERE job_id=? AND active=1`).get(String(job.id));
      result.usage = Object.fromEntries(columns.map((c) => [c, aggregate[c]]));
      result.sessions = aggregate.sessions; result.resumed = aggregate.resumed;
      result.nativeSeconds = aggregate.ended ? aggregate.nativeSeconds : null;
      result.partialUsage = !aggregate.sessions || Boolean(aggregate.partial);
      return result;
    });
  }

  audits(repository = "", limit = 100, offset = 0) {
    checkPage(limit, offset);
    return this.statement(`SELECT payload FROM audit ${repository ? "WHERE repository=?" : ""} ORDER BY updated_at DESC,source,id LIMIT ? OFFSET ?`)
      .all(...(repository ? [repository] : []), limit, offset).map((r) => JSON.parse(r.payload));
  }
  counts() {
    return Object.fromEntries(["jobs", "sessions", "usage_days", "audit"].map((table) => [table, this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
  }
  close() { this.db.close(); }
}
function checkPage(limit, offset) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) throw Error("Invalid pagination");
}
module.exports = { AuditSQLite };
