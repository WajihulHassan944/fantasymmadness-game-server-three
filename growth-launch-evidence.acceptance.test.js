'use strict';
// Evidence-aware staging readiness regression: synthetic CI success cannot be
// misrepresented as verified external integration or permission to launch.
const assert=require('node:assert/strict');
const {reviewEvidence,REQUIRED}=require('./growth-stage13-evidence-ledger');
const {launchGate}=require('./growth-final-three-gates');
const {auditLaunchIntegration}=require('./growth-stage12-integration-audit');
const empty=reviewEvidence([]);
assert.equal(empty.readyForSandboxIntegration,false);
assert.deepEqual(empty.missing,REQUIRED);
assert.equal(empty.realDeliveryPermitted,false);
const date='2026-10-30T12:00:00Z';
const records=REQUIRED.map(kind=>({kind,status:'verified',evidenceId:'synthetic-'+kind,verifiedBy:'synthetic-ci',verifiedAt:date,account:'contact@fantasymmadnesscom.com',productionShared:false,realExternalDelivery:false}));
assert.equal(reviewEvidence(records).readyForSandboxIntegration,true);
for(const kind of REQUIRED){
 assert.equal(reviewEvidence(records.filter(x=>x.kind!==kind)).readyForSandboxIntegration,false,kind);
}
assert.equal(reviewEvidence(records.map(x=>x.kind==='isolated_database'?{...x,productionShared:true}:x)).readyForSandboxIntegration,false);
assert.equal(reviewEvidence(records.map(x=>x.kind==='sandbox_mail'?{...x,realExternalDelivery:true}:x)).readyForSandboxIntegration,false);
assert.equal(launchGate({serviceReceipts:[],conversionVerified:true,securityReview:true,rollbackRehearsed:true,ownerApproved:true,monitoringVerified:true}).ready,false);
assert.equal(launchGate({serviceReceipts:[{ok:true,receipt:{sandbox:true}}],conversionVerified:true,securityReview:true,rollbackRehearsed:true,ownerApproved:false,monitoringVerified:true}).ready,false);
const audit=auditLaunchIntegration({});
assert.equal(audit.readyForSandboxTest,false);
assert.equal(audit.realDeliveryPermitted,false);
console.log('PASS evidence-aware launch gate: external sandbox, owner approval, isolation and rollback remain mandatory; no production changes');
