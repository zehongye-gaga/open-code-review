// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { Monitor } = require("./monitor-data.js");

function createMonitorServer(monitor, { bearerToken } = {}) {
  const copy = JSON.parse(fs.readFileSync(path.join(__dirname, "monitor-web", "i18n", "zh-CN.json"), "utf8"));
  const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const assets = new Map([["/", ["index.html", "text/html; charset=utf-8"]],
    ["/monitor.css", ["monitor.css", "text/css; charset=utf-8"]],
    ["/monitor-view.js", ["monitor-view.js", "text/javascript; charset=utf-8"]],
    ["/monitor-analytics.js", ["monitor-analytics.js", "text/javascript; charset=utf-8"]],
    ["/monitor-ui.js", ["monitor-ui.js", "text/javascript; charset=utf-8"]]]
    .map(([route, [file, type]]) => [route, { body: fs.readFileSync(path.join(__dirname, "monitor-web", file)), type }]));
  assets.get("/").body = assets.get("/").body.toString("utf8").replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (key === "copy") return JSON.stringify(copy).replace(/</g, "\\u003c");
    if (!Object.hasOwn(copy, key)) throw new Error(`Missing dashboard translation: ${key}`);
    return escape(copy[key]);
  });
  return http.createServer((req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.method !== "GET") { res.setHeader("allow", "GET"); return send(405, { error: "Read-only monitor" }); }
    if (bearerToken) {
      const supplied = Buffer.from(req.headers.authorization || ""), expected = Buffer.from(`Bearer ${bearerToken}`);
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return send(401, { error: "Unauthorized" });
    }
    let url;
    try { url = new URL(req.url, "http://localhost"); }
    catch { return send(400, { error: "Invalid URL" }); }
    if (url.pathname === "/api/status") {
      const repository = url.searchParams.get("repository") || "";
      if (repository && !/^[\w.-]+\/[\w.-]+$/.test(repository)) return send(400, { error: "Invalid repository" });
      try { return send(200, monitor.snapshot(repository)); }
      catch (error) { return send(error.status || 503, { error: error.status === 404 ? "Unknown repository" : "Snapshot unavailable" }); }
    }
    if (url.pathname === "/api/analytics/pr") {
      const repository = url.searchParams.get("repository"), number = Number(url.searchParams.get("number"));
      if (!/^[\w.-]+\/[\w.-]+$/.test(repository || "") || !Number.isSafeInteger(number) || number < 1) {
        return send(400, { error: "A repository and positive PR number are required" });
      }
      const result = monitor.analyticsPull?.(repository.toLowerCase(), number);
      return result ? send(200, result) : send(503, { error: "Analytics unavailable" });
    }
    if (req.url === "/healthz") {
      const snapshot = monitor.snapshot();
      return send(snapshot.ready && !snapshot.stale ? 200 : 503, { ready: snapshot.ready, collectedAt: snapshot.collectedAt });
    }
    const asset = assets.get(url.pathname);
    if (!asset) return send(404, { error: "Not found" });
    res.writeHead(200, { "content-type": asset.type });
    res.end(asset.body);
  });
}

async function main() {
  const file = process.argv[2] || process.env.OCR_MONITOR_CONFIG;
  if (!file) throw new Error("Usage: node services/github-review/monitor.js /path/to/monitor.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const port = config.port ?? 8788;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Invalid monitor port");
  const monitor = new Monitor(config);
  const bearerToken = config.bearerTokenFile ? fs.readFileSync(config.bearerTokenFile, "utf8").trim() : null;
  if (config.bearerTokenFile && !bearerToken) throw new Error("Empty monitor credential");
  const server = createMonitorServer(monitor, { bearerToken });
  const safe = (fn) => () => fn().catch(() => console.error("Monitor collection failed; last snapshot retained"));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, config.listen || "127.0.0.1", resolve); });
  console.log(JSON.stringify({ event: "monitor_listening", address: server.address() }));
  const collect = safe(() => monitor.collect()), github = safe(() => monitor.refreshGitHub());
  void collect(); void github();
  const localTimer = setInterval(collect, 10000), githubTimer = setInterval(github, 60000);
  const stop = () => { clearInterval(localTimer); clearInterval(githubTimer); server.close(); server.closeIdleConnections(); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exit(1); });
module.exports = { createMonitorServer, main };
