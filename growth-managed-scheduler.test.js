'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {MongoClient}=require('mongodb');
const {verifiedOwners,schedulerStatus,SITE}=require('./growth-managed-scheduler');
const {cycle,validate}=require('./growth-worker-service/src/runtime.cjs');
const uri=process.env.GROWTH_TEST_MONGO_URI,skip=!/^mongodb:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(uri||'');
test('managed worker fails closed outside dedicated Preview and against live providers',()=>{
 for(const env of [{},{VERCEL_ENV:'production'},{GROWTH_OUTBOUND_ENABLED:'true'},{GROWTH_SOCIAL_PROVIDER:'live'}])assert.throws(()=>validate(env),/configuration_required/);
});
test('allowlist accepts only issuer-confirmed first-party administrators and monitoring requires real timer evidence',{skip},async()=>{
 const c=await new MongoClient(uri).connect(),db=c.db('fmgrowthtest'),name='managedtest_'+crypto.randomBytes(6).toString('hex'),col=db.collection(name);
 try{
  const trusted={action:'sso_login',method:'website_admin',transport:'first_party_assertion',issuerConfirmed:true,site:SITE,adminId:'111111111111111111111111'};
  await col.insertMany([trusted,{...trusted,issuerConfirmed:false,adminId:'222222222222222222222222'},{...trusted,site:'https://evil.test',adminId:'333333333333333333333333'},{...trusted,adminId:'invalid'}]);
  assert.deepEqual(await verifiedOwners({collection:()=>col}),[trusted.adminId]);
  assert.equal((await schedulerStatus(col)).healthy,false);
  await col.insertOne({_id:'managed-scheduler',enabled:true,ownerCount:1});
  assert.equal((await schedulerStatus(col)).healthy,false,'activation or a bootstrap is not timer proof');
  await col.updateOne({_id:'managed-scheduler'},{$set:{lastScheduledAt:new Date().toISOString(),scheduledExecutions:2}});
  assert.equal((await schedulerStatus(col)).healthy,true);
  await col.updateOne({_id:'managed-scheduler'},{$set:{lastError:'workstream_error_check_execution_log'}});assert.equal((await schedulerStatus(col)).healthy,false,'recent timer does not hide a workstream error');
  await col.updateOne({_id:'managed-scheduler'},{$set:{lastError:null}});
  assert.equal((await schedulerStatus(col,new Date(Date.now()+36*60000))).healthy,false);
 }finally{await col.drop();await c.close();}
});
test('scheduled execution is durable, duplicate-safe, recoverable, generation-bound and stoppable',{skip},async()=>{
 const c=await new MongoClient(uri).connect(),db=c.db('fmgrowthtest'),prefix='managedtest_'+crypto.randomBytes(6).toString('hex'),settings=db.collection(prefix+'_settings'),cycles=db.collection(prefix+'_cycles');let ticks=0,fail=false;
 const ctx={settings,cycles,rt:{autonomy:{heartbeat:async()=>{}},tick:async()=>{ticks++;if(fail)throw Error('secret-do-not-log');return{runId:'fixture-'+ticks,jobs:[],errors:[]};}}};
 try{
  await settings.insertOne({_id:'managed-scheduler',enabled:true,generation:'test'});
  await cycle('test',0,{workflowRunId:'fixture'},ctx);assert.equal((await settings.findOne({_id:'managed-scheduler'})).scheduledExecutions,undefined);
  await cycle('test',1,{workflowRunId:'fixture'},ctx);await cycle('test',1,{workflowRunId:'fixture'},ctx);assert.equal(ticks,2);assert.equal((await settings.findOne({_id:'managed-scheduler'})).scheduledExecutions,1);
  assert.equal((await cycle('wrong',2,{},ctx)).stop,true);
  fail=true;await assert.rejects(()=>cycle('test',2,{},ctx),/sandbox_worker_cycle_failed/);assert.equal((await settings.findOne({_id:'managed-scheduler'})).lastError,'worker_cycle_failed');
  fail=false;await cycle('test',2,{},ctx);assert.equal((await cycles.findOne({_id:'test:2'})).attempts,2);
  await settings.updateOne({_id:'managed-scheduler'},{$set:{leaseUntil:new Date(Date.now()+60000).toISOString()}});assert.equal((await cycle('test',3,{},ctx)).busy,true);
  await settings.updateOne({_id:'managed-scheduler'},{$set:{leaseUntil:new Date(Date.now()-1000).toISOString(),leaseOwner:'terminated-process'}});
  assert.equal((await cycle('test',3,{},ctx)).stop,false,'an expired process lease must recover');
  assert.equal((await cycles.findOne({_id:'test:3'})).errorCount,0);
  const before=ticks;let release;const gate=new Promise(r=>release=r);const original=ctx.rt.tick;
  ctx.rt.tick=async()=>{await gate;return original();};
  const inFlight=cycle('test',4,{workflowRunId:'fixture'},ctx);
  for(let i=0;i<100;i++){if((await settings.findOne({_id:'managed-scheduler'})).leaseOwner==='test:4')break;await new Promise(r=>setTimeout(r,5));}
  assert.equal((await cycle('test',5,{},ctx)).busy,true,'concurrent timer cannot overlap the active worker');
  release();await inFlight;assert.equal(ticks,before+1);
  await settings.updateOne({_id:'managed-scheduler'},{$set:{enabled:false}});assert.equal((await cycle('test',6,{},ctx)).stop,true);
 }finally{await settings.drop();await cycles.drop();await c.close();}
});
