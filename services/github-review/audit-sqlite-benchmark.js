// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { AuditSQLite } = require("./audit-sqlite.js");
const { summarize, runRows, dayKey, shiftDay, emptyUsage } = require("./analytics-summary.js");
const { auditRows } = require("./monitor-audit.js");

async function benchmark(options) {
  const store = new AuditSQLite(options.database), results = { measurements: [], validation: {} };
  const measure = async (name, task) => {
    const cpu = process.cpuUsage(), at = performance.now(), result = await task();
    const used = process.cpuUsage(cpu);
    results.measurements.push({ name, wallMs: performance.now() - at, cpuMs: (used.user + used.system) / 1000,
      rssBytes: process.memoryUsage().rss, peakRssKiB: process.resourceUsage().maxRSS });
    return result;
  };
  try {
    const ledger = await measure("read_seed", () => readJSON(options.ledger));
    if (!store.meta("bootstrap")) await measure("bootstrap_ledger", () => store.importLedger(ledger, { retentionDays: options.retentionDays || 90 }));
    const state = readJSON(options.state);
    await measure("bootstrap_audit", () => store.importAudit(state));
    results.counts = store.counts();
    const now = Date.parse(ledger.collectedAt), timeZone = ledger.timeZone;
    const start = shiftDay(dayKey(now, timeZone), 1 - (options.retentionDays || 90)), end = dayKey(now, timeZone);
    const summary = await measure("legacy_summary", () => summarize(ledger, { retentionDays: options.retentionDays || 90, timeZone }, now));
    await measure("sqlite_daily_query", () => {
      const rows = store.daily({ start, end });
      const expected = summary.daily.filter((r) => Object.values(r.usage).some(Boolean));
      const nonzero = rows.filter((r) => Object.keys(emptyUsage()).some((key) => r[key]));
      assert.equal(nonzero.length, expected.length);
      for (const row of nonzero) for (const key of Object.keys(emptyUsage())) {
        assert.ok(Math.abs(row[key] - expected.find((r) => r.key === row.day).usage[key]) < 0.0001, `Daily metric mismatch: ${key}`);
      }
    });
    const runs = runRows(ledger), prs = new Map();
    for (const run of runs) {
      const key = `${run.repository}#${run.number}`;
      if (!prs.has(key)) prs.set(key, []);
      prs.get(key).push(run);
    }
    for (const rows of prs.values()) rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || Number(b.id) - Number(a.id));
    const latencies = [], actual = new Map();
    await measure("sqlite_all_pr_queries", () => {
      for (const [key, expected] of prs) {
        const { repository, number } = expected[0], rows = [], at = performance.now();
        for (let offset = 0; offset < expected.length; offset += 100) rows.push(...store.runs(repository, number, 100, offset));
        latencies.push(performance.now() - at); actual.set(key, rows);
      }
    });
    const normalize = (items) => items.map((row) => ({ ...row,
      nativeSeconds: row.nativeSeconds === null ? null : Math.round(row.nativeSeconds * 1e6) / 1e6,
      usage: { ...row.usage, llmSeconds: Math.round(row.usage.llmSeconds * 1e6) / 1e6 } }));
    for (const [key, expected] of prs) assert.deepEqual(normalize(actual.get(key)), normalize(expected));
    assert.equal(store.counts().audit, auditRows(state).length);
    await measure("repeat_import_no_changes", () => {
      let changes = 0;
      store.transaction(() => {
        for (const job of Object.values(ledger.jobs)) changes += store.putJob(job);
        for (const [file, row] of Object.entries(ledger.sessions)) changes += store.putSession(file, row);
      });
      changes += store.importAudit(state); assert.equal(changes, 0);
    });
    results.validation = { daily: "match", prRuns: "match", checkedPRs: prs.size, checkedRuns: runs.length,
      repeatImport: "zero_changes", secondsPrecision: "1_microsecond", integrity: store.db.prepare("PRAGMA integrity_check").get().integrity_check };
    latencies.sort((a, b) => a - b);
    results.prQueryMs = { median: latencies[Math.floor(latencies.length / 2)], p95: latencies[Math.ceil(latencies.length * .95) - 1], max: latencies.at(-1) };
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    results.databaseBytes = fs.statSync(options.database).size;
    return results;
  } finally { store.close(); }
}
function readJSON(file) {
  if (fs.statSync(file).size > 32 * 1024 * 1024) throw Error("Seed exceeds bounded prototype import size");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
if (require.main === module) benchmark(readJSON(process.argv[2])).then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { benchmark };
