'use strict';
// Synthetic-only paid-player attribution and campaign reporting acceptance.
const assert=require('node:assert/strict');
const {createRecruit,verifyPaidEntry,report}=require('./growth-affiliate-attribution');
const {reconcilePaidReferral}=require('./growth-payment-reconciliation');
const {safeReport}=require('./growth-unattended-controller');
const affiliate=createRecruit({id:'affiliate-test',name:'Synthetic Affiliate',consent:true,approved:true});
const affiliates=new Map([[affiliate.id,affiliate]]);
const entries=new Map();
const paid={type:'paid_entry',verified:true,paymentStatus:'settled',entryId:'entry-1',playerId:'player-1',fightId:'fight-1',affiliateId:affiliate.id,referralAffiliateId:affiliate.id,amountCents:500};
assert.equal(verifyPaidEntry({...paid,verified:false},{affiliates,entries}).credited,false);
assert.equal(verifyPaidEntry({...paid,paymentStatus:'pending'},{affiliates,entries}).credited,false);
assert.equal(verifyPaidEntry({...paid,referralAffiliateId:'other'},{affiliates,entries}).credited,false);
assert.equal(verifyPaidEntry(paid,{affiliates,entries}).credited,true);
assert.equal(verifyPaidEntry(paid,{affiliates,entries}).reason,'duplicate_entry');
assert.deepEqual(report(entries)[affiliate.id],{paidEntries:1,revenueCents:500});
const referral={affiliateId:affiliate.id,playerId:'player-1',fightId:'fight-1'};
const entry={id:'entry-1',playerId:'player-1',fightId:'fight-1',status:'accepted',paid:true};
const payment={source:'server_verified',status:'settled',transactionId:'tx-test-1',entryId:'entry-1',playerId:'player-1',amountCents:500};
const valid=reconcilePaidReferral({affiliate,referral,entry,payment,existingCredit:false});
assert.equal(valid.ok,true);
assert.equal(valid.credit.amountCents,500);
for(const bad of [{payment:{...payment,status:'pending'}},{payment:{...payment,source:'browser_analytics'}},{entry:{...entry,paid:false}},{existingCredit:true},{referral:{...referral,affiliateId:'other'}}]){
 const result=reconcilePaidReferral({affiliate,referral,entry,payment,existingCredit:false,...bad});
 assert.equal(result.ok,false,JSON.stringify(bad));
}
const metrics=safeReport([{type:'visit',verified:true},{type:'signup',verified:true},{type:'paid_entry',verified:true},{type:'paid_entry',verified:false},{type:'paid_entry',verified:true}]);
assert.deepEqual(metrics,{visits:1,signups:1,paidEntries:2,unverifiedExcluded:1});
console.log('PASS synthetic attribution: settled payments only, referral matching, duplicate prevention, verified event reporting; live payments 0');
