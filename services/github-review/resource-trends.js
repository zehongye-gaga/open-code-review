// SPDX-License-Identifier: Apache-2.0
"use strict";
const fs = require("node:fs"), path = require("node:path");
const finite = (n) => typeof n === "number" && Number.isFinite(n) ? n : null;
function summarize(rows, start, end) {
  const points = [], groups = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const time = Date.parse(row.sampled_at);
    if (!Number.isFinite(time) || time < start || time > end) continue;
    const load = row.load || {}, available = load.available === true;
    const point = { time, cpu: finite(row.metrics?.cpu), memory: finite(row.metrics?.memory),
      disk: finite(row.metrics?.["disk:/"]), running: available ? finite(load.running) : null,
      queued: available ? finite(load.queued) : null, dispatching: available ? finite(load.app_dispatching ?? load.agent_dispatching) : null,
      policyDispatching: finite(load.policy_dispatching_receipts), oldestWait: finite(load.oldest_queued_age_seconds), queueP95: finite(load.last_24h?.first_attempt_queue_seconds?.p95) };
    points.push(point);
    if (point.running === null) continue;
    if (!groups.has(point.running)) groups.set(point.running, []);
    groups.get(point.running).push(point);
  }
  points.sort((a, b) => a.time - b.time);
  const stats = (items, key) => {
    const values = items.map((p) => p[key]).filter((v) => v !== null);
    return { mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
      max: values.length ? Math.max(...values) : null };
  };
  return { scope: "host", start, end, samples: points.length, latest: points.at(-1)?.time || null,
    stale: !points.length || end - points.at(-1).time > 180000, points,
    groups: [...groups].sort((a, b) => a[0] - b[0]).map(([running, items]) => ({ running, samples: items.length,
      cpu: stats(items, "cpu"), memory: stats(items, "memory"), queue: stats(items, "queued"), wait: stats(items, "oldestWait") })) };
}
class ResourceTrends {
  constructor(directory) { this.directory = directory; this.cache = new Map(); }
  snapshot(hours, now = Date.now()) {
    if (![1, 6, 24, 168].includes(hours)) throw Object.assign(new Error("Invalid period"), { status: 400 });
    const cached = this.cache.get(hours);
    if (cached && now - cached.at < 30000) return cached.value;
    const start = now - hours * 3600000, rows = [];
    let missing = false, unreadable = 0, malformed = 0;
    for (let day = Math.floor(start / 86400000); day <= Math.floor(now / 86400000); day++) {
      const name = new Date(day * 86400000).toISOString().slice(0, 10) + ".jsonl";
      let contents;
      try { contents = fs.readFileSync(path.join(this.directory, name), "utf8"); }
      catch (error) { if (error.code !== "ENOENT") unreadable++; else missing = true; continue; }
      for (const line of contents.split("\n")) if (line.trim()) {
        try { rows.push(JSON.parse(line)); } catch { malformed++; }
      }
    }
    const value = { ...summarize(rows, start, now), missingFiles: missing, unreadableFiles: unreadable, malformedRows: malformed };
    this.cache.set(hours, { at: now, value }); return value;
  }
}
module.exports = { ResourceTrends, summarize };
