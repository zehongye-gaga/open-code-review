// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const Ajv = require("ajv"), addFormats = require("ajv-formats");
const ajv = new Ajv({ allErrors: false, strict: false });
addFormats(ajv);
const validate = ajv.compile(require("./audit-repository-scope-v1.schema.json"));
function source(value) {
  if (value === undefined) return "configuration";
  if (!["configuration", "reviewhub"].includes(value)) throw Error("Invalid repositorySource");
  return value;
}
async function repositoryScope(config, options, store, records) {
  if (source(options.repositorySource) === "configuration") return { config, snapshot: null };
  const snapshot = await store.repositoryScope(config.organizations);
  if (!Array.isArray(snapshot) || snapshot.length > 10000 ||
      Buffer.byteLength(JSON.stringify(snapshot)) > 4 * 1024 * 1024) throw Error("Invalid audit repository scope");
  const saved = records.get("scope:snapshot") || [];
  if (!Array.isArray(saved) || saved.some(row => !validate(row))) throw Error("Invalid saved audit repository scope");
  const previous = new Map(saved.map(row => [row.configuration.repository.id, row]));
  const ids = new Set(), names = new Set();
  const repositories = snapshot.map(row => {
    if (!validate(row)) throw Error("Invalid audit repository scope contract");
    const c = row.configuration, r = c.repository, name = r.name.toLowerCase();
    if (!config.organizations.includes(name.split("/")[0]) || ids.has(r.id) || names.has(name))
      throw Error("Audit repository scope identity conflict");
    ids.add(r.id); names.add(name);
    const old = previous.get(r.id)?.configuration;
    if (old && (old.revision > c.revision || old.revision === c.revision &&
        JSON.stringify(canonical(old)) !== JSON.stringify(canonical(c)))) throw Error("Audit repository revision conflict");
    const legacy = config.repositories.find(item => (item.githubName || item.name)?.toLowerCase() === name);
    return { ...legacy, name: legacy?.name || name, githubName: name, repositoryId: r.id,
      defaultBranch: r.defaultBranch, baseBranches: c.policy.baseBranches,
      configurationRevision: c.revision, enabled: row.enabled };
  });
  return { config: { ...config, repositories }, snapshot };
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
module.exports = { repositoryScope, source };
