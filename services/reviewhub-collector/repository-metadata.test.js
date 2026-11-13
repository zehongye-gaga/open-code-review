// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { repositoryMetadata } = require("./repository-metadata.js");
const { normalize } = require("./normalize.js");
const now = Date.parse("2026-11-13T03:00:00Z");
const config = {
  token: "test-token",
  organizations: ["company"],
  repositories: [{ name: "company/old" }, { name: "company/new" }]
};
const body = { id: 42, full_name: "company/new", default_branch: "main" };

test("resolves renamed repositories through fixed IDs and merges both configured names without losing history", async () => {
  const calls = [];
  const response = await repositoryMetadata(
    config,
    {},
    now,
    async (url, options) => {
      calls.push(url);
      assert.equal(options.redirect, "manual");
      assert.equal(options.headers.authorization, "Bearer test-token");
      return url.endsWith("/repos/company/old")
        ? new Response(null, {
            status: 301,
            headers: { location: "https://api.github.com/repositories/42" }
          })
        : Response.json(body);
    }
  );
  assert.deepEqual(calls, [
    "https://api.github.com/repos/company/old",
    "https://api.github.com/repositories/42",
    "https://api.github.com/repos/company/new"
  ]);
  assert.equal(response.metadata["company/old"].providerId, "42");
  const previous = [
    {
      id: "github:42",
      providerId: "42",
      name: "company/new",
      aliases: ["company/new"]
    },
    {
      id: "unmatched:old",
      providerId: null,
      name: "company/old",
      aliases: ["company/old"]
    }
  ];
  const batch = normalize({
    config,
    previousRepositories: previous,
    metadata: response.metadata,
    state: { jobs: [] },
    ledger: {
      jobs: {
        one: {
          id: 1,
          repository: "company/old",
          number: 1,
          head: "a".repeat(40),
          createdAt: now - 60000,
          state: "complete"
        }
      },
      sessions: {},
      artifacts: {}
    },
    sourceId: "test",
    intervalSeconds: 300,
    now
  });
  assert.equal(batch.repositories.length, 1);
  assert.equal(batch.repositories[0].id, "github:42");
  assert.ok(batch.repositories[0].aliases.includes("company/old"));
  assert.equal(batch.runs[0].repositoryId, "github:42");
});

test("metadata redirects cannot forward credentials outside the GitHub API or change a known repository ID", async () => {
  for (const location of [
    "https://attacker.example/repositories/42",
    "https://api.github.com@attacker.example/repositories/42",
    "http://api.github.com/repositories/42",
    "https://api.github.com/repos/company/new",
    "https://api.github.com/repositories/42?secret=x"
  ]) {
    let calls = 0;
    const result = await repositoryMetadata(
      { ...config, repositories: [config.repositories[0]] },
      {},
      now,
      async () => {
        calls++;
        return new Response(null, { status: 301, headers: { location } });
      }
    );
    assert.equal(calls, 1);
    assert.equal(result.metadata["company/old"].access, "unknown");
  }
  let calls = 0;
  const result = await repositoryMetadata(
    { ...config, repositories: [config.repositories[0]] },
    { "company/old": { providerId: "42" } },
    now,
    async (url) => {
      calls++;
      assert.equal(url, "https://api.github.com/repositories/42");
      return new Response(null, {
        status: 301,
        headers: { location: "https://api.github.com/repositories/43" }
      });
    }
  );
  assert.equal(calls, 1);
  assert.equal(result.metadata["company/old"].providerId, "42");
  assert.equal(result.metadata["company/old"].access, "unknown");
});

test("rejects transferred or mismatched repositories and retries unverified metadata after five minutes", async () => {
  for (const invalid of [
    { ...body, full_name: "outside/new" },
    { ...body, id: 43 }
  ]) {
    const result = await repositoryMetadata(
      { ...config, repositories: [config.repositories[0]] },
      {
        "company/old": {
          providerId: "42",
          checkedAt: new Date(now - 300001).toISOString(),
          access: "unknown"
        }
      },
      now,
      async () => Response.json(invalid)
    );
    assert.equal(result.metadata["company/old"].access, "unknown");
    assert.equal(result.metadata["company/old"].name, undefined);
  }
  let calls = 0;
  await repositoryMetadata(
    { ...config, repositories: [config.repositories[0]] },
    {
      "company/old": {
        providerId: "42",
        checkedAt: new Date(now - 300001).toISOString(),
        access: "unknown"
      }
    },
    now,
    async (url) => {
      calls++;
      assert.ok(url.endsWith("/repositories/42"));
      return Response.json(body);
    }
  );
  assert.equal(calls, 1);
});
