'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{MongoClient}=require('mongodb'),crypto=require('crypto');
const {createProductionDistribution}=require('./growth-production-distribution'),{contentVersion}=require('./growth-production-review');
const uri=process.env.GROWTH_TEST_MONGO_URI,skip=!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri||'');
test('real Mongo distribution persists exact approvals, fences concurrent sends, deduplicates, honors holds and emergency stop, bounds retries and holds unknown outcomes',{skip},async()=>{
 const client=await new MongoClient(uri).connect(),db=client.db('growth_distribution_local'),prefix=crypto.randomBytes(8).toString('hex'),names=[];
 const collection=n=>{names.push(prefix+n);return db.collection(prefix+n);};
 const col={drafts:collection('drafts'),settings:collection('settings'),audit:collection('audit'),ownerCampaignHolds:collection('holds')},queue=collection('queue'),owner='a'.repeat(24);let time=new Date('2026-11-08T14:00:00Z'),sent=0,blocked=[],reply={ok:true,receipt:{providerMessageId:'provider-1',status:'accepted',delivered:false}};
 const email={readiness:async()=>({ready:true,provider:'gmail',sender:'contact@fantasymmadnesscom.com'}),send:async()=>{sent++;return reply;}},args={col,queue,owners:[owner],clock:()=>time,quality:async()=>blocked,email,enabled:true},engine=()=>createProductionDistribution(args);
 const api=engine();await api.init();
 const draft=n=>({id:'draft'+n,kind:'pr',status:'approved',ownerApproved:true,sendPermitted:false,recipient:'recipient'+n+'@example.invalid',subject:'Owner copy',text:'Exact approved copy '+n,listUnsubscribe:'https://example.invalid/unsubscribe'});
 async function approve(n,extra={}){const d=draft(n);await col.drafts.insertOne(d);const preview=await api.preview(d.id,'email');return api.authorize(d.id,{payloadHash:preview.payloadHash,version:contentVersion(d),confirmation:'AUTHORIZE THIS EXACT DELIVERY',channel:'email',recipient:d.recipient,scheduledAt:new Date(+time+1000).toISOString(),...extra},owner);}
 try{
  assert.equal((await api.readiness()).policy.paused,true);assert.equal((await api.pause(false,'b'.repeat(24))).ok,false);
  assert.equal((await approve(1,{recipient:'wrong@example.invalid'})).ok,false);
  await col.drafts.deleteOne({id:'draft1'});const first=await approve(1);assert.equal(first.ok,true);assert.equal((await api.dispatch()).paused,true);assert.equal(sent,0);
  assert.equal((await api.pause(false,owner)).ok,true);time=new Date(+time+2000);await Promise.all([api.dispatch(),engine().dispatch()]);assert.equal(sent,1);assert.equal((await queue.findOne({key:first.key})).status,'accepted');
  const d=await col.drafts.findOne({id:'draft1'});assert.equal((await api.authorize(d.id,{payloadHash:(await api.preview(d.id,'email')).payloadHash,version:contentVersion(d),confirmation:'AUTHORIZE THIS EXACT DELIVERY',channel:'email',recipient:d.recipient,scheduledAt:new Date(+time+1000).toISOString()},owner)).reason,'duplicate_delivery');
  const held=await approve(2);await col.ownerCampaignHolds.insertOne({_id:'draft2',active:true});time=new Date(+time+2000);await api.dispatch();assert.equal((await queue.findOne({key:held.key})).status,'held');assert.equal(sent,1);
  const changed=await approve(3);await col.drafts.updateOne({id:'draft3'},{$set:{recipient:'changed@example.invalid'}});time=new Date(+time+2000);await api.dispatch();assert.equal((await queue.findOne({key:changed.key})).status,'held');assert.equal(sent,1);
  const stopped=await approve(4);await col.settings.updateOne({_id:'autonomy:policy'},{$set:{paused:true}},{upsert:true});time=new Date(+time+2000);assert.equal((await api.dispatch()).paused,true);assert.equal((await api.pause(false,owner)).ok,false);assert.equal(sent,1);await col.settings.updateOne({_id:'autonomy:policy'},{$set:{paused:false}});
  reply={ok:false,uncertain:true,reason:'timeout'};await api.dispatch();assert.equal((await queue.findOne({key:stopped.key})).status,'needs_check');await engine().dispatch();assert.equal(sent,2);
  reply={ok:false,retryable:true,reason:'rate_limit'};const retry=await approve(5);for(let i=0;i<3;i++){time=new Date(+time+60*60000);await api.dispatch();}assert.equal((await queue.findOne({key:retry.key})).attempts,3);assert.equal((await queue.findOne({key:retry.key})).status,'failed');assert.equal(sent,5);
  blocked=['registry_public_entry_state_conflict'];assert.equal((await approve(6)).reason,'campaign_held');
  assert.ok(await col.audit.countDocuments({action:'distribution_provider_result'})>=5);
 }finally{for(const n of names)await db.collection(n).drop().catch(()=>{});await client.close();}
});
