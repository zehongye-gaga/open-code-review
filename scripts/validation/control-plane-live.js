// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),crypto=require('crypto');
const root=path.resolve(__dirname,'../..'),prInfo=JSON.parse(fs.readFileSync(process.argv[3]));
const output=path.resolve(process.argv[4]);
if(process.argv[5]!=='--live-test')throw Error('Explicit --live-test is required');
fs.mkdirSync(output,{recursive:false,mode:0o700});
const {ReviewService}=require(root+'/services/github-review/service.js');
const {OrgCI}=require(root+'/services/github-review/org-ci.js');
const {createGitHub}=require(root+'/services/github-review/github.js');
const {events}=require(root+'/services/github-review/pr-alerts.js');
const liveConfig=JSON.parse(fs.readFileSync(process.argv[2]));
const github=createGitHub({githubAuth:liveConfig.githubAuth,tokenFile:liveConfig.githubTokenFile});
const repo='lexmount/ocr-test-public',coords={owner:'lexmount',repo:'OCR-Test-Public',pull_number:prInfo.number};
const records=[];
(async()=>{
 const {data:pr}=await github.rest.pulls.get(coords);
 assert.equal(pr.head.sha,prInfo.head);assert.equal(pr.base.ref,prInfo.baseRef);
 if(!pr.base.ref.startsWith('test/control-plane-base-'))throw Error('Only the isolated regression branch is allowed');
 const available=['skip','pass','blocked','publication-retry','publication-failed','execution-failed','tracker-lost','cancelled','budget-resume','resume-missing','native-publisher'];
 const cases=process.argv[6]?process.argv[6].split(','):available;
 if(cases.some(name=>!available.includes(name)))throw Error('Unknown regression case');
 for(const name of cases){
  const dir=path.join(output,name);
  if(fs.existsSync(dir))throw Error('Refusing to repeat test with existing state '+name);
  let runs=0,pubs=0;const budgets=[],resumes=[];
  const config={stateDirectory:dir,binary:liveConfig.binary,provider:liveConfig.provider,model:liveConfig.model,
   repositories:[{name:repo,baseBranches:[prInfo.baseRef]}],statusContext:'ocr-control-test/'+name,maxAttempts:2,publicationMaxAttempts:2,retrySeconds:1,
   infrastructure:{allowUnlimitedBudget:true,profiles:{standard:{effort:'medium',budget:500000,concurrency:2,timeout:15}},budgetRetry:{enabled:true,mode:'unlimited',maxRetries:1,multiplier:2},orgCI:{enabled:true,totalSeconds:7200,heartbeatSeconds:300}}};
  const service=new ReviewService({config,github,log:()=>{},
   run:async({directory,budget,resume,requireResume})=>{
    runs++;budgets.push(budget);resumes.push(resume||null);if(runs>1&&name==='budget-resume'){assert.ok(resume);assert.equal(requireResume,true);assert.equal(budget,0);}
    if(name==='execution-failed')throw Object.assign(Error('Injected model failure; test only'),{retryable:false});
    const metadata=JSON.parse(fs.readFileSync(path.join(directory,'metadata.json'))),id=crypto.randomUUID(),item={item_id:'test-item'};
    const skipped=name==='skip',exhausted=['budget-resume','resume-missing'].includes(name)&&runs===1,state=skipped?'skipped':exhausted?'partial':'complete';
    const report={status:state,session_id:id,comments:name==='native-publisher'?[{path:'review-state-demo.py',start_line:3,end_line:3,severity:'high',title:'[REGRESSION FIXTURE] Empty input',body:'Deterministic test finding: empty input divides by zero.'}]:[],summary:{budget_exceeded:exhausted},manifest:{schema_version:'ocr.run-manifest/v1',operation:'review',run_id:id,terminal_state:state,
      input:{mode:'range',resolved_base:metadata.range.from,resolved_head:metadata.head},coverage:{selected:skipped?[]:[item],completed:skipped||exhausted?[]:[item],reused:[],failed:exhausted?[item]:[],waived:[]}}};
    fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(report));fs.writeFileSync(path.join(directory,'exit-code.json'),'0');
   },
   publish:async(args)=>{
    pubs++;if(name==='publication-failed'||name==='publication-retry'&&pubs===1)throw Error('Injected GitHub publication failure; test only');
    if(name==='native-publisher')return require(root+'/services/github-review/review.js').publishReview(args);
    const skipped=name==='skip',blocked=name==='blocked';
    const body=`**State contract test: ${name}**\n\n${skipped?'Skipped: no reviewable items.':blocked?'Completed with 1 simulated blocking finding.':'Review completed without findings.'}\n\nTest fixture only; no model was called. This is not a production review conclusion.`;
    const comments=blocked?[{path:'review-state-demo.py',line:3,side:'RIGHT',body:'[TEST FIXTURE] Empty input divides by zero. Simulated finding for state validation only.'}]:[];
    const {data:r}=await github.rest.pulls.createReview({...coords,commit_id:pr.head.sha,event:'COMMENT',body,comments});
    return {skipped,comments:blocked?[{severity:'high'}]:[],summaryURL:r.html_url};
   }});
  const ci=service.orgCI=new OrgCI(service);
  const fields={base_ref:pr.base.ref,base_sha:pr.base.sha,head_sha:pr.head.sha,pull_number:pr.number,repository:repo};
  const input={schema:'ocr-ci/v1',...fields,request_id:'ocr-ci-'+crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex')};
  await ci.submit(input,'direct');
  service.githubEvents=new(require(root+'/services/github-review/events.js').GitHubEvents)(service);
  ci.receipts[input.request_id].heartbeatAt-=400000;await ci.watchdog();
  await service.githubEvents.tick();
  const job=service.state.data.jobs[0];assert.ok(job);
  // The second ingress must attach to the same job.
  await ci.submit(input,'agent');assert.equal(service.state.data.jobs.length,1);
  if(name==='cancelled'){job.state='cancelled';service.state.save();}
  else {
   if(name==='tracker-lost') {ci.receipts[input.request_id].heartbeatAt-=400000;await ci.watchdog();assert.equal(job.state,'queued');}
   await service.tick();
   if(['budget-resume','resume-missing'].includes(name)){
    assert.equal(job.retryBudget,0);assert.equal(job.settings.options.budget,500000);
    if(name==='resume-missing'){fs.unlinkSync(path.join(job.directory,'result.json'));job.progress.sessionId=null;}
    job.nextAt=0;await service.tick();
    if(name==='resume-missing'){assert.equal(runs,2);assert.equal(job.resumeFallbacks.length,1);assert.equal(job.resumeFallbacks[0].reason,'session_missing_or_incompatible');}
   }
   if(name==='publication-retry'||name==='publication-failed'){
    assert.equal(job.state,'queued');assert.equal(events(service.state.data).length,0);job.nextAt=0;await service.tick();assert.equal(runs,1);
   }
  }
  if(['skip','pass','blocked'].includes(name)){ci.receipts[input.request_id].heartbeatAt-=400000;ci.receipts[input.request_id].createdAt-=8000000;}
  const view=await ci.status(input);assert.equal(view.terminal,true);
  const expected=name==='skip'?'skipped':['blocked','native-publisher'].includes(name)?'blocked':name==='publication-failed'?'publication_failed':name==='execution-failed'?'execution_failed':name==='cancelled'?'cancelled':'complete';
  assert.equal(view.outcome,expected);
  assert.equal(events(service.state.data).length,['publication-failed','execution-failed'].includes(name)?1:0);
  await ci.submit(input,'direct');assert.equal(service.state.data.jobs.length,1);
  const {data:status}=await github.rest.repos.getCombinedStatusForRef({...coords,ref:pr.head.sha});
  const latest=status.statuses.find(s=>s.context===config.statusContext);assert.equal(latest.state,view.commit_status);
  records.push({case:name,outcome:view.outcome,status:latest.state,description:latest.description,nativeCalls:runs,publicationAttempts:pubs,jobs:service.state.data.jobs.length,alerts:events(service.state.data).length,budgets,resumes,budgetOverrides:job.budgetRetries||[],resumeRecoveries:job.resumeFallbacks||[],reviewURL:job.result?.summaryURL});
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({pr:prInfo.url,records},null,2));
  console.log(JSON.stringify(records.at(-1)));
 }
})().catch(e=>{console.error(e.stack);process.exitCode=1});
