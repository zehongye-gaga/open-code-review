// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { githubPulls } = require("./monitor-data.js");

function startGitHubPolling(monitor, onFailure, makeWorker = (config) => new Worker(__filename, { workerData: config })) {
  const worker = makeWorker(monitor.config);
  let stopped = false, failed = false;
  const fail = () => { if (!stopped && !failed) { failed = true; onFailure(); } };
  worker.on("message", (message) => {
    if (message.error) monitor.remote = { ...monitor.remote, error: true };
    else monitor.remote = message;
  });
  worker.on("error", fail); worker.on("exit", fail);
  return async () => { stopped = true; await worker.terminate(); };
}
if (!isMainThread) {
  const poll = async () => {
    try { parentPort.postMessage({ ...await githubPulls(workerData), updatedAt: new Date().toISOString(), error: false }); }
    catch { parentPort.postMessage({ error: true }); }
    setTimeout(poll, 60000);
  };
  void poll();
}
module.exports = { startGitHubPolling };
