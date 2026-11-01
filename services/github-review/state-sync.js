// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const { SQLiteState, inflate } = require("./state-sqlite.js");
class StateSync {
  constructor(sourceFile, store, maxBytes = 64 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) throw Error("Invalid state sync size budget");
    this.maxBytes = maxBytes;
    this.sourceFile = sourceFile; this.store = store; this.rows = null;
    store.db.exec("CREATE TABLE IF NOT EXISTS review_source_rows(key TEXT PRIMARY KEY,payload TEXT NOT NULL)");
  }
  bounded(bytes) {
    if (bytes > this.maxBytes) throw Object.assign(Error("Review projection exceeds configured limit"), { code: "STATE_TOO_LARGE" });
    return bytes;
  }
  read() {
    const source = new SQLiteState(this.sourceFile, { readOnly: true });
    let changes, head, mode, saved, latest;
    try {
      source.db.exec("BEGIN");
      head = source.db.prepare("SELECT * FROM state_head WHERE id=1").get();
      if (!head) throw Error("Source state not initialized");
      saved = this.store.meta("reviewSourceCheckpoint");
      latest = head.revision;
      const oldest = source.db.prepare("SELECT min(revision) AS n FROM state_changes").get().n;
      mode = !saved ? "bootstrap" : saved.epoch !== head.epoch || saved.revision > head.revision ||
        source.db.prepare("SELECT token FROM state_commits WHERE revision=?").get(saved.revision)?.token !== saved.token ||
        saved.revision < head.revision && (oldest === null || saved.revision < oldest - 1) ? "resnapshot" : "incremental";
      if (mode !== "incremental") {
        this.bounded(source.db.prepare("SELECT coalesce(sum(length(cast(key AS BLOB))+length(cast(payload AS BLOB))),0) AS n FROM state_rows").get().n);
        changes = [...source.readRows()].map(([key, payload]) => ({ key, payload }));
      }
      else {
        const revisions = source.db.prepare("SELECT DISTINCT revision FROM state_changes WHERE revision>? ORDER BY revision LIMIT 20").all(saved.revision);
        head = { ...head, revision: revisions.at(-1)?.revision || saved.revision };
        head.token = source.db.prepare("SELECT token FROM state_commits WHERE revision=?").get(head.revision).token;
        const batch = "(SELECT key,payload,row_number() OVER(PARTITION BY key ORDER BY revision DESC) AS n FROM state_changes WHERE revision>? AND revision<=?) WHERE n=1";
        this.bounded(source.db.prepare("SELECT coalesce(sum(length(cast(key AS BLOB))+coalesce(length(cast(payload AS BLOB)),0)),0) AS bytes FROM " + batch).get(saved.revision, head.revision).bytes);
        changes = source.db.prepare("SELECT key,payload FROM " + batch).all(saved.revision, head.revision);
      }
      source.db.exec("ROLLBACK");
    } finally { source.close(); }
    const checkpoint = { epoch: head.epoch, revision: head.revision, token: head.token, mode, collectedAt: new Date().toISOString() };
    const reload = !this.rows || mode !== "incremental" || this.cacheToken !== saved?.token;
    let reloaded;
    this.store.transaction(() => {
      if (JSON.stringify(this.store.meta("reviewSourceCheckpoint")) !== JSON.stringify(saved)) throw Error("Concurrent state consumer detected");
      if (mode !== "incremental") this.store.db.exec("DELETE FROM review_source_rows");
      const put = this.store.statement("INSERT INTO review_source_rows VALUES (?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload");
      for (const row of changes) {
        if (row.payload === null) this.store.statement("DELETE FROM review_source_rows WHERE key=?").run(row.key);
        else put.run(row.key, row.payload);
      }
      checkpoint.sizeBytes = this.bounded(this.store.statement("SELECT coalesce(sum(length(cast(key AS BLOB))+length(cast(payload AS BLOB))),0) AS n FROM review_source_rows").get().n);
      if (reload) reloaded = new Map(this.store.statement("SELECT key,payload FROM review_source_rows").all().map((r) => [r.key, JSON.parse(r.payload)]));
      this.store.meta("reviewSourceCheckpoint", checkpoint);
    });
    if (reload) this.rows = reloaded;
    else for (const row of changes) { if (row.payload === null) this.rows.delete(row.key); else this.rows.set(row.key, JSON.parse(row.payload)); }
    if (changes.length || !this.value || reload) this.value = inflate(this.rows, true);
    this.cacheToken = checkpoint.token;
    this.status = { ...checkpoint, changedRows: changes.length, pendingRevisions: latest - head.revision, source: "sqlite", limitBytes: this.maxBytes, error: false, code: null };
    return this.value;
  }
}
module.exports = { StateSync };
