// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Worker } = require("node:worker_threads");
const { EventEmitter, once } = require("node:events");
const { startCollector, applyCollection, repeat } = require("./monitor-collector.js");
const { createMonitorServer } = require("./monitor.js");

test("HTTP serves the last complete snapshot while collector CPU work is blocked", async (t) => {
  const monitor = { snapshot() { return this.local || { ready: false }; } };
  let worker;
  const stop = startCollector(monitor, {}, () => assert.fail("unexpected collector failure"), () => {
    worker = new Worker(`
      const { parentPort } = require('node:worker_threads');
      parentPort.postMessage({kind:'local',local:{ready:true,collectedAt:'saved',stale:false,history:Array.from({length:5000},(_,id)=>({id,title:'review '.repeat(20)}))}});
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);
    `, { eval: true });
    return worker;
  });
  t.after(stop);
  await once(worker, "message");
  const server = createMonitorServer(monitor);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const result = await fetch(base + "/api/status", { signal: AbortSignal.timeout(2000) });
  const data = await result.json();
  assert.equal(data.ready, true); assert.equal(data.collectedAt, "saved"); assert.equal(data.history.length, 5000);
  assert.equal((await fetch(base + "/", { signal: AbortSignal.timeout(2000) })).status, 200);
});

test("local publication preserves independently refreshed GitHub state and timestamps", () => {
  const monitor = { analytics: {}, agentUsage: {}, remote: { updatedAt: "previous" } };
  const local = { collectedAt: "collected", analytics: { error: false } }, analytics = { repositories: [], runs: [] }, agentUsage = { error: true };
  applyCollection(monitor, { kind: "local", local, analytics, agentUsage });
  assert.equal(monitor.local, local); assert.equal(monitor.publishedAnalytics, analytics);
  assert.equal(monitor.agentUsage.value, agentUsage); assert.equal(monitor.remote.updatedAt, "previous");
  assert.equal(monitor.local.collectedAt, "collected");
});

test("collection waits for completion before scheduling its next interval", async () => {
  let release, scheduled = 0;
  const pending = repeat(() => new Promise((resolve) => { release = resolve; }), 10000,
    (_callback, delay) => { scheduled++; assert.equal(delay, 10000); });
  assert.equal(scheduled, 0);
  release(); await pending; assert.equal(scheduled, 1);
});

test("collector crashes fail the service once; intentional termination does not", async () => {
  const worker = new EventEmitter(); worker.terminate = async () => worker.emit("exit", 1);
  let failures = 0;
  const stop = startCollector({}, {}, () => failures++, () => worker);
  worker.emit("error", new Error("crash")); worker.emit("exit", 1);
  assert.equal(failures, 1); await stop(); assert.equal(failures, 1);
  const clean = new EventEmitter(); clean.terminate = async () => clean.emit("exit", 1);
  await startCollector({}, {}, () => failures++, () => clean)();
  assert.equal(failures, 1);
});
