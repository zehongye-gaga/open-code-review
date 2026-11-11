// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {jobOutcome,receiptOutcome}=require("./outcome.js");
const skip={state:"complete",progress:{skipped:true,selected:0},result:{skipped:true,findings:0,blocking:0,summaryURL:"https://example.test/review"}};
test("one result contract separates execution, findings, publication and lifecycle",()=>{
 const cases=[
  [{state:"queued"},"queued","pending",false],
  [{state:"queued",attempt:1},"retrying","pending",false],
  [{state:"running"},"running","pending",false],
  [skip,"skipped","success",false],
  [{state:"skipped",result:{reviewed:false}},"skipped","success",false],
  [{state:"complete",progress:{complete:true},result:{blocking:2}},"blocked","failure",false],
  [{state:"complete",progress:{complete:true},result:{blocking:0}},"complete","success",false],
  [{state:"failed",failurePhase:"publication",error:"GitHub 403"},"publication_failed","failure",true],
  [{state:"failed",failurePhase:"review",error:"model timeout"},"execution_failed","failure",true],
  [{state:"cancelled"},"cancelled","failure",false],
  [{state:"checkpointed"},"superseded","failure",false],
  [{...skip,result:{}},"execution_failed","failure",true],
 ];
 for(const [job,kind,status,alert] of cases){const result=jobOutcome(job);assert.equal(result.kind,kind);assert.equal(result.commitStatus,status);assert.equal(result.alert,alert);}
});
test("transport failure is not allowed to rewrite verified execution evidence",()=>{
 const r={state:"failed",reason:"n8n_tracking_stalled"};
 assert.equal(receiptOutcome(r,skip).kind,"skipped");
 assert.equal(receiptOutcome(r,{state:"running"}).alert,false);
 assert.equal(receiptOutcome(r,null).alert,true);
 assert.equal(receiptOutcome({state:"failed",reason:"review_deadline_exceeded"},{state:"cancelled"}).alert,true);
});

test("explicit snapshot cancellation and access failures are not hidden by older completion",()=>{
 assert.equal(receiptOutcome({state:"superseded",reason:"pr_snapshot_changed"},skip).kind,"superseded");
 assert.equal(receiptOutcome({state:"failed",reason:"repository_access_failed"},skip).alert,true);
});

test("unenrolled repository receipts are successful policy skips without a review verdict",()=>{
 const receipt={state:"skipped",reason:"repository_not_enabled"};
 const result=receiptOutcome(receipt,null);
 assert.equal(result.kind,"skipped");assert.equal(result.commitStatus,"success");assert.equal(result.alert,false);
 assert.equal(result.reason,"repository_not_enabled");
 assert.equal(receiptOutcome(receipt,{state:"complete",progress:{complete:true},result:{blocking:1}}).kind,"blocked");
});
test("pending admission and failed verification are distinct from an older job result",()=>{
 const receipt={state:"failed",reason:"admission_retries_exhausted",pendingAdmission:{kind:"reopen",generation:2}};
 const pending=receiptOutcome(receipt,skip);assert.equal(pending.kind,"accepted");assert.equal(pending.terminal,false);assert.equal(pending.alert,false);
 delete receipt.pendingAdmission;receipt.lastAdmission={state:"failed",generation:2};
 assert.equal(receiptOutcome(receipt,skip).kind,"dispatch_failed");assert.equal(receiptOutcome(receipt,skip).alert,true);
});
