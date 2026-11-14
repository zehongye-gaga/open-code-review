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
function reviewSignal(job) {
  return operationalSignals(
    { jobs: [job] },
    {
      repositories: [{ id: "github:42", name: "company/repo", aliases: [] }],
      runs: [{ sourceJobId: "1", id: "run:1" }],
    },
  )[0];
}
function retryEvidence(overrides = {}) {
  return {
    attempt: 1,
    maxAttempts: 3,
    from: 200000,
    to: 400000,
    at: "2026-11-14T01:00:00.000Z",
    directory: "/private/runs/first",
    reason:
      "prompt exceeded the configured token budget\nprompt tokens (162461) exceed 80% of max_tokens(200000)",
    artifacts: [
      "/private/runs/first/result.json",
      "/private/sessions/review.jsonl",
    ],
    ...overrides,
  };
}
function signalJob(overrides = {}) {
  return {
    id: "1",
    repository: "company/repo",
    number: 12,
    head: "a".repeat(40),
    base: "b".repeat(40),
    state: "queued",
    attempt: 1,
    createdAt: "2026-11-14T00:00:00.000Z",
    updatedAt: "2026-11-14T01:00:00.000Z",
    ...overrides,
  };
}
test("retry identities survive repeated collection, reordered history and successful completion", () => {
  const original = retryEvidence({
    reason: retryEvidence().reason + "\n" + "detail ".repeat(300),
  });
  const job = signalJob({ contextRetries: [original] });
  const before = JSON.stringify(job),
    first = reviewSignal(job);
  assert.equal(first.state, "queued");
  assert.equal(first.retryEvents.length, 1);
  assert.equal(first.retryEvents[0].diagnostic.message, original.reason);
  assert.deepEqual(
    first.retryEvents[0].diagnostic.artifacts,
    original.artifacts,
  );
  assert.equal(JSON.stringify(job), before);
  assert.deepEqual(reviewSignal(JSON.parse(before)), first);
  const second = retryEvidence({
    attempt: 2,
    from: 400000,
    to: 800000,
    at: "2026-11-14T01:01:00.000Z",
  });
  job.contextRetries = [second, original];
  job.state = "complete";
  job.attempt = 3;
  job.progress = { complete: true };
  job.result = { blocking: 0, findings: 0 };
  const completed = reviewSignal(job);
  assert.equal(completed.state, "succeeded");
  assert.deepEqual(
    completed.retryEvents.map((event) => event.attempt),
    [1, 2],
  );
  assert.equal(completed.retryEvents[0].id, first.retryEvents[0].id);
  assert.notEqual(completed.retryEvents[0].id, completed.retryEvents[1].id);
  assert.deepEqual(
    completed.retryEvents.map((event) => [event.fromTokens, event.toTokens]),
    [
      [200000, 400000],
      [400000, 800000],
    ],
  );
  const other = reviewSignal({ ...job, id: "2" });
  assert.notEqual(other.retryEvents[0].id, completed.retryEvents[0].id);
});
test("terminal diagnostics preserve raw details and newlines while recognized credentials are redacted", () => {
  const message =
    retryEvidence().reason +
    "\nrequest-id: original-id\nAuthorization: Bearer private-bearer\n" +
    'github_pat_private_token\napi_key=private-key\nclient_secret: "private-client-secret"\n' +
    "token=private-token\nsecret: private-secret\nAuthorization: bearer\tprivate-lowercase-bearer\n" +
    "CUSTOM_API_KEY=prefixed-key\nAUTH_TOKEN=prefixed-token\n" +
    JSON.stringify({ password: 'escaped"credential' }) + "\n" +
    JSON.stringify({ password: 'Bearer abc"credential-tail' }) + "\n" +
    JSON.stringify({ password: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc"credential-tail' }) + "\n" +
    "https://open.feishu.cn/open-apis/bot/v2/hook/private-webhook";
  const job = signalJob({
    state: "failed",
    directory: "/private/runs/current",
    failureDiagnostics: {
      message,
      artifacts: [
        "/private/runs/current/result.json",
        "/private/sessions/current.jsonl",
      ],
    },
  });
  const row = reviewSignal(job);
  assert.equal(row.state, "failed");
  assert.ok(
    row.failureDiagnostic.message.startsWith(
      retryEvidence().reason + "\nrequest-id: original-id\n",
    ),
  );
  assert.match(
    row.failureDiagnostic.message,
    /Authorization: Bearer \[REDACTED\]/,
  );
  assert.match(row.failureDiagnostic.message, /api_key=\[REDACTED\]/);
  assert.match(row.failureDiagnostic.message, /client_secret: \[REDACTED\]/);
  assert.match(row.failureDiagnostic.message, /token=\[REDACTED\]/);
  assert.match(row.failureDiagnostic.message, /secret: \[REDACTED\]/);
  assert.match(row.failureDiagnostic.message, /bearer\t\[REDACTED\]/);
  assert.match(row.failureDiagnostic.message, /\[WEBHOOK REDACTED\]/);
  assert.doesNotMatch(
    row.failureDiagnostic.message,
    /private-bearer|github_pat_private|private-key|private-client-secret|private-webhook|private-token|private-secret|private-lowercase-bearer|prefixed-key|prefixed-token|escaped|credential/,
  );
  assert.deepEqual(
    row.failureDiagnostic.artifacts,
    job.failureDiagnostics.artifacts,
  );
  job.state = "queued";
  assert.equal(reviewSignal(job).failureDiagnostic, undefined);
  job.contextRetries = [retryEvidence({ reason: message, artifacts: ["/run?AUTH_TOKEN=prefixed-token"] })];
  const warning = reviewSignal(job).retryEvents[0].diagnostic;
  assert.doesNotMatch(warning.message, /prefixed-key|prefixed-token|escaped|credential/);
  assert.doesNotMatch(warning.artifacts[0], /prefixed-token/);
});
test("legacy and malformed retry evidence cannot invalidate otherwise valid signals", () => {
  const job = signalJob({ state: "failed", error: "legacy failure" });
  const legacy = reviewSignal(job);
  assert.equal(legacy.retryEvents, undefined);
  assert.equal(legacy.failureDiagnostic, undefined);
  job.contextRetries = [
    null,
    false,
    "invalid",
    retryEvidence({ attempt: "1" }),
    retryEvidence({ attempt: 3 }),
    retryEvidence({ maxAttempts: 4 }),
    retryEvidence({ from: 0 }),
    retryEvidence({ to: 600000 }),
    retryEvidence({ at: "2026-02-30T01:00:00.000Z" }),
    retryEvidence({ reason: { private: true } }),
  ];
  job.failureDiagnostics = { message: { private: true } };
  assert.deepEqual(reviewSignal(job), legacy);
  job.contextRetries = [retryEvidence(), retryEvidence()];
  assert.equal(reviewSignal(job).retryEvents.length, 1);
  job.contextRetries.push(
    retryEvidence({ reason: "conflicting evidence" }),
    retryEvidence({ attempt: 2, from: 400000, to: 800000 }),
  );
  assert.deepEqual(
    reviewSignal(job).retryEvents.map((event) => event.attempt),
    [2],
  );
});
test("oversized diagnostics explicitly identify truncation and preserve valid full-artifact references", () => {
  const artifacts = [
    "/private/runs/current/result.json",
    "/private/sessions/current.jsonl",
    null,
    12,
    "x".repeat(1001),
    "bad\npath",
  ];
  const job = signalJob({
    state: "failed",
    failureDiagnostics: {
      message: "raw start\n" + "x".repeat(300000) + "\nraw end",
      artifacts,
    },
  });
  const row = reviewSignal(job);
  assert.ok(row.failureDiagnostic.message.startsWith("raw start\n"));
  assert.ok(row.failureDiagnostic.message.length <= 262144);
  assert.match(
    row.failureDiagnostic.message,
    /\[Diagnostic truncated by collector; full text remains in the referenced source artifacts\.\]$/,
  );
  assert.deepEqual(row.failureDiagnostic.artifacts, artifacts.slice(0, 2));
  job.failureDiagnostics = { message: "original short reason" };
  job.directory = "/private/runs/legacy";
  assert.deepEqual(reviewSignal(job).failureDiagnostic, {
    message: "original short reason",
    artifacts: ["/private/runs/legacy/result.json"],
  });
});
test("collector validates retry history and terminal diagnostics against the exported ReviewHub contract", async (t) => {
  const f = fixture(t);
  f.job.state = "failed";
  f.job.contextRetries = [
    retryEvidence(),
    retryEvidence({ attempt: 2, from: 400000, to: 800000 }),
  ];
  f.job.failureDiagnostics = {
    message: "original\nterminal detail",
    artifacts: [f.directory + "/result.json"],
  };
  f.database.save(f.value);
  let committed = false;
  await collect({
    ...f,
    saved: { records: new Map(), checkpoint: {} },
    metadataReader: async () => ({ metadata: {}, warnings: [] }),
    resourcesReader: () => null,
    store: {
      sourceId: "test",
      publish: async (batch) => {
        assert.equal(validate(batch), true, JSON.stringify(validate.errors));
        assert.equal(batch.signals[0].retryEvents.length, 2);
        assert.equal(
          batch.signals[0].failureDiagnostic.message,
          "original\nterminal detail",
        );
        committed = true;
        return { ms: 1, rows: 1, bytes: 1 };
      },
      saveMetric: async () => {},
    },
  });
  assert.ok(committed);
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
