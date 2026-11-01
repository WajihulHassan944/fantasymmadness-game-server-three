'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runScheduledSandboxCampaign}=require('./growth-scheduled-campaign-pipeline');
const {planWorkstreams}=require('./growth-global-workstreams');
test('workstream failure blocks all sandbox sends while preserving report',async()=>{
 let sends=0;
 const collection={createIndex:async()=>{},updateOne:async()=>{}};
 const draft={id:'d1',recipient:'tester@localhost',subject:'Test',text:'Synthetic',status:'approved',ownerApproved:true,sendPermitted:true};
 const r=await runScheduledSandboxCampaign({collection,testMode:true,
  workstreams:planWorkstreams().slice(0,1),adapters:{audience:async()=>{throw Error('research offline')}},
  transport:{sendMail:async()=>{sends++;return {messageId:'local'}}},approvedDrafts:[draft]});
 assert.equal(r.execution.errors.length,1);assert.equal(r.receipts.length,0);
 assert.equal(r.blocked[0].reason,'workstream_execution_not_verified');assert.equal(sends,0);
 assert.equal(r.realMessagesSent,0);
});
