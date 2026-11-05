'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {MongoClient}=require('mongodb');
const {verifiedOwners,schedulerStatus,SITE,activateRelease}=require('./growth-managed-scheduler');
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
  await col.insertOne({_id:'autonomy:policy',paused:true});const stopped=await schedulerStatus(col);assert.equal(stopped.schedulerEnabled,true);assert.equal(stopped.preparationEnabled,false);assert.equal(stopped.preparationPaused,true);await col.deleteOne({_id:'autonomy:policy'});
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
  await settings.updateOne({_id:'managed-scheduler'},{$set:{leaseUntil:new Date(Date.now()+60000).toISOString()}});assert.equal((await activateRelease(settings,{release:'next-release',previous:'test'})).modifiedCount,0,'handoff waits for an active lease');
  await settings.updateOne({_id:'managed-scheduler'},{$unset:{leaseUntil:''}});assert.equal((await activateRelease(settings,{release:'next-release',previous:'test'})).modifiedCount,1);assert.equal((await activateRelease(settings,{release:'old-release',previous:'test'})).modifiedCount,0,'an old deployment cannot roll the generation back');
  await settings.updateOne({_id:'managed-scheduler'},{$set:{generation:'test'}});
  const before=ticks;let release;const gate=new Promise(r=>release=r);const original=ctx.rt.tick;
  ctx.rt.tick=async()=>{await gate;return original();};
  const inFlight=cycle('test',4,{workflowRunId:'fixture'},ctx);
  for(let i=0;i<100;i++){if((await settings.findOne({_id:'managed-scheduler'})).leaseOwner==='test:4')break;await new Promise(r=>setTimeout(r,5));}
  assert.equal((await cycle('test',5,{},ctx)).busy,true,'concurrent timer cannot overlap the active worker');
  release();await inFlight;assert.equal(ticks,before+1);
  await settings.updateOne({_id:'managed-scheduler'},{$set:{enabled:false}});assert.equal((await cycle('test',6,{},ctx)).stop,true);
 }finally{await settings.drop();await cycles.drop();await c.close();}
});

test('a replaced worker lease cannot finish a cycle or advance scheduler evidence',{skip},async()=>{
 const c=await new MongoClient(uri).connect(),db=c.db('fmgrowthtest'),prefix='fence202_'+crypto.randomBytes(6).toString('hex'),settings=db.collection(prefix+'_settings'),cycles=db.collection(prefix+'_cycles');let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const ctx={settings,cycles,rt:{autonomy:{heartbeat:async()=>{}},tick:async()=>{entered();await gate;return{runId:'fixture',jobs:[],errors:[]};}}};
 try{await settings.insertOne({_id:'managed-scheduler',enabled:true,generation:'fenced'});const old=cycle('fenced',1,{workflowRunId:'fixture'},ctx);await started;await settings.updateOne({_id:'managed-scheduler'},{$set:{leaseOwner:'replacement',leaseToken:'fixture-replacement-token',leaseUntil:new Date(Date.now()+600000).toISOString()}});release();assert.equal((await old).leaseLost,true);const s=await settings.findOne({_id:'managed-scheduler'});assert.equal(s.scheduledExecutions,undefined);assert.equal(s.leaseOwner,'replacement');assert.equal((await cycles.findOne({_id:'fenced:1'})).finishedAt,undefined);
 }finally{await settings.drop();await cycles.drop();await c.close();}
});

test('owner controls retain the established verified binding instead of admitting later administrator logins',{skip},async()=>{
 const client=await new MongoClient(uri).connect(),db=client.db('fmgrowthtest'),prefix='owner202_'+crypto.randomBytes(6).toString('hex'),audits=db.collection(prefix+'_audit'),settings=db.collection(prefix+'_settings');
 const raw={collection:()=>audits},{pinnedOwners}=require('./growth-managed-scheduler');
 try{const trusted={action:'sso_login',method:'website_admin',transport:'first_party_assertion',issuerConfirmed:true,site:SITE};await audits.insertMany([{...trusted,adminId:'1'.repeat(24)},{...trusted,adminId:'2'.repeat(24)}]);await assert.rejects(()=>pinnedOwners(raw,settings,[]),/explicit_verified_owner/);await settings.insertOne({_id:'managed-owner-allowlist',ids:['1'.repeat(24)]});assert.deepEqual(await pinnedOwners(raw,settings,[]),['1'.repeat(24)]);
 }finally{await audits.drop();await settings.drop();await client.close();}
});
