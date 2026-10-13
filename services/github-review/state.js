// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const fs = require("node:fs");
const path = require("node:path");

class State {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, "state.json");
    this.data = { version: 1, sequence: Date.now(), initialized: {}, pulls: {}, jobs: [] };
    if (fs.existsSync(this.file)) {
      this.data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (this.data.version !== 1 || !Array.isArray(this.data.jobs)) throw new Error("Unsupported or corrupt service state");
    }
    for (const job of this.data.jobs) {
      if (job.state === "running") { job.state = "queued"; job.nextAt = 0; }
    }
  }

  save() {
    try { this.write(); }
    catch (error) { error.persistence = true; throw error; }
  }

  write() {
    const temporary = this.file + ".tmp";
    const fd = fs.openSync(temporary, "w", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.data, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.file);
    const directory = fs.openSync(path.dirname(this.file), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }

  enqueue(repository, pr, { force = false, baseline = false } = {}) {
    const key = `${repository}#${pr.number}`;
    const signature = `${pr.head.sha}:${pr.base.ref}`;
    if (!force && this.data.pulls[key] === signature) return null;
    this.data.pulls[key] = signature;
    for (const job of this.data.jobs) {
      if (job.key === key && ["queued", "running"].includes(job.state)) job.state = "superseded";
    }
    if (baseline) { this.save(); return null; }
    const job = { id: ++this.data.sequence, key, repository, number: pr.number,
      head: pr.head.sha, base: pr.base.sha, baseRef: pr.base.ref, state: "queued", attempt: 0,
      nextAt: 0, createdAt: new Date().toISOString() };
    this.data.jobs.push(job);
    this.save();
    return job;
  }

  cancel(repository, number) {
    const key = `${repository}#${number}`;
    delete this.data.pulls[key];
    for (const job of this.data.jobs) {
      if (job.key === key && ["queued", "running"].includes(job.state)) job.state = "superseded";
    }
    this.save();
  }

  next(now = Date.now()) {
    return this.data.jobs.find((job) => job.state === "queued" && job.nextAt <= now);
  }
}

module.exports = { State };
