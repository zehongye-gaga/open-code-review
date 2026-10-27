// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {recordResumeFallback,captureRecovery}=require('./resume-recovery.js');
test('recovery preserves attribution, limits full reruns, and counts each reported session once',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'resume-recovery-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 let saves=0;const service={state:{save(){saves++;}},log(){}};
 const job={id:1,head:'head',base:'base',requestedBy:'agent',settings:{options:{budget:500000}},retryBudget:0,progress:{sessionId:'old',directory:'previous'}};
 recordResumeFallback(service,job,'native_resume_rejected');assert.equal(saves,1);
 assert.equal(recordResumeFallback(service,job,'again'),job.resumeFallbacks[0]);assert.equal(saves,1);
 job.resumeFallbacks[0].state='started';
 assert.throws(()=>recordResumeFallback(service,job,'again'),e=>e.code==='RESUME_RECOVERY_EXHAUSTED');
 assert.equal(job.resumeFallbacks[0].extraTokens,null);
 fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({session_id:'new',summary:{total_tokens:120,input_tokens:100,output_tokens:20}}));
 captureRecovery(job,directory);captureRecovery(job,directory);
 assert.equal(job.resumeFallbacks[0].extraTokens,120);assert.equal(job.resumeFallbacks[0].requestedBudget,500000);
 assert.equal(job.resumeFallbacks[0].effectiveBudget,0);assert.equal(job.resumeFallbacks[0].previousSessionId,'old');
});
