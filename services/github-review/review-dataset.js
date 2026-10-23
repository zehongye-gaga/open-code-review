// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const hash = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
class ReviewDataset {
  constructor(directory) {
    this.directory = path.join(directory, "dataset"); this.indexFile = path.join(this.directory, "index.json");
    try { this.index = JSON.parse(fs.readFileSync(this.indexFile, "utf8")); } catch { this.index = {}; }
  }
  append(kind, records) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const observedAt = new Date().toISOString(), lines = [], next = { ...this.index };
    for (const record of records) {
      const id = hash([kind, record]), key = `${kind}:${record.id}`;
      if (this.index[key] === id) continue;
      lines.push(JSON.stringify({ schema: "ocr-dataset/v1", eventId: id, kind, observedAt, labelStatus: "unvalidated", data: record }));
      next[key] = id;
    }
    if (!lines.length) return;
    fs.appendFileSync(path.join(this.directory, observedAt.slice(0, 10) + ".jsonl"), lines.join("\n") + "\n", { mode: 0o600 });
    this.index = next;
    fs.writeFileSync(this.indexFile + ".tmp", JSON.stringify(this.index), { mode: 0o600 }); fs.renameSync(this.indexFile + ".tmp", this.indexFile);
  }
}
module.exports = { ReviewDataset };

function resultRecords(jobs, stateDirectory) {
  const root = fs.realpathSync(path.join(stateDirectory, "runs")) + path.sep, result = [];
  const clean = (value) => typeof value === "string" ? value.slice(0, 12000).replace(/(?:github_pat_|ghp_|goclaw_)[A-Za-z0-9_]+/g, "[REDACTED]").replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]") : null;
  for (const job of jobs) {
    if (!job.directory || !["complete", "checkpointed", "failed"].includes(job.state)) continue;
    try {
      const file = fs.realpathSync(path.join(job.directory, "result.json")); if (!file.startsWith(root) || fs.statSync(file).size > 8 * 1024 * 1024) continue;
      const report = JSON.parse(fs.readFileSync(file, "utf8"));
      result.push({ id: String(job.id), repository: job.repository, number: job.number, head: job.head, base: job.base,
        attempt: job.attempt, model: job.settings?.options?.model || null, profile: job.settings?.profile || null,
        findings: (report.comments || []).map((c) => ({ path: clean(c.path || c.file), line: c.line ?? c.start_line ?? null,
          severity: clean(c.severity), content: clean(c.content || c.message), category: clean(c.category) })),
        summary: { totalTokens: report.summary?.total_tokens ?? null }, humanOutcome: null });
    } catch { /* Retained reports can disappear during normal run cleanup. */ }
  }
  return result;
}
module.exports.resultRecords = resultRecords;
