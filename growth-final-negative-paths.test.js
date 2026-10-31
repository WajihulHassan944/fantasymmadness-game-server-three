'use strict';
// Final isolated negative-path regression. Tests intentionally reject fake proof.
// No live integrations, sends, deployment, or production changes.
const assert=require('node:assert/strict');
const {deliveryReceipt,conversionProof,launchGate}=require('./growth-final-three-gates');
const {stageApprovedDrafts,stageFollowup,executeStage}=require('./growth-staging-execution');
const {safeReport}=require('./growth-unattended-controller');
const now=Date.UTC(2026,10,29);
const drafts=[
 {id:'unapproved-social',kind:'campaign',status:'approved',ownerApproved:false},
 {id:'approved-email',kind:'pr',status:'approved',ownerApproved:true}
];
const staged=stageApprovedDrafts(drafts,now);
assert.equal(staged.jobs.length,1);
assert.equal(staged.blocked.length,1);
const exec=executeStage(staged.jobs,now);
assert.equal(exec.externalActions,0);
assert.equal(exec.receipts[0].delivered,false);
assert.equal(deliveryReceipt({draft:{id:'approved-email',channel:'email'},approval:{draftId:'approved-email',ownerApproved:true},providerResult:{sandbox:false,accepted:true,messageId:'synthetic'}}).ok,false);
assert.equal(deliveryReceipt({draft:{id:'approved-email',channel:'email'},approval:{draftId:'wrong',ownerApproved:true},providerResult:{sandbox:true,accepted:true,messageId:'synthetic'}}).ok,false);
assert.equal(stageFollowup({id:'x',consent:true,status:'contacted',replied:true},now).blocked,true);
assert.equal(stageFollowup({id:'y',consent:true,status:'contacted',declined:true},now).blocked,true);
const affiliate={id:'a',status:'approved'},referral={affiliateId:'a',playerId:'p',fightId:'f'},entry={id:'e',playerId:'p',fightId:'f',status:'accepted',paid:true};
const signup={source:'server_verified',status:'created',playerId:'p'};
const payment={source:'server_verified',status:'settled',transactionId:'tx',entryId:'e',playerId:'p',amountCents:500};
assert.equal(conversionProof({signup,affiliate,referral,entry,payment}).ok,true);
assert.equal(conversionProof({signup,affiliate,referral,entry,payment:{...payment,source:'public_analytics'}}).ok,false);
assert.equal(conversionProof({signup,affiliate,referral,entry,payment,existingCredit:true}).ok,false);
assert.deepEqual(safeReport([{type:'paid_entry',verified:false},{type:'paid_entry',verified:true}]),{visits:0,signups:0,paidEntries:1,unverifiedExcluded:1});
assert.equal(launchGate({serviceReceipts:[],conversionVerified:true,securityReview:true,rollbackRehearsed:true,ownerApproved:true,monitoringVerified:true}).ready,false);
assert.equal(launchGate({serviceReceipts:[{ok:true,receipt:{sandbox:true}}],conversionVerified:true,securityReview:true,rollbackRehearsed:false,ownerApproved:true,monitoringVerified:true}).ready,false);
console.log('PASS final negative-path audit: approval, forged receipts, opt-outs, fake payments, duplicate credits, rollback gates; NO real integration claims');
