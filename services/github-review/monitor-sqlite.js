// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const { AuditSQLite } = require("./audit-sqlite.js");

class MonitorSQLite {
  constructor(options, { readOnly = true, now = Date.now } = {}) {
    this.options = options; this.now = now;
    this.store = new AuditSQLite(options.sqlite.database, { readOnly });
    if (!readOnly) this.store.db.exec("CREATE TABLE IF NOT EXISTS dashboard_snapshots (key TEXT PRIMARY KEY,payload TEXT NOT NULL)");
  }
  publish(monitor, resources = {}) {
    const analyticsFailed = monitor.local?.analytics?.error === true;
    if (!analyticsFailed) monitor.publishedAnalytics = monitor.analyticsViews();
    const root = monitor.snapshot(), snapshots = new Map([["status:", root]]);
    if (!root.ready) throw Error("No complete monitor collection");
    for (const repository of root.repositories) snapshots.set(`status:${repository}`, monitor.snapshot(repository));
    for (const [hours, value] of Object.entries(resources)) snapshots.set(`resources:${hours}`, value);
    if (analyticsFailed) for (const [key, snapshot] of snapshots) if (key.startsWith("status:")) {
      const previous = this.value(key);
      snapshot.analytics = { ...(previous?.analytics || { enabled: true }), error: true };
      snapshot.repositoryUsage = previous?.repositoryUsage || [];
    }
    const encoded = [...snapshots].map(([key, value]) => {
      const payload = JSON.stringify(value);
      if (Buffer.byteLength(payload) > 32 * 1024 * 1024) throw Error("Dashboard snapshot exceeds size limit");
      return [key, payload];
    });
    const ledger = monitor.analytics?.ledger;
    this.store.transaction(() => {
      const put = this.store.statement("INSERT INTO dashboard_snapshots VALUES (?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload");
      for (const [key, value] of encoded) put.run(key, value);
      this.store.db.exec("CREATE TEMP TABLE IF NOT EXISTS retained_jobs(id TEXT PRIMARY KEY); DELETE FROM retained_jobs; CREATE TEMP TABLE IF NOT EXISTS retained_sessions(file TEXT PRIMARY KEY); DELETE FROM retained_sessions;");
      if (ledger && !analyticsFailed) {
        for (const job of Object.values(ledger.jobs)) {
          this.store.putJob(job); this.store.statement("INSERT INTO retained_jobs VALUES (?)").run(String(job.id));
        }
        for (const [file, row] of Object.entries(ledger.sessions)) {
          this.store.putSession(file, row); this.store.statement("INSERT INTO retained_sessions VALUES (?)").run(file);
        }
      }
      if (!analyticsFailed) this.store.db.exec("DELETE FROM jobs WHERE id NOT IN (SELECT id FROM retained_jobs); DELETE FROM sessions WHERE file NOT IN (SELECT file FROM retained_sessions)");
      const keys = new Set(encoded.filter(([key]) => key.startsWith("status:")).map(([key]) => key));
      for (const { key } of this.store.statement("SELECT key FROM dashboard_snapshots WHERE key LIKE 'status:%'").all()) {
        if (!keys.has(key)) this.store.statement("DELETE FROM dashboard_snapshots WHERE key=?").run(key);
      }
      this.store.meta("dashboard", { publishedAt: new Date(this.now()).toISOString(), collectedAt: root.collectedAt });
    });
    return { repositories: root.repositories.length, runs: Object.keys(ledger?.jobs || {}).length };
  }
  value(key) {
    const row = this.store.statement("SELECT payload FROM dashboard_snapshots WHERE key=?").get(key);
    return row ? JSON.parse(row.payload) : null;
  }
  snapshot(repository = "") {
    repository = repository.toLowerCase();
    const value = this.value(`status:${repository}`);
    if (!value) {
      if (repository) throw Object.assign(Error("Unknown repository"), { status: 404 });
      return { version: 1, ready: false, collectedAt: null };
    }
    const now = this.now(), age = (time) => Number.isFinite(Date.parse(time)) ? Math.max(0, (now - Date.parse(time)) / 1000) : Infinity;
    value.stale = age(value.collectedAt) > 45;
    value.github.stale = age(value.github.updatedAt) > 180;
    for (const service of Object.values(value.services)) if (service) {
      service.pollStale = age(service.lastPoll) > Math.max(90, service.pollSeconds * 3);
      service.healthy = service.healthy && !service.pollStale && !value.stale;
      for (const source of service.sources || []) source.stale = age(source.lastPoll) > Math.max(90, service.pollSeconds * 3);
    }
    for (const job of value.work) {
      const elapsed = age(job.startedAt || job.createdAt || job.updatedAt);
      job.elapsedSeconds = Number.isFinite(elapsed) ? elapsed : null;
      job.overdue = job.state === "running" && age(job.startedAt || job.updatedAt) > (value.services[job.engine]?.timeoutSeconds || 2700) + 120;
    }
    if (value.agentUsage) value.agentUsage.stale = age(value.agentUsage.collectedAt) > 180;
    value.storage = { engine: "sqlite" };
    return value;
  }
  analyticsPull(repository, number) {
    // Metadata and runs must come from the same committed publication.
    this.store.db.exec("BEGIN");
    try {
      const snapshot = this.value("status:");
      if (!snapshot?.analytics?.collectedAt) return null;
      const runs = [];
      for (let offset = 0; ; offset += 200) {
        const rows = this.store.runs(repository, number, 200, offset); runs.push(...rows);
        if (rows.length < 200) break;
        if (runs.length >= 10000) throw Error("PR history exceeds response limit");
      }
      return { repository, number, collectedAt: snapshot.analytics.collectedAt, error: snapshot.analytics.error,
        stale: this.now() - Date.parse(snapshot.collectedAt) > 45000, runs };
    } finally { this.store.db.exec("ROLLBACK"); }
  }
  resourceSnapshot(hours) {
    if (![1, 6, 24, 168].includes(hours)) throw Object.assign(Error("Invalid period"), { status: 400 });
    const value = this.value(`resources:${hours}`);
    if (!value) throw Error("Resource history unavailable");
    value.stale = !value.latest || this.now() - value.latest > 180000;
    return value;
  }
  close() { this.store.close(); }
}
module.exports = { MonitorSQLite };
