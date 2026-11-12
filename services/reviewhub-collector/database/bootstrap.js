// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const { AuditSQLite } = require("../../github-review/audit-sqlite.js");
function bootstrapAudit(file, maxBytes = 64 * 1024 * 1024) {
  const source = new AuditSQLite(file, { readOnly: true });
  try {
    source.db.exec("BEGIN");
    let size = 0;
    for (const table of ["jobs", "sessions", "audit"])
      size += source.db
        .prepare(
          `SELECT coalesce(sum(length(cast(payload AS BLOB))),0) n FROM ${table}`
        )
        .get().n;
    if (size > maxBytes) throw Error("Audit bootstrap exceeds memory budget");
    const jobs = Object.fromEntries(
      source.db
        .prepare("SELECT id,payload FROM jobs")
        .all()
        .map((row) => [row.id, JSON.parse(row.payload)])
    );
    const sessions = Object.fromEntries(
      source.db
        .prepare("SELECT file,payload FROM sessions")
        .all()
        .map((row) => [row.file, JSON.parse(row.payload)])
    );
    const audits = source.db
      .prepare("SELECT payload FROM audit")
      .all()
      .map((row) => JSON.parse(row.payload));
    const published =
      source.meta("dashboard")?.collectedAt || source.meta("collectedAt");
    return {
      ledger: {
        version: 2,
        timeZone: "Asia/Shanghai",
        jobs,
        sessions,
        artifacts: {},
        collectedAt: published || null,
        firstCollectedAt: published || null
      },
      audits
    };
  } finally {
    try {
      source.db.exec("ROLLBACK");
    } finally {
      source.close();
    }
  }
}
module.exports = { bootstrapAudit };
