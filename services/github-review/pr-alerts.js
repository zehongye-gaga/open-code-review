// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const copy=require("./pr-alerts.zh-CN.json");
const values=v=>Array.isArray(v)?v:Object.values(v||{});
const clean=v=>String(v||"unknown").replace(/(?:github_pat_|gh[pousr]_|goclaw_)[A-Za-z0-9_.-]+/g,"[REDACTED]").replace(/Bearer\s+[^\s]+/gi,"Bearer [REDACTED]").replace(/https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[^\s]+/g,"[WEBHOOK REDACTED]").slice(0,1200);
function events(state, notifyBlocking=false) {
 const rows=[],covered=new Set(),jobs=new Map(values(state.jobs).map(j=>[String(j.id),j]));
 for(const j of jobs.values()) {
  const blocked=j.state==="complete" && j.result?.blocking>0;
  if(j.state!=="failed" && !(blocked && notifyBlocking))continue;
  covered.add(String(j.id));rows.push({key:`job:${j.id}:${j.attempt}:${j.startedAt||j.createdAt}:${j.state}`,repository:j.repository,number:j.number,head:j.head,
   type:blocked?"blocked":"failed",reason:blocked?`${j.result.blocking} blocking finding(s)`:j.error,
   time:j.updatedAt,jobId:j.id,attempt:j.attempt,budget:j.retryBudget??j.settings?.options?.budget,
   retries:j.budgetRetries?.length||0,route:j.requestedBy||"default",link:j.result?.summaryURL});
 }
 for(const [kind,items] of [["ci",values(state.ciReceipts)],["webhook",values(state.deliveries)]])for(const e of items){
  if(e.state!=="failed" || (e.jobId && covered.has(String(e.jobId))))continue;
  const j=jobs.get(String(e.jobId));if(j && ["queued","running"].includes(j.state))continue;
  if(e.jobId)covered.add(String(e.jobId));
  rows.push({key:e.jobId?`job:${e.jobId}:${j?.attempt}:${j?.startedAt||j?.createdAt}:failed`:`${kind}:${e.request_id||e.id}:${e.createdAt}`,
   repository:e.repository,number:e.pull_number||e.number||j?.number,head:e.head_sha||e.head||j?.head,type:"failed",
   reason:e.reason||e.error||e.lastError||j?.error,time:e.finishedAt||e.updatedAt||e.createdAt,jobId:e.jobId,
   attempt:j?.attempt||e.dispatchAttempts||e.attempts,budget:j?.retryBudget??j?.settings?.options?.budget,
   retries:j?.budgetRetries?.length||0,route:e.dispatchMethod||e.route||kind});
 }
 return rows.filter(r=>/^[\w.-]+\/[\w.-]+$/.test(r.repository||"") && Number.isSafeInteger(r.number) && r.number>0);
}
function message(e, now=Date.now()) {
 const timestamp=typeof e.time==="number"?e.time:Date.parse(e.time);
 const when=Number.isFinite(timestamp)?new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",dateStyle:"short",timeStyle:"medium",hour12:false}).format(new Date(timestamp)):copy.unknown;
 const reason=clean(e.reason);
 return [e.type==="blocked"?copy.blocked:copy.failed,`${copy.repository}: ${e.repository}`,`PR: https://github.com/${e.repository}/pull/${e.number}`,
  `Commit: ${e.head||copy.unknown}`,`${copy.time}: ${when} (UTC+8)`,`${copy.reason}: ${copy.reasons[e.reason]||reason}`,
  `${copy.rawReason}: ${reason}`,`${copy.job}: ${e.jobId||copy.unknown}`,`${copy.attempt}: ${e.attempt??0}; ${copy.retries}: ${e.retries??0}`,
  `${copy.budget}: ${e.budget??copy.unknown}`,`${copy.route}: ${e.route||copy.unknown}`,
  `${copy.notice}: ${new Date(now).toISOString()}`,`${copy.event}: ${crypto.createHash("sha256").update(e.key).digest("hex").slice(0,16)}`].join("\n");
}
class Alerts {
 constructor(config,request=fetch){this.config=config;this.request=request;this.file=path.join(config.directory,"alerts.json");
  try{this.state=JSON.parse(fs.readFileSync(this.file,"utf8"));}catch(e){if(e.code!=="ENOENT")throw e;this.state=null;}}
 save(){fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});fs.writeFileSync(this.file+".tmp",JSON.stringify(this.state),{mode:0o600});fs.renameSync(this.file+".tmp",this.file);}
 async send(text){const url=new URL(fs.readFileSync(this.config.webhookFile,"utf8").trim());
  if(url.origin!=="https://open.feishu.cn"||!/^\/open-apis\/bot\/v2\/hook\/[a-f0-9-]+$/.test(url.pathname)||url.search||url.hash)throw Error("Invalid alert destination");
  const r=await this.request(url,{method:"POST",redirect:"error",signal:AbortSignal.timeout(10000),headers:{"content-type":"application/json"},body:JSON.stringify({msg_type:"text",content:{text}})});
  if(!r.ok)throw Error(`Feishu HTTP ${r.status}`);const b=await r.json();if((b.code??b.StatusCode)!==0)throw Error("Feishu rejected notification");
 }
 async collect(source,now=Date.now()){
  const current=events(source,this.config.notifyBlocking===true),map=new Map(current.map(e=>[e.key,e]));
  if(!this.state){this.state={initializedAt:now,seen:Object.fromEntries(current.map(e=>[e.key,{baseline:true,at:now}])),pending:{}};this.save();return {baseline:current.length,sent:0};}
  for(const e of current)if(!this.state.seen[e.key]&&!this.state.pending[e.key])this.state.pending[e.key]={attempts:0,nextAt:0};
  for(const key of Object.keys(this.state.pending))if(!map.has(key)){delete this.state.pending[key];this.state.seen[key]={suppressed:true,at:now};}
  this.save();let sent=0,failed=0,processed=0;
  for(const [key,p] of Object.entries(this.state.pending)){
   if(p.nextAt>now||processed>=5)continue;processed++;
   try{await this.send(message(map.get(key),now));this.state.seen[key]={sentAt:now};delete this.state.pending[key];sent++;}
   catch{p.attempts++;p.nextAt=now+Math.min(1800000,60000*2**Math.min(p.attempts-1,5));p.lastErrorAt=now;failed++;}
   this.save();
  }
  this.state.lastCheckedAt=now;this.save();return {sent,failed,pending:Object.keys(this.state.pending).length};
 }
}
module.exports={Alerts,events,message};
if(require.main===module){const config=JSON.parse(fs.readFileSync(process.argv[2]));const a=new Alerts(config);
 (process.argv.includes("--test")?a.send(copy.test).then(()=>({test:"delivered"})):a.collect(JSON.parse(fs.readFileSync(config.stateFile))))
 .then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error("PR notification collection failed");process.exitCode=1;});}
