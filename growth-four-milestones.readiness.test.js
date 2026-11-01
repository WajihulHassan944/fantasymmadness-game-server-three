'use strict';
// Four launch gates: durable scheduling, provider readiness, trusted conversions,
// and security/rollback. Explicitly fail closed on missing live integrations.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {createStore}=require('./growth-unattended-store');
const {stageApprovedDrafts,executeStage}=require('./growth-staging-execution');
const {safeReport}=require('./growth-unattended-controller');
const checks=[];
function check(name,passed,detail){checks.push({name,passed,detail});}
assert.throws(()=>createStore(null,{testMode:false}),/isolated test collection/);
check('persistent_staging_test',true,'MongoDB integration runs separately in CI');
const approval=stageApprovedDrafts([{id:'x',kind:'pr',status:'approved',ownerApproved:true},{id:'y',kind:'pr',status:'approved',ownerApproved:false}],Date.UTC(2026,10,1));
assert.equal(approval.jobs.length,1);
assert.equal(approval.blocked.length,1);
const executed=executeStage(approval.jobs,Date.UTC(2026,10,1));
assert.equal(executed.externalActions,0);
check('provider_integration',false,'Only public research GET probes verified; no authorized email/social sandbox send receipts');
const report=safeReport([{type:'signup',verified:false},{type:'paid_entry',verified:false}]);
assert.equal(report.paidEntries,0);
check('conversion_attribution',false,'No authoritative live settled payment and signup-to-entry reconciliation');
const audit=fs.readFileSync(require.resolve('./growth-production-readiness.audit.test.js'),'utf8');
assert.match(audit,/productionReady/);
check('security_launch',false,'No production approval, rollback rehearsal, credential audit or real service delivery verification');
const ready=checks.every(x=>x.passed);
assert.equal(ready,false,'must not declare production ready');
console.log('FOUR MILESTONE GATE AUDIT '+JSON.stringify({ready,checks,externalActions:0}));
