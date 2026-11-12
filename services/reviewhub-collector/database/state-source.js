// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const { SQLiteState, inflate } = require("../../github-review/state-sqlite.js");
function readState(
  file,
  saved = {},
  previous = new Map(),
  maxBytes = 64 * 1024 * 1024
) {
  const source = new SQLiteState(file, { readOnly: true });
  try {
    source.db.exec("PRAGMA query_only=ON; BEGIN");
    const head = source.db.prepare("SELECT * FROM state_head WHERE id=1").get();
    if (!head) throw Error("Source state has not been initialized");
    const oldest = source.db
      .prepare("SELECT min(revision) AS n FROM state_changes")
      .get().n;
    const incremental =
      saved.epoch === head.epoch &&
      saved.revision <= head.revision &&
      source.db
        .prepare("SELECT token FROM state_commits WHERE revision=?")
        .get(saved.revision)?.token === saved.token &&
      (saved.revision === head.revision ||
        (oldest !== null && saved.revision >= oldest - 1));
    let rows, changes;
    if (incremental) {
      const size = source.db
        .prepare(
          "SELECT coalesce(sum(length(cast(payload AS BLOB))),0) n FROM state_changes WHERE revision>? AND revision<=?"
        )
        .get(saved.revision, head.revision).n;
      if (size > maxBytes) return readState(file, {}, new Map(), maxBytes);
      changes = source.db
        .prepare(
          `SELECT key,payload FROM (SELECT key,payload,row_number() OVER(PARTITION BY key ORDER BY revision DESC) n
        FROM state_changes WHERE revision>? AND revision<=?) WHERE n=1`
        )
        .all(saved.revision, head.revision);
      rows = new Map(previous);
      for (const row of changes) {
        if (row.payload === null) rows.delete(row.key);
        else rows.set(row.key, JSON.parse(row.payload));
      }
    } else {
      const size = source.db
        .prepare(
          "SELECT coalesce(sum(length(cast(key AS BLOB))+length(cast(payload AS BLOB))),0) n FROM state_rows"
        )
        .get().n;
      if (size > maxBytes)
        throw Error("Source snapshot exceeds configured memory budget");
      rows = new Map(
        [...source.readRows()].map(([key, value]) => [key, JSON.parse(value)])
      );
      changes = [...rows];
    }
    let bytes = 0;
    for (const [key, value] of rows)
      bytes +=
        Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value));
    if (bytes > maxBytes)
      throw Error("Source projection exceeds configured memory budget");
    return {
      state: inflate(rows, true),
      rows,
      checkpoint: {
        epoch: head.epoch,
        revision: head.revision,
        token: head.token
      },
      mode: incremental ? "incremental" : "snapshot",
      changedRows: changes.length
    };
  } finally {
    try {
      source.db.exec("ROLLBACK");
    } finally {
      source.close();
    }
  }
}
module.exports = { readState };
