// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { setTimeout: sleep } = require("node:timers/promises");
const { Client } = require("pg");
const { metric } = require("./observability.js");
class ProbeState {
  constructor() {
    this.rows = new Map();
    this.lastSent = 0;
  }
  observe(key, failed, now) {
    const row = this.rows.get(key) || {
      bad: 0,
      good: 0,
      open: false,
      since: now,
      sent: false,
      notifiedAt: 0,
    };
    if (failed) {
      if (!row.bad) row.since = now;
      row.bad++;
      row.good = 0;
    } else {
      row.good++;
      row.bad = 0;
    }
    if (row.bad >= 2) row.open = true;
    const recovery = row.open && row.good >= 2;
    if (recovery) {
      row.open = false;
      row.recoveryPending = row.sent;
    }
    this.rows.set(key, row);
    const due =
      (row.open && failed && now - row.notifiedAt >= 1800000) ||
      (row.recoveryPending && !failed);
    return {
      key,
      row,
      recovery: row.recoveryPending && !failed,
      due: !!due && now - this.lastSent >= 60000,
    };
  }
  notified(event, now) {
    event.row.notifiedAt = now;
    event.row.sent = !event.recovery;
    event.row.recoveryPending = false;
    this.lastSent = now;
  }
}
async function databaseProbe(
  url,
  now = Date.now(),
  ClientClass = Client,
  targetRole = "reviewhub_collector",
) {
  const client = new ClientClass({
    connectionString: url,
    application_name: "reviewhub-emergency-probe",
    connectionTimeoutMillis: 2000,
    statement_timeout: 2000,
    query_timeout: 2500,
  });
  client.on("error", () => {});
  const deadline = setTimeout(() => void client.end().catch(() => {}), 5000);
  deadline.unref();
  try {
    await client.connect();
    const r = await client.query(
      `SELECT
      monitor_database_health($1) health,
      (SELECT last_evaluated_at FROM alert_worker_state WHERE id='alerts') evaluated,
      (SELECT bool_or(collected_at IS NULL OR collected_at<now()-make_interval(secs=>interval_seconds*3) OR error IS NOT NULL) FROM audit_sources) stale`,
      [targetRole],
    );
    const evaluated = r.rows[0]?.evaluated;
    const result = {
      postgres: false,
      alert_worker: !evaluated || now - new Date(evaluated).getTime() > 180000,
      collector_data: r.rows[0]?.stale === true,
    };
    const sample = metric(
      "platform",
      "notifications",
      "emergency_probe",
      {
        probe_failures: Object.values(result).filter(Boolean).length,
      },
      now,
    );
    await client
      .query(
        `INSERT INTO monitor_samples(source_id,id,component,dimension,observed_at,data)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [
          sample.sourceId,
          sample.id,
          sample.component,
          sample.dimension,
          sample.at,
          JSON.stringify(sample),
        ],
      )
      .catch(() => {
        result.probe_archive = true;
      });
    if (r.rows[0]?.health) {
      const health = metric(
        "platform",
        "postgres",
        targetRole,
        r.rows[0].health,
        now,
      );
      await client
        .query(
          `INSERT INTO monitor_samples(source_id,id,component,dimension,observed_at,data)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [
            health.sourceId,
            health.id,
            health.component,
            health.dimension,
            health.at,
            JSON.stringify(health),
          ],
        )
        .catch(() => {
          result.probe_archive = true;
        });
    }
    return result;
  } finally {
    clearTimeout(deadline);
    await client.end().catch(() => {});
  }
}
async function notify(url, text, request = fetch) {
  const response = await request(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msg_type: "text", content: { text } }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error("PROBE_NOTIFY_HTTP");
  }
  const data = await response.json();
  if ((data.code ?? data.StatusCode) !== 0)
    throw Error("PROBE_NOTIFY_REJECTED");
}
async function run() {
  const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  if (
    !["shadow", "active"].includes(config.mode) ||
    !process.env.REVIEWHUB_MONITOR_DATABASE_URL
  )
    throw Error("Invalid health probe configuration");
  const api = new URL(config.apiHealthUrl);
  if (
    !["https:", "http:"].includes(api.protocol) ||
    api.username ||
    api.password ||
    api.search ||
    api.hash
  )
    throw Error("Invalid API health URL");
  let webhook;
  if (config.mode === "active") {
    webhook = new URL(fs.readFileSync(config.webhookFile, "utf8").trim());
    if (
      webhook.origin !== "https://open.feishu.cn" ||
      !/^\/open-apis\/bot\/v2\/hook\/[a-f0-9-]+$/.test(webhook.pathname) ||
      webhook.username ||
      webhook.password ||
      webhook.search ||
      webhook.hash
    )
      throw Error("Invalid probe destination");
  }
  const abort = new AbortController(),
    states = new ProbeState();
  process.once("SIGTERM", () => abort.abort());
  process.once("SIGINT", () => abort.abort());
  while (!abort.signal.aborted) {
    const now = Date.now(),
      values = {};
    try {
      Object.assign(
        values,
        await databaseProbe(
          process.env.REVIEWHUB_MONITOR_DATABASE_URL,
          now,
          Client,
          config.targetRole || "reviewhub_collector",
        ),
      );
    } catch {
      values.postgres = true;
    }
    try {
      const response = await fetch(api, {
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      });
      values.api = !response.ok;
      await response.body?.cancel();
    } catch {
      values.api = true;
    }
    try {
      await promisify(execFile)(
        "systemctl",
        ["is-active", "--quiet", "ocr-reviewhub-collector.service"],
        { timeout: 2000 },
      );
      values.collector_service = false;
    } catch {
      values.collector_service = true;
    }
    for (const [key, failed] of Object.entries(values)) {
      const event = states.observe(key, failed, now);
      if (!event.due) continue;
      if (config.mode === "active") {
        try {
          await notify(
            webhook,
            `ReviewHub ${event.recovery ? "RECOVERED" : "UNAVAILABLE"}: ${key}\nObserved: ${new Date(now).toISOString()}\nHealth probe only; review execution state is not inferred.`,
          );
          states.notified(event, now);
        } catch {
          console.error(
            JSON.stringify({
              service: "reviewhub-health",
              code: "PROBE_NOTIFICATION_FAILED",
            }),
          );
        }
      } else states.notified(event, now);
      console.info(
        JSON.stringify({
          service: "reviewhub-health",
          mode: config.mode,
          component: key,
          recovery: event.recovery,
          at: new Date(now).toISOString(),
        }),
      );
    }
    if (process.argv.includes("--once")) return;
    await sleep(60000 + Math.floor(Math.random() * 5000), undefined, {
      signal: abort.signal,
    }).catch(() => {});
  }
}
if (require.main === module)
  run().catch(() => {
    console.error(
      "Health probe failed; inspect configuration and dedicated monitor grants",
    );
    process.exitCode = 1;
  });
module.exports = { ProbeState, databaseProbe, notify };
