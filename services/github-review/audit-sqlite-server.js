// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const fs = require("node:fs");
const http = require("node:http");
const { AuditSQLite } = require("./audit-sqlite.js");

function createAuditServer(store) {
  return http.createServer((req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-type", "application/json");
    res.setHeader("x-content-type-options", "nosniff");
    const send = (status, value) => { res.writeHead(status); res.end(JSON.stringify(value)); };
    if (req.method !== "GET") return send(405, { error: "Read-only prototype" });
    try {
      const url = new URL(req.url, "http://localhost"), q = url.searchParams;
      const repository = q.get("repository") || "";
      if (repository && !/^[\w.-]+\/[\w.-]+$/.test(repository)) return send(400, { error: "Invalid repository" });
      const collectedAt = store.meta("collectedAt"), stale = !collectedAt || Date.now() - Date.parse(collectedAt) > 45000;
      if (!store.meta("bootstrap")) return send(503, { ready: false });
      const limit = Number(q.get("limit") || 100), offset = Number(q.get("offset") || 0);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) return send(400, { error: "Invalid pagination" });
      if (url.pathname === "/healthz") return send(200, { ready: true, mode: "isolated-prototype", collectedAt, stale });
      if (url.pathname === "/api/analytics/pr") {
        const number = Number(q.get("number"));
        if (!repository || !Number.isSafeInteger(number) || number < 1) return send(400, { error: "Invalid PR" });
        return send(200, { repository, number, collectedAt, stale, error: false, limit, offset, runs: store.runs(repository, number, limit, offset) });
      }
      if (url.pathname === "/api/audit") return send(200, { collectedAt, stale, limit, offset, rows: store.audits(repository, limit, offset) });
      if (url.pathname === "/api/usage/daily") {
        const start = q.get("start"), end = q.get("end"), valid = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "") && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
        if (!valid(start) || !valid(end) || start > end || Date.parse(end) - Date.parse(start) > 366 * 86400000) return send(400, { error: "Invalid date range" });
        return send(200, { collectedAt, stale, rows: store.daily({ repository, start, end, phase: q.get("phase") || "total" }) });
      }
      return send(404, { error: "Not found" });
    } catch { return send(503, { error: "Database query unavailable" }); }
  });
}
if (require.main === module) {
  const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const store = new AuditSQLite(config.database, { readOnly: true }), server = createAuditServer(store);
  server.listen(config.port || 8791, "127.0.0.1");
  const stop = () => { server.closeAllConnections(); server.close(() => store.close()); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}
module.exports = { createAuditServer };
