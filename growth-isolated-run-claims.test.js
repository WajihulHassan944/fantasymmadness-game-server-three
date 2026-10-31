'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runIsolatedCronOnce}=require('./growth-isolated-cron-once');
test('two cron invocations in same minute execute only once with shared claims',async()=>{
 const claimed=new Set();let workstreamWrites=0;
 const connect=async()=>({connect:async()=>{},close:async()=>{},db:()=>({collection:n=>({
  createIndex:async()=>{},
  updateOne:async(filter,update,opts)=>{
   if(n==='isolated_run_claims'&&opts?.upsert){if(claimed.has(filter.runId))return {upsertedCount:0};claimed.add(filter.runId);return {upsertedCount:1};}
   if(n==='isolated_workstream_runs')workstreamWrites++;
   return {modifiedCount:1};
  }
 })})});
 const env={GROWTH_STAGING_MODE:'isolated',GROWTH_OUTBOUND_ENABLED:'false',GROWTH_CRON_ENABLED:'true',GROWTH_ATLAS_STORE_ID:'store_5mRLkf9U8eKGIaaO',GROWTH_CRON_DB:'fmgrowthtest',GROWTH_TEST_ATLAS_URI:'mongodb+srv://test.invalid'};
 const opts={env,connect,clock:()=>new Date('2026-10-31T15:00:00Z')};
 const first=await runIsolatedCronOnce(opts),second=await runIsolatedCronOnce(opts);
 assert.equal(first.completed,25);assert.equal(second.alreadyClaimed,true);
 assert.equal(workstreamWrites,25);
});
