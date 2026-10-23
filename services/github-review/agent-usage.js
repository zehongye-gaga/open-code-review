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
      const rows = {}, visited = new Set();
      const headers = { authorization: `Bearer ${fs.readFileSync(this.config.tokenFile, "utf8").trim()}` };
      const deadline = AbortSignal.timeout(90000);
      const get = async (pathname, params) => {
        const url = new URL(pathname, this.config.url);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        const response = await this.request(url, { headers, redirect: "error", signal: deadline });
        if (!response.ok) throw new Error("Agent usage unavailable");
        return response.json();
      };
      const readTree = async (key, depth, components, ancestors) => {
        if (ancestors.has(key)) throw new Error("Cyclic session ancestry");
        if (components.has(key)) return;
        if (visited.has(key)) throw new Error("Session belongs to multiple PR bindings");
        if (components.size >= 1000 || depth > 32) throw new Error("Session traversal limit");
        const body = await get("/v1/sessions", { key, limit: "100", offset: "0" });
        const session = body.sessions?.find((s) => s.key === key);
        if (!session || ![session.inputTokens, session.outputTokens].every((n) => Number.isSafeInteger(n) && n >= 0)) {
          throw new Error("Session usage missing");
        }
        components.set(key, { id: require("node:crypto").createHash("sha256").update(key).digest("hex"),
          depth, inputTokens: session.inputTokens, outputTokens: session.outputTokens });
        const chain = new Set([...ancestors, key]), cursors = new Set();
        let cursor = "";
        do {
          if (cursors.has(cursor) || cursors.size >= 100) throw new Error("Invalid child pagination");
          cursors.add(cursor);
          const children = await get("/v1/agent-chat/session-children", { session_key: key, cursor });
          if (!Array.isArray(children.items)) throw new Error("Invalid child sessions");
          for (const child of children.items) {
            if (!child.session_key) throw new Error("Missing child session identity");
            await readTree(child.session_key, depth + 1, components, chain);
          }
          cursor = children.next_cursor || "";
        } while (cursor);
      };
      for (const [key, binding] of wanted) {
        const components = new Map();
        await readTree(key, 0, components, new Set());
        for (const sessionKey of components.keys()) visited.add(sessionKey);
        const parts = [...components.values()];
        const sum = (field, childOnly = false) => parts.reduce((n, p) => n + (childOnly && p.depth === 0 ? 0 : p[field]), 0);
        const inputTokens = sum("inputTokens"), outputTokens = sum("outputTokens");
        if (!Number.isSafeInteger(inputTokens + outputTokens)) throw new Error("Usage overflow");
        rows[binding.id] = { id: binding.id, repository: binding.repository.toLowerCase(), number: binding.number,
          inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
          childInputTokens: sum("inputTokens", true), childOutputTokens: sum("outputTokens", true),
          childSessions: parts.length - 1, components: parts, coverage: "reachable_session_tree",
          observedAt: new Date(now).toISOString(), source: "goclaw_session_tree_counters" };
      }
      this.value = { sessions: rows, collectedAt: new Date(now).toISOString(), error: false,
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
