// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  { createHash } = require("node:crypto");
const { parseClientLog } = require("./client-log.js");
const { collectActions, policyOptions } = require("./actions.js");
const { actionsHTTP } = require("./actions-http.js");
const { backendAdmissions } = require("./backend-admission.js");
const { fixture } = require("./test-support.js"),
  { collect } = require("./collector.js");
const now = Date.parse("2026-11-12T12:00:00Z"),
  at = new Date(now - 60000).toISOString();
const repo = { id: "github:42", name: "company/repo", providerId: "42", aliases: [] };
const identity = {
  base_ref: "main",
  base_sha: "b".repeat(40),
  head_sha: "a".repeat(40),
  pull_number: 12,
  repository: repo.name
};
const requestId =
  "ocr-ci-" + createHash("sha256").update(JSON.stringify(identity)).digest("hex");
function logs(attempt = 1, outcome = "accepted") {
  const context = {
    schema: "ocr-policy-telemetry/v1",
    repository_id: "42",
    run_id: "100",
    run_attempt: String(attempt),
    ...identity,
    request_id: requestId,
    at
  };
  return [
    { ...context, sequence: 1, event: "ocr_client_started" },
    {
      ...context,
      sequence: 2,
      event: "ocr_gateway_request",
      operation: "ocr-ci-submit",
      attempt: 1,
      elapsed_ms: 15000,
      http_status: null,
      error_code: "http_timeout"
    },
    {
      ...context,
      sequence: 3,
      event: "ocr_client_result",
      outcome,
      elapsed_ms: 16000,
      reason: outcome === "timeout" ? "ack_deadline_exceeded" : null
    }
  ]
    .map((r) => at + " " + JSON.stringify(r))
    .join("\n");
}
const context = { repository: repo.name, repositoryId: "42", runId: "100", attempt: 1 };
function fakeHTTP() {
  const calls = [],
    state = { attempt: 1, conclusion: "success", log: null, unavailable: false };
  return {
    calls,
    state,
    async json(route) {
      calls.push(route);
      if (state.unavailable) throw Error("ACTIONS_HTTP_503");
      if (route.includes("/jobs?"))
        return { total_count: 1, jobs: [{ id: 500, name: "OCR dispatch" }] };
      if (route.includes("/attempts/"))
        return {
          id: 100,
          run_attempt: Number(route.split("/attempts/")[1]),
          status: "completed",
          conclusion: state.conclusion,
          created_at: at,
          run_started_at: at
        };
      return {
        total_count: 1,
        workflow_runs: [
          {
            id: 100,
            run_attempt: state.attempt,
            name: "OCR Dispatch",
            created_at: at,
            updated_at: at
          }
        ]
      };
    },
    async log(route) {
      calls.push(route);
      return state.log || logs(state.attempt);
    }
  };
}
test("client results are independent of HTTP attempts and validated against the run and snapshot", () => {
  const result = parseClientLog(logs(), context);
  assert.equal(result.outcome, "accepted");
  assert.equal(result.requests[0].errorCode, "http_timeout");
  assert.equal(result.coverage, "complete");
  assert.equal(result.requestId, requestId);
  assert.equal(parseClientLog(logs(1, "timeout"), context).outcome, "timeout");
  for (const patch of [
    { runId: "101" },
    { repository: "company/other" },
    { repositoryId: "43" },
    { attempt: 2 }
  ])
    assert.equal(parseClientLog(logs(), { ...context, ...patch }).outcome, "unknown");
  assert.equal(
    parseClientLog(logs().replaceAll(identity.head_sha, "c".repeat(40)), context).outcome,
    "unknown"
  );
});
test("missing, contradictory and legacy logs never imply a timeout or successful ACK", () => {
  const partial = logs().split("\n").slice(0, 2).join("\n");
  assert.equal(parseClientLog(partial, context).coverage, "partial");
  assert.equal(
    parseClientLog(partial, { ...context, cancelled: true }).outcome,
    "cancelled"
  );
  assert.equal(
    parseClientLog("OCR dispatch accepted\nHTTP 200", context).outcome,
    "unknown"
  );
  assert.equal(
    parseClientLog(logs() + "\n" + logs(1, "timeout").split("\n").at(-1), context)
      .outcome,
    "unknown"
  );
  assert.equal(
    parseClientLog(logs().replace('"sequence":2', '"sequence":9'), context).outcome,
    "unknown"
  );
  assert.deepEqual(
    parseClientLog(logs().replace('"sequence":2', '"sequence":9'), context).requests,
    []
  );
});
test("discovers client failures without a backend job, deduplicates completed logs and discovers old reruns", async () => {
  const http = fakeHTTP(),
    base = { config: {}, options: { enabled: true }, repositories: [repo], http, now };
  http.state.log = logs(1, "timeout");
  const first = await collectActions(base);
  assert.equal(first.attempts[0].outcome, "timeout");
  assert.equal(first.attempts[0].backend.length, 0);
  const saved = structuredClone([...first.records]);
  const second = await collectActions({
    ...base,
    previous: first.records,
    now: now + 300000
  });
  assert.equal(http.calls.filter((r) => r.endsWith("/logs")).length, 1);
  assert.deepEqual([...first.records], saved);
  http.state.attempt = 2;
  http.state.log = logs(2);
  const third = await collectActions({
    ...base,
    previous: second.records,
    now: now + 600000
  });
  assert.equal(third.attempts.length, 2);
  assert.deepEqual(
    third.attempts.map((r) => r.outcome),
    ["timeout", "accepted"]
  );
});
test("Actions errors retain the cursor and never block task SQLite publication", async (t) => {
  const f = fixture(t),
    http = fakeHTTP();
  http.state.unavailable = true;
  const saved = { checkpoint: {}, records: new Map() };
  const result = await collect({
    ...f,
    options: { ...f.options, policy: { enabled: true } },
    saved,
    store: { sourceId: "test", publish: async () => {} },
    resourcesReader: () => null,
    actionsReader: (input) => collectActions({ ...input, http })
  });
  assert.equal(result.batch.runs.length, 1);
  assert.equal(result.batch.clientCoverage[0].status, "error");
  assert.equal(result.batch.clientCoverage[0].through, null);
  assert.ok(result.batch.warnings.includes("POLICY_LOGS_UNAVAILABLE"));
  assert.equal(saved.records.size, 0);
});
test("pagination and GitHub's 1000 result limit preserve pending ranges across cycles", async () => {
  const routes = [];
  const http = {
    json: async (route) => {
      routes.push(route);
      return { total_count: routes.length === 1 ? 1001 : 0, workflow_runs: [] };
    }
  };
  const base = {
    config: {},
    options: { enabled: true },
    repositories: [repo],
    http,
    now
  };
  const first = await collectActions(base);
  assert.equal(first.records.get("scan:" + repo.id).windows.length, 2);
  assert.equal(first.coverage[0].through, null);
  const second = await collectActions({ ...base, previous: first.records });
  assert.equal(second.records.get("scan:" + repo.id).windows.length, 1);
  const third = await collectActions({ ...base, previous: second.records });
  assert.equal(third.coverage[0].status, "ready");
  assert.equal(third.coverage[0].through, new Date(now).toISOString());
  const bounds = routes
    .slice(1)
    .map((r) => new URL("https://api.github.com" + r).searchParams.get("created"));
  assert.notEqual(bounds[0], bounds[1]);
});
test("unexpected Actions setup failure does not block task publication", async (t) => {
  const f = fixture(t);
  let published;
  const saved = { checkpoint: {}, records: new Map() };
  const result = await collect({
    ...f,
    options: { ...f.options, policy: { enabled: true } },
    saved,
    store: {
      sourceId: "test",
      publish: async (batch) => {
        published = batch;
      }
    },
    resourcesReader: () => null,
    actionsReader: async () => {
      throw Error("Invalid GitHub configuration");
    }
  });
  assert.equal(published.runs.length, 1);
  assert.equal(result.batch.clientCoverage[0].status, "error");
  assert.ok(result.batch.warnings.includes("POLICY_LOGS_UNAVAILABLE"));
});
test("paged scans resume with a strict request budget and do not claim completeness early", async () => {
  const routes = [];
  const http = {
    json: async (route) => {
      routes.push(route);
      const page = Number(
        new URL("https://api.github.com" + route).searchParams.get("page")
      );
      return {
        total_count: 101,
        workflow_runs: Array.from({ length: page === 1 ? 100 : 1 }, (_, i) => ({
          id: i + 1 + (page - 1) * 100,
          run_attempt: 1,
          name: "Other CI",
          created_at: at,
          updated_at: at
        }))
      };
    }
  };
  const base = {
    config: {},
    options: { enabled: true, maxRequestsPerCycle: 4 },
    repositories: [repo],
    http,
    now
  };
  const first = await collectActions(base);
  assert.equal(first.coverage[0].status, "syncing");
  assert.equal(first.coverage[0].through, null);
  const second = await collectActions({ ...base, previous: first.records });
  assert.equal(second.coverage[0].status, "ready");
  assert.equal(
    new URL("https://api.github.com" + routes[1]).searchParams.get("page"),
    "2"
  );
  assert.equal(second.attempts.length, 0);
});
test("cancelled and absent structured logs remain unknown, permissions fail separately", async () => {
  const http = fakeHTTP();
  http.state.conclusion = "cancelled";
  http.state.log = "old output";
  const result = await collectActions({
    config: {},
    options: { enabled: true },
    repositories: [repo],
    http,
    now
  });
  assert.equal(result.attempts[0].outcome, "cancelled");
  assert.equal(result.attempts[0].coverage, "missing");
  assert.throws(() => policyOptions({ enabled: true, maxRequestsPerCycle: -1 }));
});
test("log redirects never receive API credentials, and arbitrary destinations are rejected", async () => {
  const calls = [];
  const http = actionsHTTP({ token: "test-token" }, async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1
      ? new Response(null, {
          status: 302,
          headers: { location: "https://test.blob.core.windows.net/log?sig=example" }
        })
      : new Response("logs");
  });
  assert.equal(await http.log("/repos/company/repo/actions/jobs/500/logs"), "logs");
  assert.equal(calls[0].options.headers.authorization, "Bearer test-token");
  assert.equal(calls[1].options.headers, undefined);
  const rejected = actionsHTTP(
    { token: "test" },
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://internal.example/log" }
      })
  );
  await assert.rejects(
    rejected.log("/repos/company/repo/actions/jobs/500/logs"),
    /DESTINATION_REJECTED/
  );
});
test("backend admission generations, reuse and stage timeout reasons remain distinct", () => {
  const receipt = {
    request_id: requestId,
    ...identity,
    createdAt: now - 120000,
    jobId: 1,
    state: "queued",
    dispatchMethod: "reused_existing",
    admissionGeneration: 2,
    pendingAdmission: { generation: 2, requestedAt: now - 60000 },
    retryHistory: [
      {
        admission: {
          generation: 1,
          requestedAt: now - 120000,
          finishedAt: now - 90000,
          state: "failed",
          reason: "admission_deadline_exceeded"
        }
      }
    ],
    fallbackReason: "agent_ack_timeout",
    fallbackAt: now - 30000
  };
  const batch = {
    repositories: [repo],
    runs: [{ id: "run:1", sourceJobId: "1", repositoryId: repo.id }]
  };
  const state = {
    ciReceipts: { [requestId]: receipt },
    jobs: [
      {
        id: 1,
        repository: repo.name,
        number: 12,
        executionOutcomes: [
          { reason: "cancelled", at },
          { reason: "native_execution_timeout", at: new Date(now).toISOString() }
        ]
      }
    ]
  };
  const result = backendAdmissions(state, batch);
  assert.equal(result.events.filter((e) => e.state === "generation_accepted").length, 2);
  assert.deepEqual(
    result.events.filter((e) => e.state === "timeout").map((e) => e.stage),
    ["admission", "dispatch", "execution"]
  );
  const attempt = { ...parseClientLog(logs(), context), repositoryId: repo.id };
  assert.equal(result.associate(attempt).length, 2);
  assert.equal(result.associate({ ...attempt, baseSha: "different" }).length, 0);
  const legacy = backendAdmissions(
    {
      ciReceipts: {
        [requestId]: {
          request_id: requestId,
          ...identity,
          createdAt: now,
          state: "queued"
        }
      }
    },
    batch
  );
  assert.equal(legacy.associate(attempt)[0].generation, null);
  assert.equal(legacy.events.filter((e) => e.stage === "admission").length, 0);
});
