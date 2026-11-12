// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { collect, optionsFromFile } = require("./collector.js"),
  { normalize } = require("./normalize.js"),
  { fixture } = require("./test-support.js");

test("same-organization tasks, ledgers and previous repositories cannot expand the explicit allowlist", async (t) => {
  const f = fixture(t),
    store = { sourceId: "test", publish: async () => {} };
  const first = await collect({
    ...f,
    store,
    saved: { checkpoint: {}, records: new Map() },
    resourcesReader: () => null
  });
  for (const kind of ["runs", "events", "findings", "usage"])
    assert.ok(first.batch[kind].length > 0, kind);
  const historical = {
    ...first.batch.repositories[0],
    id: "repository:historical",
    name: "company/historical",
    aliases: ["company/historical"]
  };
  first.saved.records.set("repository:" + historical.id, historical);
  const next = await collect({
    ...f,
    config: { ...f.config, repositories: [{ name: "company/new" }] },
    store,
    saved: first.saved,
    resourcesReader: () => null
  });
  assert.deepEqual(
    next.batch.repositories.map((r) => r.name),
    ["company/new"]
  );
  for (const kind of ["runs", "events", "findings", "usage"])
    assert.deepEqual(next.batch[kind], [], kind);
  assert.ok(next.saved.records.has("repository:" + historical.id));
  assert.ok(
    next.saved.records.has("repository:" + first.batch.repositories[0].id)
  );
});

test("configured names and githubName share one retained identity across historical spellings", () => {
  const now = Date.now(),
    at = new Date(now).toISOString(),
    job = {
      id: "1",
      repository: "company/old",
      number: 1,
      createdAt: at,
      updatedAt: at,
      state: "running"
    },
    base = {
      config: {
        stateDirectory: "/nonexistent",
        organizations: ["company"],
        repositories: [{ name: "company/old" }]
      },
      state: { jobs: [job] },
      ledger: { jobs: { 1: job }, sessions: {}, artifacts: {} },
      sourceId: "test",
      intervalSeconds: 300,
      now
    };
  const initial = normalize(base);
  const current = { ...job, id: "2", repository: "COMPANY/NEW" },
    unrelated = { ...job, id: "3", repository: "company/unlisted" };
  const updated = normalize({
    ...base,
    config: {
      ...base.config,
      repositories: [
        {
          name: "COMPANY/OLD",
          githubName: "COMPANY/NEW",
          baseBranches: ["main"]
        }
      ]
    },
    previousRepositories: initial.repositories,
    metadata: { "company/old": { providerId: "42", name: "company/new" } },
    state: { jobs: [job, current, unrelated] },
    ledger: {
      jobs: { 1: job, 2: current, 3: unrelated },
      sessions: {},
      artifacts: {}
    }
  });
  assert.equal(updated.repositories.length, 1);
  assert.equal(updated.repositories[0].id, initial.repositories[0].id);
  assert.equal(updated.repositories[0].name, "company/new");
  assert.equal(updated.repositories[0].providerId, "42");
  assert.deepEqual(updated.repositories[0].targetBranches, ["main"]);
  assert.deepEqual(updated.repositories[0].aliases, [
    "company/old",
    "company/new"
  ]);
  assert.equal(updated.runs.length, 2);
  assert.ok(
    updated.runs.every((r) => r.repositoryId === initial.repositories[0].id)
  );

  const currentConfig = {
    ...base.config,
    repositories: [{ name: "company/new" }]
  };
  const verified = normalize({
    ...base,
    config: currentConfig,
    previousRepositories: updated.repositories,
    metadata: { "company/new": { providerId: "42", name: "company/new" } }
  });
  assert.equal(verified.repositories[0].id, initial.repositories[0].id);
  assert.equal(verified.runs.length, 1);

  const replaced = normalize({
    ...base,
    config: currentConfig,
    previousRepositories: updated.repositories,
    metadata: { "company/new": { providerId: "43", name: "company/new" } }
  });
  assert.equal(replaced.repositories[0].id, "github:43");
  assert.deepEqual(replaced.repositories[0].aliases, ["company/new"]);
  assert.deepEqual(replaced.runs, []);
});

test("configured aliases remain subject to the collector organization boundary", () => {
  const batch = normalize({
    config: {
      stateDirectory: "/nonexistent",
      organizations: ["company"],
      repositories: [{ name: "company/repo", githubName: "other/repo" }]
    },
    state: { jobs: [] },
    ledger: { jobs: {}, sessions: {}, artifacts: {} },
    sourceId: "test",
    intervalSeconds: 300
  });
  assert.deepEqual(batch.repositories, []);
});

test("invalid configured aliases fail before publication and organization filtering stays case insensitive", (t) => {
  const f = fixture(t),
    backend = path.join(f.root, "config.json"),
    options = path.join(f.root, "collector.json");
  fs.writeFileSync(
    options,
    JSON.stringify({
      ...f.options,
      ocrConfig: backend,
      organizations: ["COMPANY"]
    })
  );
  for (const githubName of [
    null,
    "not-a-repository",
    {},
    "company/a/b",
    "other/repo"
  ]) {
    fs.writeFileSync(
      backend,
      JSON.stringify({
        ...f.config,
        repositories: [{ name: "company/repo", githubName }]
      })
    );
    assert.throws(
      () => optionsFromFile(options),
      /Invalid backend configuration/
    );
  }
  fs.writeFileSync(
    backend,
    JSON.stringify({
      ...f.config,
      repositories: [
        { name: "COMPANY/REPO", githubName: "COMPANY/NEW" },
        { name: "other/repo" }
      ]
    })
  );
  const loaded = optionsFromFile(options);
  assert.deepEqual(loaded.config.organizations, ["company"]);
  assert.equal(loaded.config.repositories.length, 1);
  fs.writeFileSync(
    backend,
    JSON.stringify({
      ...f.config,
      repositories: [
        { name: "company/old", githubName: "company/new" },
        { name: "COMPANY/NEW" }
      ]
    })
  );
  assert.throws(
    () => optionsFromFile(options),
    /Duplicate configured repository alias/
  );
});
