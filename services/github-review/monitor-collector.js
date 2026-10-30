// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";

const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { Monitor } = require("./monitor-data.js");

function applyCollection(monitor, message) {
  if (message.kind === "local") {
    monitor.local = message.local;
    monitor.publishedAnalytics = message.analytics;
    if (monitor.agentUsage) monitor.agentUsage.value = message.agentUsage;
  }
}

function startCollector(monitor, options, onFailure, makeWorker = (data) => new Worker(__filename, { workerData: data })) {
  const worker = makeWorker(options);
  let stopped = false, failed = false;
  const fail = () => {
    if (stopped || failed) return;
    failed = true;
    onFailure();
  };
  worker.on("message", (message) => applyCollection(monitor, message));
  worker.on("error", fail);
  worker.on("exit", fail);
  return async () => { stopped = true; await worker.terminate(); };
}

async function repeat(task, interval, schedule = setTimeout) {
  try { await task(); }
  catch { console.error("Monitor collection failed; last snapshot retained"); }
  // Schedule after completion so slow collection cannot run continuously.
  schedule(() => void repeat(task, interval, schedule), interval);
}

if (!isMainThread) {
  const monitor = new Monitor(workerData);
  void repeat(async () => {
    await monitor.collect();
    parentPort.postMessage({ kind: "local", local: monitor.local,
      analytics: monitor.analyticsViews(), agentUsage: monitor.agentUsage?.value });
  }, 10000);
}

module.exports = { applyCollection, startCollector, repeat };
