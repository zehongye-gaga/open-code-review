// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { DynamicConfiguration } = require("./dynamic-configuration.js");
const { ReviewService } = require("./service.js");
const { Infrastructure } = require("./infrastructure.js");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
function snapshot(enabled = true, revision = 1) {
  return { schema: "reviewhub-config/v1", organization: "lexmount", configurations: [{
    repository: { id: "42", name: "lexmount/new-repo", visibility: "private", defaultBranch: "main", observedAt: "2026-11-13T00:00:00.000Z" },
    policy: { enabled, baseBranches: ["main"] }, revision,
  }] };
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = { binary: "/bin/echo", stateDirectory: directory, repositories: [{ name: "lexmount/old", baseBranches: ["main"] }],
    provider: "test", model: "model", blockSeverity: "medium", infrastructure: { enabled: true, externalDispatch: true, orgCI: { enabled: true },
      organizations: [{ name: "lexmount", baseBranches: ["main"] }],
      clients: [{ id: "org-ci-dispatcher", role: "dispatcher", repositories: [], tokenFile: "/tmp/unused" }] },
    dynamicConfiguration: { organization: "lexmount", snapshotUrl: "https://reviewhub.example/internal/v1/repository-configurations", tokenFile: path.join(directory, "token"), clientIds: ["org-ci-dispatcher"] } };
  fs.writeFileSync(config.dynamicConfiguration.tokenFile, "x".repeat(40));
  const state = { data: { jobs: [], sequence: 0 }, save() {} };
  const service = new ReviewService({ config, github: { rest: { repos: { get: async () => ({ data: { id: 42, full_name: "lexmount/new-repo", visibility: "private", default_branch: "main" } }) } } }, state, log() {} });
  return { service, dynamic: service.dynamicConfiguration };
}
test("hot enrollment and explicit pause override organization fallback without restarting", t => {
  const { service, dynamic } = fixture(t);
  assert.equal(service.repo("lexmount/old"), null);
  dynamic.apply(snapshot());
  assert.equal(service.repo("lexmount/old").name, "lexmount/old");
  assert.equal(service.repo("lexmount/new-repo").repositoryId, "42");
  new Infrastructure(service).authorizeScope("lexmount/new-repo", { id: "org-ci-dispatcher", role: "dispatcher" });
  assert.throws(() => new Infrastructure(service).authorizeScope("lexmount/other", { id: "org-ci-dispatcher", role: "dispatcher" }));
  dynamic.apply(snapshot(false, 2));
  assert.equal(service.repo("lexmount/new-repo"), null);
  assert.throws(() => new Infrastructure(service).authorizeScope("lexmount/new-repo", { id: "org-ci-dispatcher", role: "dispatcher" }));
  dynamic.apply(snapshot(true, 3));
  assert.equal(service.repo("lexmount/new-repo").configurationRevision, 3);
});
test("invalid, missing, conflicting and stale versions preserve the last good snapshot", t => {
  const { service, dynamic } = fixture(t);
  dynamic.apply(snapshot(true, 2)); dynamic.apply(snapshot(true, 2));
  for (const value of [snapshot(false, 2), snapshot(true, 1), { ...snapshot(), configurations: [] }, { ...snapshot(), organization: "other" }]) assert.throws(() => dynamic.apply(value));
  const invalid = snapshot(true, 3); invalid.configurations[0].policy.enabled = "true";
  assert.throws(() => dynamic.apply(invalid));
  assert.equal(service.repo("lexmount/new-repo").configurationRevision, 2);
});
test("a paused repository cannot admit new work while an accepted snapshot stays eligible", t => {
  const { service, dynamic } = fixture(t); dynamic.apply(snapshot());
  const policy = structuredClone(service.repo("lexmount/new-repo"));
  const pr = { state: "open", draft: false, head: { sha: "a".repeat(40) }, base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "lexmount/new-repo", id: 42 } } };
  assert.equal(service.eligible(policy.name, pr), true);
  assert.equal(service.eligible(policy.name, { ...pr, base: { ...pr.base, repo: { ...pr.base.repo, id: 43 } } }), false);
  dynamic.apply(snapshot(false, 2));
  assert.ok(!service.eligible(policy.name, pr));
  assert.equal(service.eligible(policy.name, pr, { settings: { enrollmentPolicy: policy } }), true);
  assert.equal(service.eligible(policy.name, { ...pr, state: "closed" }, { settings: { enrollmentPolicy: policy } }), false);
});
test("refresh failures retain cached policies and a new instance must recover independently", async t => {
  const { service, dynamic } = fixture(t);
  dynamic.transport = async () => new Response(JSON.stringify(snapshot()));
  await dynamic.refresh(); const first = dynamic.observation("42");
  dynamic.transport = async () => new Response("unavailable", { status: 503 });
  await assert.rejects(dynamic.refresh()); assert.deepEqual(dynamic.observation("42"), first);
  const restarted = new DynamicConfiguration(service, async () => new Response(JSON.stringify(snapshot())));
  assert.notEqual(restarted.instanceId, first.instanceId); assert.equal(restarted.resolve("lexmount/new-repo"), null);
  await restarted.refresh(); assert.equal(restarted.observation("42").configuration.revision, 1);
});
test("new configuration cannot load before the backend can access the exact repository", async t => {
  const { service, dynamic } = fixture(t);
  dynamic.transport = async () => new Response(JSON.stringify(snapshot()));
  service.github.rest.repos.get = async () => ({ data: { id: 99, full_name: "lexmount/new-repo", visibility: "private", default_branch: "main" } });
  await assert.rejects(dynamic.refresh(), /identity changed/);
  assert.equal(dynamic.loaded, false);
});

test("paused dynamic jobs remain observable without authorizing new work or retries", async t => {
  const { service, dynamic } = fixture(t); dynamic.apply(snapshot());
  const policy = structuredClone(service.repo("lexmount/new-repo"));
  const job = { id: 1, repository: policy.name, state: "running", settings: { enrollmentPolicy: policy } };
  service.state.data.jobs.push(job);
  dynamic.apply(snapshot(false, 2));
  const infrastructure = new Infrastructure(service), actor = { id: "org-ci-dispatcher", role: "dispatcher" };
  assert.equal(infrastructure.find(1, actor), job);
  assert.throws(() => infrastructure.find(1, { id: "unrelated", role: "dispatcher" }));
  assert.throws(() => infrastructure.find(1, actor, true));
  assert.throws(() => infrastructure.authorize(policy.name, actor, true));
});
