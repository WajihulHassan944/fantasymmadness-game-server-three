'use strict';
// Failure/recovery acceptance on CI-only MongoDB. No external sends.
const assert=require('node:assert/strict');
const {MongoClient}=require('mongodb');
const {randomUUID}=require('node:crypto');
const {createStore,LEASE_MS}=require('./growth-unattended-store');
(async()=>{
 const uri=process.env.GROWTH_TEST_MONGO_URI;
 if(!uri||!/^mongodb:\/\/(?:127\.0\.0\.1|localhost):27017(?:\/|\?|$)/.test(uri))throw Error('Only loopback MongoDB permitted');
 const client=new MongoClient(uri,{serverSelectionTimeoutMS:5000});
 const db='growth_failure_recovery_'+randomUUID().replace(/-/g,'');
 const col=client.db(db).collection('synthetic_jobs');
 const t=Date.parse('2026-11-01T12:00:00Z');
 try{
  await client.connect();const store=createStore(col,{testMode:true});await store.init();
  await store.enqueue({id:'retry-campaign',type:'prepare_campaign',dueAt:new Date(t).toISOString()});
  let job=await store.claim(t);assert.ok(job);
  await store.finish(job,{success:false,error:'synthetic temporary mailbox failure',now:t});
  assert.equal(await store.claim(t+59999),null);
  job=await store.claim(t+60000);assert.equal(job.attempts,2);
  await store.finish(job,{success:false,error:'synthetic temporary mailbox failure',now:t+60000});
  assert.equal(await store.claim(t+179999),null);
  job=await store.claim(t+180000);assert.equal(job.attempts,3);
  await store.finish(job,{success:false,error:'synthetic permanent failure',now:t+180000});
  assert.equal(await store.claim(t+360000),null);
  assert.deepEqual(await store.summary(),{failed:1});
  await store.enqueue({id:'crash-recovery',type:'prepare_followup',dueAt:new Date(t).toISOString()});
  const beforeCrash=await store.claim(t+400000);assert.ok(beforeCrash);
  const afterRestart=createStore(col,{testMode:true});
  assert.equal(await afterRestart.claim(t+400000+LEASE_MS-1),null);
  const recovered=await afterRestart.claim(t+400000+LEASE_MS);
  assert.equal(recovered.id,'crash-recovery');
  assert.notEqual(recovered.leaseToken,beforeCrash.leaseToken);
  await assert.rejects(()=>store.finish(beforeCrash,{success:true,now:t+400000+LEASE_MS}),/Lease expired or claimed/);
  await afterRestart.finish(recovered,{success:true,now:t+400000+LEASE_MS});
  assert.deepEqual(await afterRestart.summary(),{failed:1,completed:1});
  console.log('PASS retry backoff, three-attempt failure ceiling, crash recovery, stale worker rejected; external sends 0');
 }finally{try{await client.db(db).dropDatabase()}finally{await client.close()}}
})().catch(e=>{console.error(e);process.exitCode=1});
