'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runScheduledSandboxCampaign}=require('./growth-scheduled-campaign-pipeline');
const {planWorkstreams}=require('./growth-global-workstreams');
test('one failing sandbox SMTP delivery does not block other approved drafts',async()=>{
 let sent=0;
 const collection={createIndex:async()=>{},updateOne:async()=>({})};
 const draft=id=>({id,genre:'boxing',category:'media',recipient:'recipient@localhost',subject:'Test',text:'Synthetic',status:'approved',ownerApproved:true,sendPermitted:true});
 const result=await runScheduledSandboxCampaign({collection,testMode:true,clock:()=>new Date('2026-10-31T12:00:00Z'),
  workstreams:planWorkstreams().slice(0,1),adapters:{audience:async()=>({ok:true})},
  transport:{sendMail:async()=>{sent++;if(sent===1)throw Error('sandbox SMTP unavailable');return {messageId:'local-2'}}},
  approvedDrafts:[draft('first'),draft('second')]});
 assert.equal(result.execution.completed,1);
 assert.equal(result.blocked.length,1);
 assert.equal(result.blocked[0].reason,'sandbox_delivery_failed');
 assert.equal(result.receipts.length,1);
 assert.equal(result.report.sandboxReceipts,1);
 assert.equal(result.realMessagesSent,0);
});
