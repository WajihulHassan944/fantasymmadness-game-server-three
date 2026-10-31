'use strict';
// Staging-only rollback rehearsal. Operates on a randomly named loopback CI database.
// No live service, mail provider, or production credentials are contacted.
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {MongoClient}=require('mongodb');
const {createStore}=require('./growth-unattended-store');
(async()=>{
 const uri=process.env.GROWTH_TEST_MONGO_URI;
 if(!uri||!/^mongodb:\/\/(?:127\.0\.0\.1|localhost):27017(?:\/|\?|$)/.test(uri))throw Error('Rollback rehearsal requires loopback MongoDB');
 const client=new MongoClient(uri,{serverSelectionTimeoutMS:5000});
 const dbName='growth_rollback_rehearsal_'+randomUUID().replace(/-/g,'');
 const t=Date.parse('2026-11-01T12:00:00Z');
 let enabled=true,externalSends=0;
 try{
  await client.connect();
  const collection=client.db(dbName).collection('jobs');
  const store=createStore(collection,{testMode:true});await store.init();
  for(const id of ['campaign','pr','followup'])await store.enqueue({id,type:'prepare_campaign',dueAt:new Date(t).toISOString()});
  const active=await store.claim(t);
  assert.ok(active);
  // Simulate an operator kill switch and invalidate all pending/running leases.
  enabled=false;
  const rollback=await collection.updateMany({state:{$in:['pending','retry','running']}},{$set:{state:'cancelled',leaseToken:null,leaseUntil:null,rollbackReason:'staging_rehearsal'}});
  assert.equal(rollback.modifiedCount,3);
  assert.equal(enabled,false);
  assert.equal(await store.claim(t+180000),null);
  await assert.rejects(()=>store.finish(active,{success:true,now:t+1000}),/Lease expired or claimed/);
  const restarted=createStore(collection,{testMode:true});
  assert.equal(await restarted.claim(t+600000),null);
  assert.deepEqual(await restarted.summary(),{cancelled:3});
  assert.equal(externalSends,0);
  console.log('PASS isolated rollback rehearsal: kill switch, 3 cancelled jobs, stale lease rejected, restart safe, external sends 0');
 }finally{try{await client.db(dbName).dropDatabase()}finally{await client.close()}}
})().catch(e=>{console.error(e);process.exitCode=1});
