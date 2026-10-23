// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const fs = require("node:fs");
const path = require("node:path");
class AgentUsage {
  constructor(config, directory, request = fetch) {
    this.config = config; this.request = request; this.file = path.join(directory, "agent-usage.json");
    try { this.value = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { this.value = { sessions: {}, collectedAt: null }; }
    this.busy = false; this.nextAt = 0;
  }
  async collect(bindings, now = Date.now()) {
    if (this.busy || now < this.nextAt || !this.config?.url) return;
    this.busy = true; this.nextAt = now + 60000;
    try {
      const wanted = new Map(Object.values(bindings || {}).filter((b) => b.sessionKey && b.url === this.config.url && b.model === this.config.model).map((b) => [b.sessionKey, b]));
      const pending = new Set(wanted.keys()), rows = {};
      const headers = { authorization: `Bearer ${fs.readFileSync(this.config.tokenFile, "utf8").trim()}` };
      const deadline = AbortSignal.timeout(90000);
      for (let offset = 0; pending.size && offset < 10000; offset += 100) {
        const url = new URL("/v1/sessions", this.config.url); url.searchParams.set("limit", "100"); url.searchParams.set("offset", String(offset));
        const response = await this.request(url, { headers, redirect: "error", signal: deadline });
        if (!response.ok) throw new Error("Agent usage unavailable");
        const body = await response.json(); if (!Array.isArray(body.sessions)) throw new Error("Invalid session list");
        for (const session of body.sessions) {
          const binding = wanted.get(session.key); if (!binding) continue;
          pending.delete(session.key);
          const input = session.inputTokens, output = session.outputTokens;
          if (![input, output].every((n) => Number.isSafeInteger(n) && n >= 0)) continue;
          rows[binding.id] = { id: binding.id, repository: binding.repository.toLowerCase(), number: binding.number,
            inputTokens: input, outputTokens: output, totalTokens: input + output,
            observedAt: new Date(now).toISOString(), source: "goclaw_session_counters" };
        }
        if (!body.sessions.length || offset + body.sessions.length >= body.total) break;
      }
      this.value = { sessions: { ...this.value.sessions, ...rows }, collectedAt: new Date(now).toISOString(), error: false,
        boundSessions: wanted.size, matchedSessions: Object.keys(rows).length, missingSessions: wanted.size - Object.keys(rows).length };
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.value), { mode: 0o600 }); fs.renameSync(this.file + ".tmp", this.file);
    } catch { this.value = { ...this.value, error: true }; }
    finally { this.busy = false; }
  }
  snapshot(repository = "") {
    const sessions = Object.values(this.value.sessions).filter((r) => !repository || r.repository === repository);
    return { ...this.value, sessions, stale: !this.value.collectedAt || Date.now() - Date.parse(this.value.collectedAt) > 180000 };
  }
}
module.exports = { AgentUsage };
