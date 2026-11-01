'use strict';
const assert=require('node:assert/strict');
const {reconcilePaidReferral}=require('./growth-payment-reconciliation');
const affiliate={id:'affiliate-1',status:'approved'};
const referral={affiliateId:'affiliate-1',playerId:'player-1',fightId:'fight-1'};
const entry={id:'entry-1',playerId:'player-1',fightId:'fight-1',status:'accepted',paid:true};
const payment={source:'server_verified',status:'settled',transactionId:'txn-1',entryId:'entry-1',playerId:'player-1',amountCents:500};
const args={affiliate,referral,entry,payment,existingCredit:false};
assert.equal(reconcilePaidReferral(args).ok,true);
assert.equal(reconcilePaidReferral(args).credit.id,'paid-entry:entry-1');
for(const [name,patch] of [
 ['client analytics event',{payment:{...payment,source:'public_analytics'}}],
 ['unsettled payment',{payment:{...payment,status:'pending'}}],
 ['wrong payment entry',{payment:{...payment,entryId:'other'}}],
 ['missing transaction',{payment:{...payment,transactionId:''}}],
 ['wrong player',{entry:{...entry,playerId:'other'}}],
 ['unpaid entry',{entry:{...entry,paid:false}}],
 ['unaccepted entry',{entry:{...entry,status:'draft'}}],
 ['mismatched referral',{referral:{...referral,affiliateId:'other'}}],
 ['duplicate credit',{existingCredit:true}],
 ['unapproved affiliate',{affiliate:{...affiliate,status:'pending'}}]
])assert.equal(reconcilePaidReferral({...args,...patch}).ok,false,name);
console.log('PASS fail-closed payment reconciliation: verified settled transaction, valid entry and referral; ten rejection scenarios');
