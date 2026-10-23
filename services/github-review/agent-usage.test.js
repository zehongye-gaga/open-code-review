// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AgentUsage } = require("./agent-usage.js");
const { ReviewDataset } = require("./review-dataset.js");
test("session counters are attributed only by exact PR binding and replaced rather than summed", async (t) => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-usage-")); t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
 const tokenFile=path.join(dir,"token");fs.writeFileSync(tokenFile,"private");
 let fail=false;
 const a=new AgentUsage({url:"https://example.test/v1/chat/completions",model:"agent",tokenFile},dir,async()=>{if(fail)throw Error("secret");return {ok:true,json:async()=>({total:2,sessions:[{key:"bound",inputTokens:100,outputTokens:20},{key:"unrelated",inputTokens:999,outputTokens:100}]})};});
 const bindings={a:{id:"a",repository:"Org/Repo",number:1,url:a.config.url,model:"agent",sessionKey:"bound"}};
 await a.collect(bindings,Date.now());a.nextAt=0;await a.collect(bindings,Date.now());
 assert.equal(a.snapshot().sessions.length,1);assert.equal(a.snapshot().sessions[0].totalTokens,120);
 assert.ok(!JSON.stringify(a.value).includes('\"bound\"'));fail=true;a.nextAt=0;await a.collect(bindings);assert.equal(a.snapshot().sessions[0].totalTokens,120);assert.equal(a.value.error,true);
});
test("dataset writes changed observations once and preserves deduplication across restart", (t) => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"review-dataset-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const d=new ReviewDataset(dir);d.append("dispatch",[{id:"1",state:"queued"}]);d.append("dispatch",[{id:"1",state:"queued"}]);
 const next=new ReviewDataset(dir);next.append("dispatch",[{id:"1",state:"complete"}]);
 const file=fs.readdirSync(path.join(dir,"dataset")).find(x=>x.endsWith('.jsonl'));const rows=fs.readFileSync(path.join(dir,"dataset",file),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(rows.length,2);assert.notEqual(rows[0].eventId,rows[1].eventId);assert.equal(rows[0].labelStatus,'unvalidated');
});
