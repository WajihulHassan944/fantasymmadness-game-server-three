'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {MongoClient}=require('mongodb');const{createAutonomy,defaults}=require('./growth-autonomy');
const uri=process.env.GROWTH_TEST_MONGO_URI;
test('durable owner policy, atomic budgets, suppression, concurrent duplicate prevention and emergency stop', {skip:!/^mongodb:\/\/(127\.0\.0\.1|localhost):27017/.test(uri||'')},async()=>{
 const client=await new MongoClient(uri).connect(),db=client.db('fmgrowthtest'),prefix='issue198_'+crypto.randomUUID().replaceAll('-','')+'_';
 const col=Object.fromEntries(['settings','jobs','drafts','audit','affiliates'].map(k=>[k,db.collection(prefix+k)]));const owner='owner@fixture.invalid',scheduled=[];
 const cfg={delivery:{realDelivery:false,provider:'sandbox-capture'},social:{provider:'sandbox'},posters:{enabled:true},autonomy:{liveApproved:false}};
 const api=()=>createAutonomy({col,config:cfg,suppression:{isSuppressed:async email=>email==='opted-out@fixture.invalid'},audit:async(action,data)=>col.audit.insertOne({action,...data}),approveDraft:async(id)=>{await col.drafts.updateOne({id,status:'needs_owner_review'},{$set:{status:'approved'}});return{ok:true};},social:{setPaused:async p=>col.settings.updateOne({_id:'test-social'},{$set:{paused:p}},{upsert:true}),schedule:async(id)=>{scheduled.push(id);return{ok:true};}}});
 try{
  const a=api();assert.equal((await a.policy()).enabled,false);
  const saved=await a.save({...defaults(),enabled:true,allowPublishedBusinessContacts:true,maxCampaignsPerDepartmentPerDay:1},{actor:owner,expectedVersion:0});assert.equal(saved.version,1);
  await assert.rejects(()=>a.save({...defaults(),enabled:true},{actor:owner,expectedVersion:0}),e=>e.status===409);
  const email=(id,recipient='contact@fixture.invalid')=>({id,kind:'pr',genre:'boxing',status:'needs_owner_review',recipient,contactSource:'https://fixture.invalid/feed',consentBasis:'Published business contact (fixture)',relevanceSource:'https://fixture.invalid/episode',createdAt:new Date().toISOString()});
  await col.drafts.insertMany([email('pr-a'),email('pr-b'),email('opt-out','opted-out@fixture.invalid'),{id:'mkt-a',kind:'marketing',genre:'boxing',status:'needs_owner_review',createdAt:new Date().toISOString()}]);
  await Promise.all([a.run(),api().run()]);
  assert.equal(await col.drafts.countDocuments({kind:'pr',status:'approved'}),1,'atomic per-department budget');
  assert.equal((await col.drafts.findOne({id:'opt-out'})).status,'needs_owner_review');assert.deepEqual(scheduled,['mkt-a']);
  const restarted=api();assert.equal((await restarted.policy()).approvedBy,owner);await restarted.heartbeat('worker-restart-fixture');assert.equal((await a.status()).heartbeat.worker,'worker-restart-fixture');
  await restarted.stop(owner);assert.equal((await a.run()).skipped,'emergency_stop');assert.equal((await a.status()).policy.paused,true);assert.equal((await col.settings.findOne({_id:'test-social'})).paused,true);
  assert.equal(await col.audit.countDocuments({action:'autonomy_emergency_stop'}),1);
 }finally{for(const c of Object.values(col))await c.drop().catch(()=>{});await client.close();}
});
