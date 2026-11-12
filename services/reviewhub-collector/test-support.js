// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { SQLiteState } = require("../github-review/state-sqlite.js");
const { encoded } = require("../github-review/analytics.js");
function fixture(t, now = Date.now()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewhub-collector-"));
  const repository = "company/repo",
    workspace = path.join(root, "repositories", repository),
    directory = path.join(root, "runs", "ocr-pr-sample");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(directory, { recursive: true });
  const createdAt = new Date(now - 120000).toISOString(),
    startedAt = new Date(now - 60000).toISOString(),
    updatedAt = new Date(now - 1000).toISOString();
  const job = {
    id: "1",
    repository,
    number: 12,
    head: "a".repeat(40),
    base: "b".repeat(40),
    baseRef: "main",
    state: "complete",
    attempt: 1,
    directory,
    workspace,
    createdAt,
    startedAt,
    updatedAt,
    progress: { sessionId: "session-one", complete: true },
    result: {
      findings: 1,
      blocking: 1,
      summaryURL: "https://github.com/company/repo/pull/12#review"
    }
  };
  const value = {
    version: 1,
    sequence: 1,
    initialized: {},
    pulls: {},
    checkpoints: {},
    jobs: [job],
    deliveries: [],
    ciReceipts: {},
    agentSessions: {}
  };
  const database = new SQLiteState(path.join(root, "state.db"));
  database.save(value);
  const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data));
  write(path.join(directory, "metadata.json"), {
    number: job.number,
    head: job.head,
    base: job.base,
    merge_base: job.base,
    telemetry: {
      repository,
      jobId: "1",
      workspace,
      preparedAt: startedAt,
      attempt: 1
    }
  });
  write(path.join(directory, "result.json"), {
    status: "complete",
    session_id: "session-one",
    comments: [
      {
        severity: "high",
        content: "Preserve the transaction",
        path: "worker.js",
        line: 8
      }
    ],
    manifest: {
      run_id: "session-one",
      input: { resolved_head: job.head, resolved_base: job.base },
      terminal_state: "complete"
    }
  });
  const sessionDirectory = path.join(root, "sessions");
  const file = path.join(
    sessionDirectory,
    encoded(workspace),
    "session-one.jsonl"
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const events = [
    {
      type: "session_start",
      cwd: workspace,
      sessionId: "session-one",
      timestamp: startedAt,
      diffTo: job.head,
      diffFrom: job.base
    },
    {
      type: "llm_response",
      timestamp: updatedAt,
      taskType: "main_task",
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        cache_read_tokens: 50,
        cache_write_tokens: 5
      }
    },
    {
      type: "session_end",
      timestamp: updatedAt,
      duration_seconds: 59,
      run_manifest: { terminal_state: "complete" }
    }
  ];
  fs.writeFileSync(
    file,
    events.map((e) => JSON.stringify(e)).join("\n") + "\n"
  );
  const config = {
    stateDirectory: root,
    repositories: [{ name: repository }],
    organizations: ["company"]
  };
  const options = {
    intervalSeconds: 300,
    githubMetadata: false,
    analytics: { sessionDirectory }
  };
  t.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, config, options, database, value, job, now, file, directory };
}
module.exports = { fixture };
