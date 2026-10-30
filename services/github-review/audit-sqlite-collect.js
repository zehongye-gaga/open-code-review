// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const fs = require("node:fs");
const { AuditSQLite } = require("./audit-sqlite.js");

async function collectRegisteredSessions(store, { maxFiles = 100, maxBytes = 8 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 1000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 64 * 1024 * 1024) throw Error("Invalid collection budget");
  if (!store.meta("bootstrap")) throw Error("Bootstrap incomplete");
  const after = store.meta("sessionScanCursor") || "";
  const files = store.statement("SELECT file FROM sessions WHERE file>? ORDER BY file LIMIT ?").all(after, maxFiles);
  let scanned = 0, bytes = 0, changed = 0, missing = 0, errors = 0, last = after;
  const started = performance.now(), cpu = process.cpuUsage();
  for (const { file } of files) {
    if (bytes >= maxBytes) break;
    try {
      const result = await store.ingestSession(file, Math.min(maxBytes - bytes, 8 * 1024 * 1024));
      bytes += result.bytes; if (result.changed) changed++;
    } catch (error) {
      bytes += error.bytes || 0;
      if (error.code === "ENOENT") missing++; else errors++;
    }
    scanned++; last = file;
  }
  const remaining = store.statement("SELECT count(*) AS n FROM sessions WHERE file>?").get(last).n;
  const used = process.cpuUsage(cpu);
  const result = { scope: "registered_sessions_only", scanned, bytes, changed, missing, errors, remaining,
    completedAt: new Date().toISOString(), wallMs: performance.now() - started, cpuMs: (used.user + used.system) / 1000,
    rssBytes: process.memoryUsage().rss, peakRssKiB: process.resourceUsage().maxRSS };
  store.transaction(() => { store.meta("sessionScanCursor", remaining ? last : ""); store.meta("lastSessionScan", result); });
  return result;
}
if (require.main === module) {
  const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8")), store = new AuditSQLite(config.database);
  collectRegisteredSessions(store, config).then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => store.close());
}
module.exports = { collectRegisteredSessions };
