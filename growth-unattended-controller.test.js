'use strict';
const assert = require('node:assert/strict');
const c = require('./growth-unattended-controller');
const t = Date.parse('2026-11-01T12:00:00Z');
let count = 0;
function test(name, fn) { fn(); console.log('ok - ' + name); count++; }
test('only due jobs claimed and duplicate IDs skipped', () => {
 const jobs = [c.makeJob({id:'a',type:'discover',dueAt:new Date(t-1).toISOString()}),
 c.makeJob({id:'a',type:'discover',dueAt:new Date(t-1).toISOString()}),
 c.makeJob({id:'b',type:'prepare_pr',dueAt:new Date(t+1000).toISOString()})];
 const claimed=c.claimDue(jobs,t); assert.equal(claimed.length,1); assert.equal(claimed[0].attempts,1);
});
test('retry backoff and terminal failure', () => {
 let j=c.claimDue([c.makeJob({id:'a',type:'prepare_campaign',dueAt:new Date(t).toISOString()})],t)[0];
 j=c.settle(j,{success:false,error:'temporary',now:t}); assert.equal(j.state,'retry'); assert.equal(Date.parse(j.dueAt),t+60000);
 j=c.claimDue([j],t+60000)[0]; j=c.settle(j,{success:false,now:t+60000}); assert.equal(Date.parse(j.dueAt),t+180000);
 j=c.claimDue([j],t+180000)[0]; j=c.settle(j,{success:false,now:t+180000}); assert.equal(j.state,'failed');
});
test('success completes and cannot settle twice',()=>{
 let j=c.claimDue([c.makeJob({id:'ok',type:'aggregate_report',dueAt:new Date(t).toISOString()})],t)[0];
 j=c.settle(j,{success:true,now:t}); assert.equal(j.state,'completed'); assert.throws(()=>c.settle(j,{success:true,now:t}));
});
test('followups require consent and stop on reply, decline or opt-out',()=>{
 const base={consent:true,status:'contacted',replied:false,optedOut:false,declined:false};
 assert.equal(c.followupAllowed(base),true);
 for(const key of ['replied','optedOut','declined'])assert.equal(c.followupAllowed({...base,[key]:true}),false);
 assert.equal(c.followupAllowed({...base,consent:false}),false);
});
test('reports exclude unverified events',()=>{
 assert.deepEqual(c.safeReport([{type:'visit',verified:true},{type:'signup',verified:false},{type:'paid_entry',verified:true}]),{visits:1,signups:0,paidEntries:1,unverifiedExcluded:1});
});
console.log(count+' unattended controller offline tests passed');
