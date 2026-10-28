// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { State } = require("./state.js"), { DispatchCheck } = require("./dispatch-check.js");
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-check-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pr = { number: 1, state: "open", head: { sha: "a".repeat(40), ref: "topic", repo: { full_name: "org/repo" } }, base: { sha: "b".repeat(40), ref: "main" } };
  const writes = [], pulls = [pr];
  const s = { config: { infrastructure: { externalDispatch: true, dispatchEnabled: true, dispatchCheck: { enabled: true } } }, state: new State(dir), coordinates: () => ({ owner: "org", repo: "repo" }),
    eligible: (_, p) => p.state === "open" && !p.draft, log() {}, github: { rest: {
      pulls: { get: async ({ pull_number }) => ({ data: structuredClone(pulls.find(p => p.number === pull_number)) }), list: async () => ({ data: structuredClone(pulls.filter(p=>p.state === "open")) }) },
      repos: { createCommitStatus: async args => { const saved = JSON.parse(fs.readFileSync(s.state.file)); assert.ok(saved.deliveries?.length || Object.keys(saved.dispatchChecks || {}).length); writes.push(args); } },
    } } };
  const gate = s.dispatchCheck = new DispatchCheck(s);
  function admit(p = pr) {
    (s.state.data.deliveries ||= []).push({ id: String((s.state.data.deliveries || []).length), repository: "org/repo", number: p.number, head: p.head.sha, base: p.base.sha, baseRef: p.base.ref, admitted: true, state: "pending" });
    s.state.save(); gate.watch("org/repo", p.number, p.head.sha);
  }
  const entry = () => s.state.data.dispatchChecks[`org/repo:${pr.head.sha}`];
  return { s, gate, pr, pulls, writes, admit, entry, dir };
}
test("durable admission is sufficient without a worker, while the feature is disabled by default", async t => {
  const h = setup(t); h.s.config.infrastructure.dispatchCheck.enabled = false; h.admit(); await h.gate.tick(); assert.equal(h.writes.length, 0);
  h.s.config.infrastructure.dispatchCheck.enabled = true; h.admit(); await h.gate.tick();
  assert.deepEqual(h.writes.map(w=>w.state), ["pending", "success"]);
  assert.ok(h.writes.every(w=>w.context === "ocr-dispatch")); assert.equal(h.s.state.data.jobs.length, 0);
});
test("same SHA and same base SHA retarget invalidates green until the new branch has durable admission", async t => {
  const h=setup(t); h.admit(); await h.gate.tick(); h.pr.base.ref="release";
  h.gate.watch("org/repo",1,h.pr.head.sha); await h.gate.tick(); assert.equal(h.writes.at(-1).state,"failure");
  h.admit(); await h.gate.tick(); assert.equal(h.writes.at(-1).state,"success");
  // A delayed old event cannot restore its original branch's receipt as the selected snapshot.
  h.pr.base.sha="c".repeat(40); h.gate.watch("org/repo",1,h.pr.head.sha); await h.gate.tick();
  assert.equal(h.writes.at(-1).state,"failure");
});
test("a sibling PR sharing the commit cannot inherit another PR's admission", async t => {
  const h=setup(t); h.admit(); h.pulls.push({...structuredClone(h.pr),number:2,head:{...h.pr.head,ref:"another-topic",repo:{full_name:"fork/repo"}},base:{sha:"b".repeat(40),ref:"release"}});
  await h.gate.tick(); assert.equal(h.writes.at(-1).state,"failure");
  h.admit(h.pulls[1]); await h.gate.tick(); assert.equal(h.writes.at(-1).state,"success");
});
test("failed dispatch fails the gate; completed dispatch stays accepted independently of review failure", async t => {
  const h=setup(t); h.admit(); const event=h.s.state.data.deliveries[0]; event.state="failed"; await h.gate.tick();
  assert.equal(h.writes.at(-1).state,"failure");
  event.jobId=1; h.s.state.data.jobs.push({id:1,repository:"org/repo",number:1,head:h.pr.head.sha,base:h.pr.base.sha,baseRef:h.pr.base.ref,state:"failed"});
  h.entry().nextAt=0; await h.gate.tick(); assert.equal(h.writes.at(-1).state,"success");
});
test("publication outages recover from persisted state without dispatching a new job", async t => {
  const h=setup(t); h.admit(); const write=h.s.github.rest.repos.createCommitStatus;
  h.s.github.rest.repos.createCommitStatus=async()=>{throw Error("offline");}; await h.gate.tick(); assert.ok(h.entry().error);
  h.s.state=new State(h.dir); h.s.github.rest.repos.createCommitStatus=write; const recovered=new DispatchCheck(h.s);
  h.entry().nextAt=0; await recovered.tick(); assert.equal(h.writes.at(-1).state,"success"); assert.equal(h.s.state.data.jobs.length,0);
});
test("closed PRs never pass and stop polling until another event arrives", async t => {
  const h=setup(t); h.admit(); h.pr.state="closed"; await h.gate.tick(); assert.equal(h.writes.at(-1).state,"failure"); assert.equal(h.entry().retired,true);
  h.pr.state="open"; h.gate.watch("org/repo",1,h.pr.head.sha); await h.gate.tick(); assert.equal(h.writes.at(-1).state,"success");
});
test("an event arriving during status publication leaves pending rather than stale success", async t => {
  const h=setup(t); h.admit(); const write=h.s.github.rest.repos.createCommitStatus;
  h.s.github.rest.repos.createCommitStatus=async args=>{await write(args); if(args.state==="success"){h.pr.base.ref="release";h.gate.watch("org/repo",1,h.pr.head.sha);}};
  await h.gate.tick(); assert.equal(h.writes.at(-1).state,"pending");
  await h.gate.tick(); assert.equal(h.writes.at(-1).state,"failure");
});
test("persist failure never produces a successful status", async t => {
  const h=setup(t); h.s.state.save=()=>{throw Object.assign(Error("disk full"),{persistence:true});};
  assert.throws(()=>h.admit(),/disk full/); assert.equal(h.writes.length,0);
});


test("restart recovers the admission-to-watch crash gap and disabled routing cannot pass", async t => {
  const h = setup(t); h.admit(); delete h.s.state.data.dispatchChecks; h.s.state.save();
  h.s.state = new State(h.dir);
  await new DispatchCheck(h.s).tick(); assert.equal(h.writes.at(-1).state, "success");
  h.s.config.infrastructure.dispatchEnabled = false; h.entry().nextAt = 0;
  await new DispatchCheck(h.s).tick(); assert.equal(h.writes.at(-1).state, "failure");
});


test("admission proof survives terminal artifact retention without passing a different snapshot", async t => {
  const h = setup(t); h.admit(); await h.gate.tick();
  h.s.state.data.deliveries = []; h.entry().nextAt = 0;
  await h.gate.tick(); assert.equal(h.writes.at(-1).state, "success");
  h.pr.base.ref = "release"; h.entry().nextAt = 0;
  await h.gate.tick(); assert.equal(h.writes.at(-1).state, "failure");
});
test("rate limits honor retry-after without another write and survive a new observation", async t => {
  const h = setup(t); h.admit();
  h.s.github.rest.pulls.get = async () => { throw { status: 403, response: { headers: { "retry-after": "90" } } }; };
  await h.gate.tick(); assert.equal(h.writes.length, 1); assert.equal(h.writes[0].state, "pending");
  assert.ok(h.entry().nextAt >= Date.now() + 89000);
  h.gate.watch("org/repo", 1, h.pr.head.sha); await h.gate.tick(); assert.equal(h.writes.length, 1);
});


test("a terminal CI receipt keeps its proven admission when its job artifacts expire", async t => {
  const h = setup(t); h.admit(); await h.gate.tick();
  h.s.state.data.deliveries = [];
  h.s.state.data.ciReceipts = { r: { repository: "org/repo", pull_number: 1, head_sha: h.pr.head.sha,
    base_sha: h.pr.base.sha, base_ref: h.pr.base.ref, state: "complete", jobId: 123 } };
  h.entry().nextAt = 0; await h.gate.tick(); assert.equal(h.writes.at(-1).state, "success");
});
