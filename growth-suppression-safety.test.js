'use strict';
// Safety regression: opt-outs, replies, bounces and duplicate contacts never
// enter follow-up drafts. Entirely offline and synthetic.
const assert=require('node:assert/strict');
const {buildQueue}=require('./growth-prospect-queue');
const {nextFollowup}=require('./growth-followup-reporting');
const {followupAllowed}=require('./growth-unattended-controller');
const now=Date.parse('2026-11-10T12:00:00Z');
const base={lastSentAt:'2026-11-01T12:00:00Z',deliveryVerified:true,ownerApproved:true,followupCount:0};
for(const state of [{optedOut:true},{replied:true},{bounced:true},{blocked:true}]){
 const decision=nextFollowup({...base,...state},now);
 assert.equal(decision.action,'stop',JSON.stringify(state));
}
assert.equal(nextFollowup({...base,ownerApproved:false},now).action,'hold');
assert.equal(nextFollowup({...base,deliveryVerified:false},now).action,'hold');
assert.equal(nextFollowup({...base,followupCount:2},now).action,'stop');
const due=nextFollowup(base,now);
assert.equal(due.action,'draft_followup');
assert.equal(due.sendPermitted,false);
for(const state of [{optedOut:true},{replied:true},{declined:true},{consent:false}]){
 assert.equal(followupAllowed({consent:true,status:'contacted',...state}),false);
}
const q=buildQueue([
 {id:'1',contact:'Test@Example.invalid',category:'affiliate'},
 {id:'2',contact:'test@example.invalid',category:'affiliate'},
 {id:'3',contact:'blocked@example.invalid',category:'media',optedOut:true},
 {id:'4',contact:'real@example.com',category:'media'}
],{campaignId:'safety-regression',mode:'DRAFT_ONLY'});
assert.equal(q.length,1);
assert.equal(q[0].contact,'test@example.invalid');
assert.equal(q[0].sent,false);
console.log('PASS opt-out and reply suppression, owner approval, max follow-ups, dedupe, draft-only, no external sends');
