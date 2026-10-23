// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { observation, overlaps, FeedbackCollector } = require("./benchmark-feedback.js");
const thread = { id:"t",path:"a.js",originalLine:10,isResolved:true,isOutdated:true,resolvedBy:{login:"bot"},comments:{totalCount:1,nodes:[{id:"c",body:"bug <!-- ocr-12-1-abcd -->",createdAt:"2026-01-01T00:00:00Z",originalCommit:{oid:"abc"}}]} };
const pr = {headRefOid:"def",state:"OPEN",merged:false};
test("resolved and changed code is an unverified candidate, never ground truth",()=>{
 const comparison={status:"ahead",files:[{filename:"a.js",patch:"@@ -10,2 +10,2 @@\n-old\n+new\n context"}],commits:[],total_commits:0};
 const row=observation("org/repo",1,thread,pr,comparison,[{id:1,head:"abc"}]);
 assert.equal(row.candidateLabel,"resolved_change_candidate");assert.equal(row.verified,false);assert.equal(row.resolutionOrigin,"unknown");assert.deepEqual(row.jobIds,["1"]);
 assert.equal(observation("org/repo",1,thread,pr,null,[]).candidateLabel,"resolved_only");
 assert.equal(overlaps(comparison.files[0].patch,11,11),false);
 const rejected=structuredClone(thread);rejected.comments.nodes.push({body:"false positive",createdAt:"2026-01-02"});rejected.comments.totalCount=2;
 assert.equal(observation("org/repo",1,rejected,pr,comparison,[]).candidateLabel,"rejection_candidate");
 const foreign=structuredClone(thread);foreign.comments.nodes[0].body="human comment";assert.equal(observation("org/repo",1,foreign,pr,null,[]),null);
});
test("collector is read-only, paginates threads, deduplicates snapshots and isolates API failures",async(t)=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"feedback-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const token=path.join(dir,"token");fs.writeFileSync(token,"secret");let failure=false;
 const c=new FeedbackCollector({githubTokenFile:token},dir,async(url,options)=>{
  if(failure)return {ok:false,status:403};
  if(url.endsWith("/graphql")) {const body=JSON.parse(options.body);assert.ok(!body.query.includes("mutation"));const second=body.variables.cursor;return {ok:true,json:async()=>({data:{repository:{pullRequest:{...pr,reviewThreads:{nodes:second?[]:[thread],pageInfo:{hasNextPage:!second,endCursor:second?null:"next"}}}}}})};}
  assert.equal(options.method,"GET");return {ok:true,json:async()=>({status:"ahead",files:[],commits:[],total_commits:0})};
 });
 const jobs=[{id:1,repository:"org/repo",number:1,head:"abc",result:{summaryURL:"https://github.com/org/repo/pull/1"}}];
 await c.collect(jobs,1e9);await c.collect(jobs,1e9+1e6);
 const dataset=path.join(dir,"benchmark","dataset");const file=fs.readdirSync(dataset).find(x=>x.endsWith("jsonl"));assert.equal(fs.readFileSync(path.join(dataset,file),"utf8").trim().split("\n").map(JSON.parse).filter(r=>r.kind==="finding_feedback").length,1);
 failure=true;const state=await c.collect(jobs,1e9+2e6);assert.equal(state.pulls["org/repo#1"].error,"GitHub HTTP 403");
});
