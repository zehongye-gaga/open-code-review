// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const { fail } = require("./options.js");
const { resolveOptions } = require("./options.js");

const object = value => value && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const iso = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
function parseSnapshot(value, organization) {
  if (!exact(value, ["schema", "organization", "configurations"]) || value.schema !== "reviewhub-config/v1" || value.organization !== organization ||
      !Array.isArray(value.configurations) || value.configurations.length > 10000) throw Error("Invalid configuration snapshot");
  const ids = new Set(), names = new Set();
  for (const c of value.configurations) {
    if (!exact(c, ["repository", "policy", "revision"]) || !Number.isSafeInteger(c.revision) || c.revision < 1 ||
        !exact(c.repository, ["id", "name", "visibility", "defaultBranch", "observedAt"]) ||
        !/^[1-9][0-9]{0,18}$/.test(c.repository.id) || typeof c.repository.id !== "string" ||
        typeof c.repository.name !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(c.repository.name) ||
        c.repository.name.split("/")[0].toLowerCase() !== organization.toLowerCase() ||
        !["public", "private"].includes(c.repository.visibility) || typeof c.repository.defaultBranch !== "string" || !c.repository.defaultBranch || c.repository.defaultBranch.length > 240 ||
        !iso(c.repository.observedAt) || !exact(c.policy, ["enabled", "baseBranches"]) ||
        typeof c.policy.enabled !== "boolean" ||
        !Array.isArray(c.policy.baseBranches) || !c.policy.baseBranches.length || c.policy.baseBranches.length > 20 ||
        c.policy.baseBranches.some(b => typeof b !== "string" || !b || b.length > 240) || new Set(c.policy.baseBranches).size !== c.policy.baseBranches.length ||
        ids.has(c.repository.id) || names.has(c.repository.name.toLowerCase())) throw Error("Invalid repository configuration");
    ids.add(c.repository.id); names.add(c.repository.name.toLowerCase());
  }
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
class DynamicConfiguration {
  constructor(service, transport = fetch) {
    this.service = service; this.transport = transport; this.instanceId = crypto.randomUUID(); this.loaded = false;
    this.entries = new Map(); this.policies = new Map();
    const c = service.config.dynamicConfiguration;
    if (!object(c) || typeof c.organization !== "string" || !/^[A-Za-z0-9-]+$/.test(c.organization) ||
        typeof c.tokenFile !== "string" || !c.tokenFile.startsWith("/") || typeof c.snapshotUrl !== "string") throw Error("Invalid dynamicConfiguration");
    const url = new URL(c.snapshotUrl);
    if (url.username || url.password || url.hash || !["https:", "http:"].includes(url.protocol) ||
        url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw Error("Use HTTPS for configuration snapshots");
    if (service.config.gitea || !service.config.infrastructure?.enabled || !service.config.infrastructure.externalDispatch ||
        !service.config.infrastructure.orgCI?.enabled || service.config.statusContext !== "ocr-review") throw Error("Dynamic enrollment requires enabled GitHub organization CI with ocr-review status");
    if (c.clientIds !== undefined && (!Array.isArray(c.clientIds) || c.clientIds.some(id => !service.config.infrastructure.clients?.some(client => client.id === id && ["agent", "dispatcher"].includes(client.role))))) throw Error("Invalid dynamic configuration client IDs");
    this.config = { ...c, organization: c.organization.toLowerCase() };
  }
  token() {
    const value = fs.readFileSync(this.config.tokenFile, "utf8").trim();
    if (value.length < 32) throw Error("Configuration token must have at least 32 characters");
    return value;
  }
  covers(name) { return typeof name === "string" && name.split("/")[0].toLowerCase() === this.config.organization.toLowerCase(); }
  authorizes(clientId, name) { return this.config.clientIds?.includes(clientId) && !!this.resolve(name); }
  authorizesJob(clientId, job) {
    const policy = job.settings?.enrollmentPolicy;
    const current = policy && this.entries.get(policy.repositoryId);
    return this.loaded && this.config.clientIds?.includes(clientId) && current &&
      current.repository.name.toLowerCase() === job.repository.toLowerCase() && current.revision >= policy.configurationRevision;
  }
  resolve(name) {
    if (!this.covers(name)) return undefined;
    if (!this.loaded) return null;
    const policy = this.policies.get(name.toLowerCase());
    return policy === undefined ? undefined : policy.enabled ? policy.repository : null;
  }
  apply(input) {
    const snapshot = parseSnapshot(input, this.config.organization), entries = new Map(), policies = new Map();
    for (const c of snapshot.configurations) {
      const previous = this.entries.get(c.repository.id);
      if (previous && (c.revision < previous.revision || c.revision === previous.revision && JSON.stringify(canonical(c)) !== JSON.stringify(canonical(previous)))) throw Error("Configuration revision conflict");
      if (previous && previous.repository.name.toLowerCase() !== c.repository.name.toLowerCase()) throw Error("Repository rename requires explicit migration");
      const source = this.service.staticRepo(c.repository.name);
      const repository = { ...source, name: source?.name || c.repository.name.toLowerCase(),
        githubName: c.repository.name.toLowerCase(), baseBranches: c.policy.baseBranches, repositoryId: c.repository.id,
        configurationRevision: c.revision };
      resolveOptions(this.service.config, repository, repository.defaultProfile || "standard");
      if (c.policy.enabled && this.service.config.infrastructure.orgCI?.agentReady) {
        const infra = this.service.config.infrastructure;
        // Direct CI dispatch uses an internal actor authenticated by the CI gateway.
        const clientId = infra.agentDispatch?.clientId;
        const client = infra.clients?.find(item => item.id === clientId);
        if (!client || client.role !== "admin" && !this.config.clientIds?.includes(clientId) && !client.repositories?.some(p => [c.repository.name.toLowerCase(), `${this.config.organization.toLowerCase()}/*`].includes(p.toLowerCase()))) throw Error("Configuration client scope does not include repository");
      }
      entries.set(c.repository.id, structuredClone(c));
      const value = { enabled: c.policy.enabled, repository };
      policies.set(c.repository.name.toLowerCase(), value); policies.set(repository.name, value);
    }
    for (const id of this.entries.keys()) if (!entries.has(id)) throw Error("Published configurations cannot be removed; disable explicitly");
    this.entries = entries; this.policies = policies; this.loaded = true; this.observedAt = new Date().toISOString();
  }
  refresh() {
    if (!this.pending) this.pending = (async () => {
      const response = await this.transport(this.config.snapshotUrl, { headers: { Authorization: `Bearer ${this.token()}` }, redirect: "error", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw Error("Configuration source unavailable");
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length; if (bytes > 4 * 1024 * 1024) throw Error("Configuration snapshot too large"); chunks.push(chunk);
      }
      const snapshot = parseSnapshot(JSON.parse(Buffer.concat(chunks).toString("utf8")), this.config.organization);
      for (const c of snapshot.configurations) {
        if (!c.policy.enabled || this.entries.get(c.repository.id)?.revision === c.revision) continue;
        const [owner, repo] = c.repository.name.split("/");
        const { data } = await this.service.github.rest.repos.get({ owner, repo });
        if (String(data.id) !== c.repository.id || data.full_name?.toLowerCase() !== c.repository.name.toLowerCase() ||
            data.visibility !== c.repository.visibility || data.default_branch !== c.repository.defaultBranch || data.archived || data.disabled) throw Error("Backend repository access or identity changed");
      }
      this.apply(snapshot);
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
  observation(id) {
    if (!this.loaded) fail("Configuration has not loaded", 503);
    return { instanceId: this.instanceId, observedAt: this.observedAt, configuration: this.entries.get(id) || null };
  }
  async handle(req, res) {
    if (!req.url.startsWith("/configuration/")) return false;
    const send = (status, value) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
    try {
      const actual = Buffer.from(req.headers.authorization || ""), expected = Buffer.from(`Bearer ${this.token()}`);
      if (req.headers.origin || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) { send(401, { error: "Unauthorized" }); return true; }
      if (req.url === "/configuration/refresh" && req.method === "POST") { await this.refresh(); send(200, { ok: true, instanceId: this.instanceId }); }
      else if (/^\/configuration\/repositories\/[1-9][0-9]{0,18}$/.test(req.url) && req.method === "GET") send(200, this.observation(req.url.split("/").at(-1)));
      else send(404, { error: "Not found" });
    } catch { send(503, { error: "Configuration synchronization failed" }); }
    return true;
  }
}
module.exports = { DynamicConfiguration, parseSnapshot };
