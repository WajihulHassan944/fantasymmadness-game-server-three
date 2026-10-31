'use strict';
const assert=require('node:assert/strict');
const {stageApprovedDrafts,executeStage,stageFollowup,stageReport}=require('./growth-staging-execution');
const now=Date.UTC(2026,10,1,12);
const {jobs,blocked}=stageApprovedDrafts([
 {id:'campaign-1',kind:'campaign',status:'approved',ownerApproved:true},
 {id:'pr-1',kind:'pr',status:'approved',ownerApproved:true},
 {id:'affiliate-1',kind:'affiliate',status:'needs_review',ownerApproved:false},
 {id:'pr-2',kind:'pr',status:'approved',ownerApproved:false}
],now);
assert.equal(jobs.length,2);
assert.equal(blocked.length,2);
const execution=executeStage(jobs,now);
assert.equal(execution.completed.length,2);
assert.ok(execution.completed.every(j=>j.state==='completed'));
assert.ok(execution.receipts.every(r=>r.mode==='SIMULATED_ONLY'&&!r.delivered&&!r.providerMessageId));
assert.equal(execution.externalActions,0);
assert.equal(executeStage(execution.completed,now+60000).completed.length,0);
assert.equal(stageFollowup({id:'a',consent:false,status:'contacted'},now).blocked,true);
assert.equal(stageFollowup({id:'b',consent:true,status:'contacted',optedOut:true},now).blocked,true);
assert.equal(stageFollowup({id:'c',consent:true,status:'contacted'},now).blocked,false);
const report=stageReport([{type:'visit',verified:true},{type:'paid_entry',verified:false}]);
assert.equal(report.visits,1);
assert.equal(report.paidEntries,0);
assert.equal(report.realDeliveries,0);
console.log('PASS staging execution: approval gates, simulated receipts, duplicate prevention, opt-out, verified reporting, zero external actions');
