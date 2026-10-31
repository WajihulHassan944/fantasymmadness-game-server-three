'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runScheduledSandboxCampaign}=require('./growth-scheduled-campaign-pipeline');
const {planWorkstreams}=require('./growth-global-workstreams');
test('duplicate draft IDs in same batch are never delivered twice',async()=>{
 let sent=0;
 const collection={createIndex:async()=>{},updateOne:async()=>{}};
 const draft={id:'same',genre:'boxing',category:'media',recipient:'tester@localhost',subject:'Test',text:'Synthetic',status:'approved',ownerApproved:true,sendPermitted:true};
 const r=await runScheduledSandboxCampaign({collection,testMode:true,workstreams:planWorkstreams().slice(0,1),adapters:{audience:async()=>({ok:true})},
  transport:{sendMail:async()=>{sent++;return {messageId:'local-'+sent}}},
  approvedDrafts:[draft,{...draft}]});
 assert.equal(sent,1);assert.equal(r.receipts.length,1);assert.equal(r.blocked.length,1);
 assert.equal(r.blocked[0].reason,'invalid_or_duplicate_draft');
 assert.equal(r.realMessagesSent,0);
});
