// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

// SPDX-License-Identifier: Apache-2.0
"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { ResourceTrends, summarize } = require("./resource-trends.js");
const now = Date.parse("2026-10-28T08:00:00Z");
function row(offset, running, available = true) { return {sampled_at:new Date(now-offset).toISOString(),metrics:{cpu:10,memory:20},load:{available,running,queued:2,oldest_queued_age_seconds:30,last_24h:{first_attempt_queue_seconds:{p95:100}}}}; }
test("grouping preserves raw samples and never treats unavailable concurrency as zero",()=>{
 const result=summarize([row(60000,2),row(120000,2),row(180000,0),row(240000,0,false),row(7200000,8),null],now-3600000,now);
 assert.equal(result.samples,4);assert.deepEqual(result.groups.map(g=>[g.running,g.samples]),[[0,1],[2,2]]);
 assert.equal(result.groups[1].wait.max,30);assert.equal(result.points[0].running,null);assert.equal(result.groups[1].cpu.mean,10);
});
test("missing resources remain null and stale samples are identified",()=>{
 const result=summarize([{sampled_at:new Date(now-300000).toISOString(),load:{available:true,running:1}}],now-3600000,now);
 assert.equal(result.groups[0].cpu.mean,null);assert.equal(result.groups[0].wait.max,null);assert.equal(result.stale,true);
});
test("file reader bounds time ranges, tolerates incomplete rows and refreshes cache",t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'resources-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const reader=new ResourceTrends(dir);const file=path.join(dir,'2026-10-28.jsonl');
 fs.writeFileSync(file,JSON.stringify(row(60000,3))+'\n{"broken":');
 const first=reader.snapshot(24,now);assert.equal(first.samples,1);assert.equal(first.malformedRows,1);
 fs.appendFileSync(file,'\n'+JSON.stringify(row(0,4))+'\n');
 assert.equal(reader.snapshot(24,now+1000).samples,1);assert.equal(reader.snapshot(24,now+31000).samples,2);
 assert.throws(()=>reader.snapshot(10000,now),/Invalid period/);
});
