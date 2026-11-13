// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { operationalSignals, hostMetrics } = require("./observability.js");
const { ProbeState, databaseProbe, notify } = require("./health-probe.js");
const { validate } = require("./database/postgres.js");
const { fixture } = require("./test-support.js");
const { collect } = require("./collector.js");
test("collector publishes stage evidence without duplicating linked failures or leaking raw errors", () => {
  const job = {
    id: "1",
    repository: "company/old",
    number: 12,
    head: "a",
    base: "b",
    state: "failed",
    failurePhase: "publication",
    error: "Bearer secret-token",
    createdAt: "2026-11-13T01:00:00Z",
    updatedAt: "2026-11-13T02:00:00Z",
  };
  const batch = {
    repositories: [
      { id: "github:42", name: "company/new", aliases: ["company/old"] },
    ],
    runs: [{ sourceJobId: "1", id: "run:1" }],
  };
  const state = {
    jobs: [job],
    ciReceipts: { x: { ...job, jobId: "1", request_id: "x" } },
  };
  const rows = operationalSignals(state, batch);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stage, "publication");
  assert.equal(rows[0].reason, "unclassified_failure");
  assert.equal(rows[0].previousNotificationId, "job:1:failed");
  assert.equal(rows[0].repositoryId, "github:42");
  job.state = "complete";
  job.progress = { complete: true };
  job.result = { blocking: 1 };
  assert.equal(operationalSignals(state, batch)[0].state, "succeeded");
  job.state = "cancelled";
  assert.equal(operationalSignals(state, batch)[0].state, "cancelled");
  job.state = "queued";
  job.attempt = 2;
  assert.equal(operationalSignals(state, batch)[0].state, "queued");
});
test("admission generations keep distinct identities and neutral reasons", () => {
  const batch = {
    repositories: [{ id: "r", name: "o/r", aliases: [] }],
    runs: [],
  };
  const r = {
    id: "a",
    repository: "o/r",
    number: 1,
    request_id: "req",
    state: "failed",
    createdAt: 1000,
    lastAdmission: {
      generation: 1,
      state: "failed",
      reason: "admission_deadline_exceeded",
      finishedAt: 2000,
    },
  };
  const state = { jobs: [], ciReceipts: { a: r } };
  const first = operationalSignals(state, batch)[0];
  r.lastAdmission.generation = 2;
  r.lastAdmission.state = "complete";
  const next = operationalSignals(state, batch)[0];
  assert.notEqual(first.id, next.id);
  assert.equal(first.state, "failed");
  assert.equal(next.state, "succeeded");
});
test("missing host samples are unknown and auxiliary writes cannot invalidate an audit commit", async (t) => {
  assert.equal(
    hostMetrics("s", { cpu: null, volumes: [] }, Date.now())[0].values
      .memory_percent,
    null,
  );
  const f = fixture(t);
  let committed = false;
  const result = await collect({
    options: f.options,
    config: f.config,
    saved: { records: new Map(), checkpoint: {} },
    now: f.now,
    metadataReader: async () => ({ metadata: {}, warnings: [] }),
    resourcesReader: () => null,
    store: {
      sourceId: "test",
      publish: async (batch) => {
        assert.equal(validate(batch), true, JSON.stringify(validate.errors));
        committed = true;
        return { ms: 5, rows: 2, bytes: 20 };
      },
      saveMetric: async () => {
        throw Error("offline");
      },
    },
  });
  assert.ok(committed);
  assert.ok(result.batch.signals.length > 0);
});
test("emergency probe debounces, retries recovery and closes failed connections", async () => {
  const s = new ProbeState(),
    now = Date.now();
  assert.equal(s.observe("pg", true, now).due, false);
  const down = s.observe("pg", true, now + 60000);
  assert.ok(down.due);
  s.notified(down, now + 60000);
  assert.equal(s.observe("pg", false, now + 120000).due, false);
  assert.equal(s.observe("pg", false, now + 180000).recovery, true);
  const retry = s.observe("pg", false, now + 240000);
  assert.ok(retry.recovery);
  s.notified(retry, now + 240000);
  assert.equal(s.observe("pg", false, now + 300000).due, false);
  let closed = 0;
  class Failed {
    on() {}
    async connect() {
      throw Error("refused");
    }
    async end() {
      closed++;
    }
  }
  await assert.rejects(databaseProbe("postgres://test", now, Failed));
  assert.equal(closed, 1);
  await assert.rejects(
    notify(
      "https://example.invalid",
      "test",
      async () => new Response('{"code":1}'),
    ),
  );
});
