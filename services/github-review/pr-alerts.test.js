// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {Alerts,events,message}=require("./pr-alerts.js");
const job={id:1,repository:"org/repo",number:2,head:"abc",state:"failed",attempt:4,startedAt:"2026-10-26T01:00:00Z",updatedAt:"2026-10-26T02:00:00Z",retryBudget:4000000,error:"budget exhausted"};
function setup(t,request){const dir=fs.mkdtempSync(path.join(os.tmpdir(),"pr-alerts-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const webhookFile=path.join(dir,"hook");fs.writeFileSync(webhookFile,"https://open.feishu.cn/open-apis/bot/v2/hook/1234-abcd");return {directory:dir,webhookFile};}
test("terminal job and CI failure are one event; retries and normal cancellations are quiet",()=>{
 assert.equal(events({jobs:[job],ciReceipts:{r:{state:"failed",jobId:1,repository:"org/repo",pull_number:2}}}).length,1);
 assert.equal(events({jobs:[{...job,state:"queued"},{...job,state:"cancelled"}]}).length,0);
 assert.equal(events({jobs:[{...job,state:"complete",progress:{complete:true},result:{blocking:2}}]},true)[0].type,"blocked");
 assert.equal(events({jobs:[{...job,state:"complete",progress:{complete:true},result:{blocking:2}}]},false).length,0);
 const text=message({...events({jobs:[job]})[0],reason:"Bearer secret github_pat_sensitive ghs_private"});
 assert.match(text,/2026\/10\/26 10:00:00/);assert.ok(!text.includes("secret"));assert.ok(!text.includes("ghs_private"));assert.match(text,/4000000/);
});
test("persistent deduplication survives delivery retry and execution restarts",async(t)=>{
 let fail=true,calls=0;const request=async(url,options)=>{calls++;assert.equal(options.redirect,"error");assert.equal(JSON.parse(options.body).msg_type,"text");return {ok:true,json:async()=>({code:fail?1:0})};};
 const c=setup(t),a=new Alerts(c,request);await a.collect({jobs:[]},1000);
 let r=await a.collect({jobs:[job]},2000);assert.equal(r.failed,1);assert.equal(calls,1);
 const b=new Alerts(c,request);await b.collect({jobs:[job]},3000);assert.equal(calls,1);fail=false;
 r=await b.collect({jobs:[job]},62000);assert.equal(r.sent,1);
 await new Alerts(c,request).collect({jobs:[job]},63000);assert.equal(calls,2);
 r=await b.collect({jobs:[{...job,startedAt:"2026-10-26T03:00:00Z"}]},64000);assert.equal(r.sent,0);
});
test("initial historical failures are baselined; recovered pending alerts are suppressed",async(t)=>{
 let calls=0;const request=async()=>{calls++;throw Error("offline");};const c=setup(t),a=new Alerts(c,request);
 assert.equal((await a.collect({jobs:[job]},1)).baseline,1);assert.equal(calls,0);
 await a.collect({jobs:[{...job,id:2}]},2);assert.equal(calls,1);
 await a.collect({jobs:[{...job,id:2,state:"running"}]},70000);assert.equal(calls,1);assert.equal(Object.keys(a.state.pending).length,0);
});

test("completed backend results take precedence over stale ingress failures",()=>{
 const skipped={...job,state:"complete",progress:{skipped:true,selected:0},result:{skipped:true,findings:0,blocking:0,summaryURL:"https://example.test/review"}};
 const receipt={state:"failed",jobId:1,repository:"org/repo",pull_number:2,reason:"review_incomplete_or_failed"};
 assert.equal(events({jobs:[skipped],ciReceipts:{r:receipt}}).length,0);
 assert.equal(events({jobs:[skipped],ciReceipts:{r:{...receipt,state:"skipped"}}}).length,0);
 assert.equal(events({jobs:[skipped],ciReceipts:{r:{...receipt,reason:"n8n_tracking_stalled"}}}).length,0);
 assert.equal(events({jobs:[{...skipped,result:{...skipped.result,summaryURL:""}}],ciReceipts:{r:receipt}}).length,1);
 assert.equal(events({jobs:[{...skipped,state:"failed"}],ciReceipts:{r:receipt}}).length,1);
});

test("legacy completed records without evidence do not create a new historical alert flood",()=>{
 assert.equal(events({jobs:[{...job,state:"complete",progress:undefined,result:undefined}]}).length,0);
});

test("repository removal suppresses dispatch failures and already queued notifications",async(t)=>{
 let calls=0;const c=setup(t),policy=path.join(c.directory,"policy.json");c.repositoryPolicyFile=policy;
 fs.writeFileSync(policy,JSON.stringify({repositories:[{name:"org/repo"}]}));
 const a=new Alerts(c,async()=>{calls++;throw Error("offline");});await a.collect({jobs:[]},1);
 await a.collect({jobs:[job]},2);assert.equal(calls,1);
 fs.writeFileSync(policy,JSON.stringify({repositories:[{name:"org/retained"}]}));
 await a.collect({jobs:[job],deliveries:[{id:"new",repository:"org/repo",number:3,state:"failed"}]},70000);
 assert.equal(calls,1);assert.equal(Object.keys(a.state.pending).length,0);
 fs.writeFileSync(policy,JSON.stringify({repositories:[],infrastructure:{organizations:[{name:"org"}]}}));
 await a.collect({jobs:[{...job,id:2}]},80000);assert.equal(calls,2);
});

test("legacy failure and blocking notification identities migrate without another message", async t => {
  for (const blocked of [false, true]) {
    const config = { ...setup(t), notifyBlocking: true };
    let calls = 0;
    const alerts = new Alerts(config, async () => { calls++; return { ok: true, json: async () => ({ code: 0 }) }; });
    await alerts.collect({ jobs: [] }, 1);
    const legacyKey = `job:1:1:2026-10-26T01:00:00Z:${blocked ? "complete" : "failed"}`;
    alerts.state.seen[legacyKey] = { sentAt: 1 };
    alerts.save();
    const record = blocked ? { ...job, state: "complete", progress: { complete: true }, result: { blocking: 1 } } : job;
    await alerts.collect({ jobs: [record] }, 2);
    assert.equal(calls, 0);
    assert.equal(alerts.state.seen[events({ jobs: [record] }, true)[0].key].migratedFrom, legacyKey);
  }
});
