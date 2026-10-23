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
 const a=new AgentUsage({url:"https://example.test/v1/chat/completions",model:"agent",tokenFile},dir,async(url)=>{if(fail)throw Error("secret");if(url.pathname.endsWith("session-children"))return {ok:true,json:async()=>({items:[]})};return {ok:true,json:async()=>({total:2,sessions:[{key:"bound",inputTokens:100,outputTokens:20},{key:"unrelated",inputTokens:999,outputTokens:100}]})};});
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
test("child trees include nested and paginated usage once; incomplete reads preserve the previous snapshot", async (t) => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"agent-tree-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const tokenFile=path.join(dir,"token");fs.writeFileSync(tokenFile,"private");let fail=false;
 const a=new AgentUsage({url:"https://example.test/v1/chat/completions",model:"agent",tokenFile},dir,async(url)=>{
  const key=url.searchParams.get("key") || url.searchParams.get("session_key");
  if(fail && key==="grandchild")return {ok:false};
  if(url.pathname==="/v1/sessions")return {ok:true,json:async()=>({sessions:[{key,inputTokens:10,outputTokens:2}]})};
  const page=key==="parent" ? (url.searchParams.get("cursor") ? {items:[{session_key:"child"}]} : {items:[{session_key:"child"}],next_cursor:"next"}) : key==="child" ? {items:[{session_key:"grandchild"}]} : {items:[]};
  return {ok:true,json:async()=>page};
 });
 const bindings={a:{id:"a",repository:"org/repo",number:1,url:a.config.url,model:"agent",sessionKey:"parent"}};
 await a.collect(bindings);let row=a.snapshot().sessions[0];
 assert.equal(row.totalTokens,36);assert.equal(row.childSessions,2);assert.equal(row.childInputTokens,20);assert.equal(row.components.length,3);
 fail=true;a.nextAt=0;await a.collect(bindings);assert.equal(a.value.error,true);assert.equal(a.snapshot().sessions[0].totalTokens,36);
 fail=false;bindings.b={...bindings.a,id:"b",sessionKey:"child"};a.nextAt=0;await a.collect(bindings);assert.equal(a.value.error,true);assert.equal(a.snapshot().sessions.length,1);
});
