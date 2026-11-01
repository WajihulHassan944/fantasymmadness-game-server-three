'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runScheduledSandboxCampaign}=require('./growth-scheduled-campaign-pipeline');
const {planWorkstreams}=require('./growth-global-workstreams');
test('persistent delivery claims prevent repeat SMTP attempt in later run',async()=>{
 const attempted=new Map();let sends=0;
 const collection={createIndex:async()=>{},updateOne:async()=>({upsertedCount:1})};
 const deliveryClaimsCollection={createIndex:async()=>{},updateOne:async(filter,update,options)=>{
  if(options?.upsert){
   if(attempted.has(filter.draftId))return {upsertedCount:0};
   attempted.set(filter.draftId,update.$setOnInsert);return {upsertedCount:1};
  }
  attempted.set(filter.draftId,{...attempted.get(filter.draftId),...update.$set});return {modifiedCount:1};
 }};
 const draft={id:'same',genre:'boxing',category:'media',recipient:'tester@localhost',subject:'Test',text:'Synthetic',status:'approved',ownerApproved:true,sendPermitted:true};
 const opts={collection,deliveryClaimsCollection,testMode:true,workstreams:planWorkstreams().slice(0,1),adapters:{audience:async()=>({ok:true})},transport:{sendMail:async()=>({messageId:'local-'+(++sends)})},approvedDrafts:[draft]};
 const first=await runScheduledSandboxCampaign(opts);
 const second=await runScheduledSandboxCampaign(opts);
 assert.equal(first.receipts.length,1);assert.equal(second.receipts.length,0);
 assert.equal(second.blocked[0].reason,'already_attempted_in_prior_run');assert.equal(sends,1);
});

test('persistent delivery claims reject blank and non-string receipts',async()=>{
 const {createSandboxDeliveryClaims}=require('./growth-sandbox-delivery-claims');
 const collection={createIndex:async()=>{},updateOne:async()=>({modifiedCount:1})};
 const claims=createSandboxDeliveryClaims(collection,{testMode:true});
 for(const providerMessageId of ['   ',123,null]){
  await assert.rejects(claims.record('draft-1',{sandbox:true,realDelivery:false,providerMessageId}),/Verified sandbox receipt required/);
 }
});
