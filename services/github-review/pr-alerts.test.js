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
 assert.equal(events({jobs:[{...job,state:"complete",result:{blocking:2}}]})[0].type,"blocked");
 assert.equal(events({jobs:[{...job,state:"complete",result:{blocking:2}}]},false).length,0);
 const text=message({...events({jobs:[job]})[0],reason:"Bearer secret github_pat_sensitive ghs_private"});
 assert.match(text,/2026\/10\/26 10:00:00/);assert.ok(!text.includes("secret"));assert.ok(!text.includes("ghs_private"));assert.match(text,/4000000/);
});
test("persistent deduplication, delivery retry and a new attempt produce correct notifications",async(t)=>{
 let fail=true,calls=0;const request=async(url,options)=>{calls++;assert.equal(options.redirect,"error");assert.equal(JSON.parse(options.body).msg_type,"text");return {ok:true,json:async()=>({code:fail?1:0})};};
 const c=setup(t),a=new Alerts(c,request);await a.collect({jobs:[]},1000);
 let r=await a.collect({jobs:[job]},2000);assert.equal(r.failed,1);assert.equal(calls,1);
 const b=new Alerts(c,request);await b.collect({jobs:[job]},3000);assert.equal(calls,1);fail=false;
 r=await b.collect({jobs:[job]},62000);assert.equal(r.sent,1);
 await new Alerts(c,request).collect({jobs:[job]},63000);assert.equal(calls,2);
 r=await b.collect({jobs:[{...job,startedAt:"2026-10-26T03:00:00Z"}]},64000);assert.equal(r.sent,1);
});
test("initial historical failures are baselined; recovered pending alerts are suppressed",async(t)=>{
 let calls=0;const request=async()=>{calls++;throw Error("offline");};const c=setup(t),a=new Alerts(c,request);
 assert.equal((await a.collect({jobs:[job]},1)).baseline,1);assert.equal(calls,0);
 await a.collect({jobs:[{...job,id:2}]},2);assert.equal(calls,1);
 await a.collect({jobs:[{...job,id:2,state:"running"}]},70000);assert.equal(calls,1);assert.equal(Object.keys(a.state.pending).length,0);
});
