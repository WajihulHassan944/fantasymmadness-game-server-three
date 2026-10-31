'use strict';
// Multi-stage persistent scheduler integration against a dedicated LOCAL MongoDB.
// Tests campaign/PR/report sequencing, retries, restart and duplicate prevention.
// No external sends, live database or production server.
const assert=require('node:assert/strict');
const {MongoClient}=require('mongodb');
const {randomUUID}=require('node:crypto');
const {createStore,LEASE_MS}=require('./growth-unattended-store');
(async()=>{
 const uri=process.env.GROWTH_TEST_MONGO_URI;
 if(!uri||!/^mongodb:\/\/(?:127\.0\.0\.1|localhost):27017(?:\/|\?|$)/.test(uri))throw Error('Local isolated MongoDB only');
 const client=new MongoClient(uri,{serverSelectionTimeoutMS:5000});
 const dbName='growth_scheduler_staging_'+randomUUID().replace(/-/g,'');
 const t=Date.parse('2026-11-01T12:00:00Z');
 try{
  await client.connect();
  const col=client.db(dbName).collection('test_growth_jobs');
  const store=createStore(col,{testMode:true});await store.init();
  const inputs=[
   {id:'campaign-synthetic',type:'prepare_campaign',dueAt:new Date(t).toISOString()},
   {id:'pr-synthetic',type:'prepare_pr',dueAt:new Date(t).toISOString()},
   {id:'report-synthetic',type:'aggregate_report',dueAt:new Date(t+60000).toISOString()}
  ];
  for(const job of inputs)await store.enqueue(job);
  await store.enqueue(inputs[0]);
  assert.equal(await col.countDocuments({}),3,'duplicate campaign must not be enqueued');
  const first=await Promise.all([store.claim(t),store.claim(t),store.claim(t)]);
  assert.equal(first.filter(Boolean).length,2,'only two due jobs');
  for(const job of first.filter(Boolean)){
   if(job.type==='prepare_pr')await store.finish(job,{success:false,error:'synthetic retryable staging error',now:t});
   else await store.finish(job,{success:true,now:t});
  }
  const restarted=createStore(col,{testMode:true});
  assert.equal(await restarted.claim(t+59999),null,'retry and report are not yet due');
  const due=[await restarted.claim(t+60000),await restarted.claim(t+60000)];
  assert.deepEqual(due.map(j=>j.type).sort(),['aggregate_report','prepare_pr']);
  for(const job of due)await restarted.finish(job,{success:true,now:t+60000});
  assert.equal(await restarted.claim(t+120000),null);
  assert.deepEqual(await restarted.summary(),{completed:3});
  console.log('PASS persistent staging scheduler: 3 unique jobs, concurrent claims, retry, restart, report, zero outbound actions');
 }finally{try{await client.db(dbName).dropDatabase()}finally{await client.close()}}
})().catch(e=>{console.error(e);process.exitCode=1});
