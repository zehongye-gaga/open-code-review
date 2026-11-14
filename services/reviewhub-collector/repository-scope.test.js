// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { repositoryScope, source } = require("./repository-scope.js");
const { fixture } = require("./test-support.js"), { collect } = require("./collector.js");
function row(name = "company/repo", id = "42", revision = 1, enabled = null) {
  return { schema: "reviewhub-audit-repository/v1", enabled, configuration: { revision,
    repository: { id, name, visibility: "private", defaultBranch: "master", observedAt: "2026-11-14T00:00:00Z" },
    policy: { enabled: true, baseBranches: ["master"] } } };
}
const config = { organizations: ["company"], repositories: [{ name: "company/legacy", githubName: "company/repo", budget: 123 }, { name: "company/removed" }] };
const load = (rows, records = new Map()) => repositoryScope(config, { repositorySource: "reviewhub" }, { repositoryScope: async () => rows }, records);
test("configuration mode is explicit compatibility; PG membership replaces static names but retains matching aliases", async () => {
  assert.equal(source(), "configuration"); assert.throws(() => source("typo"));
  assert.equal((await repositoryScope(config, {}, {}, new Map())).config, config);
  const result = await load([row(), row("company/new", "43")]);
  assert.deepEqual(result.config.repositories.map(r => r.name), ["company/legacy", "company/new"]);
  assert.equal(result.config.repositories[0].githubName, "company/repo");
  assert.equal(result.config.repositories[0].budget, 123);
  assert.equal(result.config.repositories[1].repositoryId, "43");
  assert.equal(result.config.repositories[1].defaultBranch, "master");
  assert.equal(result.config.repositories[1].enabled, null);
  assert.deepEqual((await load([])).config.repositories, []);
});
test("invalid or cross-organization snapshots reject as a whole without a static fallback", async () => {
  const bad = [null, {}, [row(), row()], [row(), row("company/repo", "43")], [row("outside/repo")],
    [{ ...row(), enabled: "true" }], [{ ...row(), extra: true }],
    [{ ...row(), configuration: { ...row().configuration, revision: 0 } }]];
  for (const rows of bad) await assert.rejects(load(rows));
  await assert.rejects(repositoryScope(config, { repositorySource: "reviewhub" }, {
    repositoryScope: async () => { throw Error("permission denied"); },
  }, new Map()), /permission denied/);
});
test("scope revisions cannot regress or change content in place; application confirmation can update enabled", async () => {
  const records = new Map([["scope:snapshot", [row("company/repo", "42", 2)]]]);
  await assert.rejects(load([row()], records), /revision conflict/);
  await assert.rejects(load([row("company/renamed", "42", 2)], records), /revision conflict/);
  assert.equal((await load([row("company/repo", "42", 2, true)], records)).config.repositories[0].enabled, true);
  assert.equal((await load([row("company/renamed", "42", 3, false)], records)).config.repositories[0].repositoryId, "42");
  await assert.rejects(load([row()], new Map([["scope:snapshot", [{}]]])), /saved/);
});
test("one PG snapshot feeds metadata, task normalization and Actions, without static repository membership", async t => {
  const f = fixture(t), calls = [];
  f.config.repositories = [];
  const saved = { checkpoint: {}, records: new Map() };
  const result = await collect({ ...f, options: { ...f.options, githubMetadata: true, repositorySource: "reviewhub" }, saved,
    store: { sourceId: "test", repositoryScope: async orgs => { assert.deepEqual(orgs, ["company"]); return [row()]; },
      publish: async (batch, checkpoint, records) => { calls.push("publish"); assert.ok(records.has("scope:snapshot")); } },
    metadataReader: async config => { calls.push("metadata"); assert.equal(config.repositories[0].repositoryId, "42"); return { metadata: {}, warnings: [] }; },
    resourcesReader: () => null,
    actionsReader: async input => { calls.push("actions"); assert.equal(input.repositories[0].id, "github:42");
      return { attempts: [], records: new Map(), coverage: [], warnings: [], stats: {} }; },
  });
  assert.deepEqual(calls, ["metadata", "actions", "publish"]);
  assert.equal(result.batch.runs.length, 1); assert.equal(result.batch.runs[0].repositoryId, "github:42");
  assert.equal(result.batch.repositories[0].defaultBranch, "master");
});
test("scope failure preserves the committed checkpoint and never publishes a partial or empty batch", async t => {
  const f = fixture(t), saved = { checkpoint: { sentinel: "unchanged" }, records: new Map() };
  let published = false;
  await assert.rejects(collect({ ...f, options: { ...f.options, repositorySource: "reviewhub" }, saved,
    store: { repositoryScope: async () => [row(), {}], publish: async () => { published = true; } },
  }));
  assert.equal(published, false); assert.deepEqual(saved.checkpoint, { sentinel: "unchanged" });
});
