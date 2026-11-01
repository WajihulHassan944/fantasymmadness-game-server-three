'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runScheduledSandboxCampaign}=require('./growth-scheduled-campaign-pipeline');
const {planWorkstreams}=require('./growth-global-workstreams');
test('unapproved drafts never consume durable claim, later approval can deliver',async()=>{
 const claims=new Set();let sends=0;
 const collection={createIndex:async()=>{},updateOne:async()=>({upsertedCount:1})};
 const deliveryClaimsCollection={createIndex:async()=>{},updateOne:async(f,u,o)=>{
  if(o?.upsert){if(claims.has(f.draftId))return {upsertedCount:0};claims.add(f.draftId);return {upsertedCount:1};}
  return {modifiedCount:1};
 }};
 const draft={id:'approval-later',genre:'boxing',category:'media',recipient:'tester@localhost',subject:'Test',text:'Synthetic',status:'pending',ownerApproved:false,sendPermitted:false};
 const opts={collection,deliveryClaimsCollection,testMode:true,workstreams:planWorkstreams().slice(0,1),adapters:{audience:async()=>({ok:true})},transport:{sendMail:async()=>({messageId:'local-'+(++sends)})}};
 const blocked=await runScheduledSandboxCampaign({...opts,approvedDrafts:[draft]});
 assert.equal(blocked.blocked[0].reason,'owner_approval_required');assert.equal(claims.size,0);
 const approved=await runScheduledSandboxCampaign({...opts,approvedDrafts:[{...draft,status:'approved',ownerApproved:true,sendPermitted:true}]});
 assert.equal(approved.receipts.length,1);assert.equal(sends,1);assert.equal(claims.size,1);
});
