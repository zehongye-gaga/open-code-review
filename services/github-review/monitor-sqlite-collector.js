// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const fs = require("node:fs");
const { Monitor } = require("./monitor-data.js");
const { MonitorSQLite } = require("./monitor-sqlite.js");
const { ResourceTrends } = require("./resource-trends.js");

async function main() {
  const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const monitor = new Monitor(config), target = new MonitorSQLite(config, { readOnly: false });
  const trends = new ResourceTrends(config.resourceHistoryDirectory || "/var/lib/ocr-server-monitor/history");
  let stopped = false, timer, githubTimer;
  const github = async () => {
    await monitor.refreshGitHub();
    if (!stopped) githubTimer = setTimeout(github, 60000);
  };
  const collect = async () => {
    try {
      await monitor.collect();
      if (stopped) return;
      const resources = {};
      for (const hours of [1, 6, 24, 168]) {
        try { resources[hours] = trends.snapshot(hours); }
        catch { console.error("Resource collection failed; previous snapshot retained"); }
      }
      target.publish(monitor, resources);
    } catch { console.error("SQLite publication failed; previous generation retained"); }
    if (!stopped) timer = setTimeout(collect, 10000);
  };
  const stop = () => { stopped = true; clearTimeout(timer); clearTimeout(githubTimer); process.exit(0); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  void github(); await collect();
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exit(1); });
module.exports = { main };
