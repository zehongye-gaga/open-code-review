// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { startGitHubPolling } = require("./monitor-github-worker.js");
test("GitHub polling retains the last success on request failure and exits on worker failure", async () => {
  const worker = new EventEmitter(); worker.terminate = async () => worker.emit("exit", 1);
  const monitor = { config: {}, remote: { pulls: [] } }; let failures = 0;
  const stop = startGitHubPolling(monitor, () => failures++, () => worker);
  worker.emit("message", { pulls: [{ number: 1 }], updatedAt: "saved", error: false });
  worker.emit("message", { error: true });
  assert.deepEqual(monitor.remote, { pulls: [{ number: 1 }], updatedAt: "saved", error: true });
  worker.emit("error", Error("worker failed")); worker.emit("exit", 1); assert.equal(failures, 1);
  await stop(); assert.equal(failures, 1);
});
