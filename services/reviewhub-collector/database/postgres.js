// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const { Client } = require("pg");
const { createHash } = require("node:crypto");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const ajv = new Ajv({ allErrors: false, strict: false });
addFormats(ajv);
const schema = require("../audit-ingestion-v1.schema.json");
const validate = ajv.compile(schema);
const validateMetric = ajv.compile(schema.properties.metrics.items);
const tables = {
  repositories: "audit_repositories",
  runs: "audit_runs",
  events: "audit_events",
  findings: "audit_findings",
  usage: "audit_usage",
  resources: "audit_resources",
  clientAttempts: "audit_client_attempts",
  clientCoverage: "audit_client_coverage",
  signals: "audit_alert_signals",
  metrics: "monitor_samples",
};
class PostgresStore {
  constructor(connectionString, sourceId) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(sourceId))
      throw Error("Invalid source identifier");
    this.sourceId = sourceId;
    this.client = new Client({
      connectionString,
      application_name: "reviewhub-collector",
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
      idle_in_transaction_session_timeout: 30000,
    });
    this.client.on("error", () => {
      this.failed = true;
    });
    this.previous = new Map();
    this.normalized = new Map();
  }
  async connect() {
    await this.client.connect();
    const lock = await this.client.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
      ["reviewhub:" + this.sourceId],
    );
    if (!lock.rows[0].acquired)
      throw Error("Another collector owns this source");
    this.locked = true;
    const migration = await this.client.query(
      "SELECT 1 FROM schema_migrations WHERE version IN ('004_audit.sql','005_client_audit.sql','006_observability.sql')",
    );
    if (migration.rowCount !== 3)
      throw Error(
        "Apply ReviewHub audit migration before starting the collector",
      );
    await this.client.query(
      "INSERT INTO audit_sources(id) VALUES($1) ON CONFLICT DO NOTHING",
      [this.sourceId],
    );
    const result = await this.client.query(
      "SELECT contract_version,checkpoint FROM audit_sources WHERE id=$1",
      [this.sourceId],
    );
    if (result.rows[0].contract_version !== 1)
      throw Error("Unsupported ReviewHub audit schema");
    this.checkpoint = result.rows[0].checkpoint;
    const records = await this.client.query(
      "SELECT key,data FROM collector_records WHERE source_id=$1",
      [this.sourceId],
    );
    this.previous = new Map(
      records.rows.map((r) => [r.key, JSON.stringify(r.data)]),
    );
    return {
      checkpoint: this.checkpoint,
      records: new Map(records.rows.map((r) => [r.key, r.data])),
    };
  }
  async publish(batch, checkpoint, records) {
    if (this.failed) throw Error("Collector database connection was lost");
    if (!validate(batch) || batch.sourceId !== this.sourceId)
      throw Error(
        "Invalid normalized audit batch: " +
          (validate.errors?.[0]?.instancePath || "sourceId"),
      );
    for (const kind of Object.keys(tables)) {
      const ids = new Set();
      for (const row of batch[kind] || []) {
        if (ids.has(row.id)) throw Error("Duplicate audit record identity");
        ids.add(row.id);
      }
    }
    const normalized = new Map();
    const updates = {};
    for (const kind of Object.keys(tables))
      updates[kind] = (batch[kind] || []).filter((row) => {
        const key = kind + ":" + row.id,
          hash = createHash("sha256").update(JSON.stringify(row)).digest("hex");
        normalized.set(key, hash);
        return this.normalized.get(key) !== hash;
      });
    const changed = [],
      removed = [];
    const next = new Map();
    for (const [key, data] of records) {
      const encoded = JSON.stringify(data);
      next.set(key, encoded);
      if (this.previous.get(key) !== encoded) changed.push({ key, data });
    }
    for (const key of this.previous.keys())
      if (!next.has(key)) removed.push(key);
    const start = performance.now();
    let rowsWritten = 0,
      bytes = 0;
    const write = async (sql, args) => {
      bytes += Buffer.byteLength(JSON.stringify(args || []));
      const result = await this.client.query(sql, args);
      rowsWritten += result.rowCount || 0;
      return result;
    };
    await this.client.query("BEGIN");
    try {
      await write(
        "UPDATE audit_repositories SET in_scope=false WHERE source_id=$1 AND in_scope AND NOT (id=ANY($2::text[]))",
        [this.sourceId, batch.repositories.map((r) => r.id)],
      );
      await write(
        "UPDATE audit_runs SET data=jsonb_set(data,'{current}','false') WHERE source_id=$1 AND (data->>'current')::boolean AND NOT (id=ANY($2::text[]))",
        [this.sourceId, batch.runs.filter((r) => r.current).map((r) => r.id)],
      );
      if (batch.signals)
        await write(
          "UPDATE audit_alert_signals SET current=false WHERE source_id=$1 AND current AND NOT(id=ANY($2::text[]))",
          [this.sourceId, batch.signals.map((s) => s.id)],
        );
      for (const [kind, table] of Object.entries(tables)) {
        const rows = updates[kind];
        for (let i = 0; i < rows.length; i += 250) {
          const page = JSON.stringify(rows.slice(i, i + 250));
          if (kind === "repositories") {
            await write(
              `INSERT INTO ${table}(source_id,id,data) SELECT $1,j->>'id',j FROM jsonb_array_elements($2::jsonb) j
              ON CONFLICT(source_id,id) DO UPDATE SET data=EXCLUDED.data,in_scope=true WHERE NOT ${table}.in_scope OR ${table}.data IS DISTINCT FROM EXCLUDED.data`,
              [this.sourceId, page],
            );
          } else if (kind === "signals") {
            await write(
              `INSERT INTO audit_alert_signals(source_id,id,repository_id,collected_at,current,data)
              SELECT $1,j->>'id',j->>'repositoryId',$3,true,j FROM jsonb_array_elements($2::jsonb) j
              ON CONFLICT(source_id,id) DO UPDATE SET current=true,collected_at=$3,data=EXCLUDED.data
              WHERE NOT audit_alert_signals.current OR audit_alert_signals.data IS DISTINCT FROM EXCLUDED.data`,
              [this.sourceId, page, batch.collectedAt],
            );
          } else if (kind === "metrics") {
            await write(
              `INSERT INTO monitor_samples(source_id,id,component,dimension,observed_at,data)
              SELECT $1,j->>'id',j->>'component',j->>'dimension',(j->>'at')::timestamptz,j FROM jsonb_array_elements($2::jsonb) j
              ON CONFLICT(source_id,id) DO NOTHING`,
              [this.sourceId, page],
            );
          } else if (kind === "resources") {
            await write(
              `INSERT INTO ${table}(source_id,id,occurred_at,data) SELECT $1,j->>'id',(j->>'at')::timestamptz,j FROM jsonb_array_elements($2::jsonb) j
              ON CONFLICT(source_id,id) DO UPDATE SET data=EXCLUDED.data WHERE ${table}.data IS DISTINCT FROM EXCLUDED.data`,
              [this.sourceId, page],
            );
          } else {
            const field =
              kind === "runs"
                ? "createdAt"
                : kind === "clientCoverage"
                  ? "checkedAt"
                  : "at";
            await write(
              `INSERT INTO ${table}(source_id,id,repository_id,occurred_at,data)
              SELECT $1,j->>'id',j->>'repositoryId',(j->>'${field}')::timestamptz,j FROM jsonb_array_elements($2::jsonb) j
              ON CONFLICT(source_id,id) DO UPDATE SET repository_id=EXCLUDED.repository_id,occurred_at=EXCLUDED.occurred_at,data=EXCLUDED.data
              WHERE ${table}.data IS DISTINCT FROM EXCLUDED.data`,
              [this.sourceId, page],
            );
          }
        }
      }
      for (let i = 0; i < changed.length; i += 250)
        await write(
          `INSERT INTO collector_records(source_id,key,data)
        SELECT $1,j->>'key',j->'data' FROM jsonb_array_elements($2::jsonb) j
        ON CONFLICT(source_id,key) DO UPDATE SET data=EXCLUDED.data`,
          [this.sourceId, JSON.stringify(changed.slice(i, i + 250))],
        );
      if (removed.length)
        await write(
          "DELETE FROM collector_records WHERE source_id=$1 AND key=ANY($2::text[])",
          [this.sourceId, removed],
        );
      for (const table of [
        "audit_events",
        "audit_findings",
        "audit_usage",
        "audit_resources",
        "audit_client_attempts",
      ]) {
        await write(
          `DELETE FROM ${table} WHERE source_id=$1 AND occurred_at < $2::timestamptz - interval '90 days'`,
          [this.sourceId, batch.collectedAt],
        );
      }
      await write(
        "DELETE FROM audit_runs WHERE source_id=$1 AND occurred_at < $2::timestamptz - interval '90 days' AND data->>'state' NOT IN ('queued','running')",
        [this.sourceId, batch.collectedAt],
      );
      await write(
        `UPDATE audit_sources SET collected_at=$2,source_updated_at=$3,last_attempt_at=now(),interval_seconds=$4,error=NULL,warnings=$5,checkpoint=$6 WHERE id=$1`,
        [
          this.sourceId,
          batch.collectedAt,
          batch.sourceUpdatedAt,
          batch.intervalSeconds,
          JSON.stringify(batch.warnings),
          JSON.stringify(checkpoint),
        ],
      );
      await write("COMMIT");
      this.previous = next;
      this.normalized = normalized;
      this.checkpoint = checkpoint;
      return { ms: performance.now() - start, rows: rowsWritten, bytes };
    } catch (error) {
      await this.client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  }
  async repositoryScope(organizations) {
    if (this.failed) throw Error("Collector database connection was lost");
    const result = await this.client.query(
      "SELECT data FROM reviewhub_audit_repository_scope_v1 WHERE organization=ANY($1::text[]) ORDER BY repository_id LIMIT 10001",
      [organizations],
    );
    return result.rows.map(row => row.data);
  }
  async saveMetric(sample) {
    if (!validateMetric(sample) || sample.sourceId !== this.sourceId)
      throw Error("Invalid metric sample");
    await this.client.query(
      `INSERT INTO monitor_samples(source_id,id,component,dimension,observed_at,data)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [
        this.sourceId,
        sample.id,
        sample.component,
        sample.dimension,
        sample.at,
        JSON.stringify(sample),
      ],
    );
  }
  async failure(code) {
    if (!this.locked) return;
    if (!/^[A-Z_]{1,80}$/.test(code)) code = "COLLECTION_FAILED";
    await this.client.query(
      "UPDATE audit_sources SET error=$2,last_attempt_at=now() WHERE id=$1",
      [this.sourceId, code],
    );
  }
  async close() {
    await this.client.end().catch(() => {});
  }
}
module.exports = { PostgresStore, validate };
