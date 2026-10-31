'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runIsolatedCronOnce}=require('./growth-isolated-cron-once');
test('unexpected scheduler failure records failed durable run claim',async()=>{
 const updates=[];let closed=false;
 const connect=async()=>({connect:async()=>{},close:async()=>{closed=true},db:()=>({collection:n=>({
  createIndex:async()=>{},
  updateOne:async(f,u,o)=>{
   if(n==='isolated_run_claims')updates.push({filter:f,update:u,options:o});
   if(n==='isolated_workstream_runs')throw Error('synthetic persistence outage');
   return {upsertedCount:o?.upsert?1:0};
  }
 })})});
 const env={GROWTH_STAGING_MODE:'isolated',GROWTH_OUTBOUND_ENABLED:'false',GROWTH_CRON_ENABLED:'true',GROWTH_ATLAS_STORE_ID:'store_5mRLkf9U8eKGIaaO',GROWTH_CRON_DB:'fmgrowthtest',GROWTH_TEST_ATLAS_URI:'mongodb+srv://test.invalid/fmgrowthtest'};
 const r=await runIsolatedCronOnce({env,connect,clock:()=>new Date('2026-10-31T15:01:00Z')});
 assert.equal(r.errors.length,25);
 assert.equal(updates.length,2);assert.equal(updates[1].update.$set.state,'failed');
 assert.equal(closed,true);
});
