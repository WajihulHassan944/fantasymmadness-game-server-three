'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runIsolatedCronOnce}=require('./growth-isolated-cron-once');
const good={GROWTH_STAGING_MODE:'isolated',GROWTH_OUTBOUND_ENABLED:'false',GROWTH_CRON_ENABLED:'true',GROWTH_ATLAS_STORE_ID:'store_5mRLkf9U8eKGIaaO',GROWTH_CRON_DB:'fmgrowthtest',GROWTH_TEST_ATLAS_URI:'mongodb+srv://test.invalid/fmgrowthtest'};
test('cron worker rejects missing isolated guards before connecting',async()=>{
 let calls=0;const connect=async()=>{calls++;throw Error('should not connect')};
 for(const key of Object.keys(good)){
  await assert.rejects(runIsolatedCronOnce({env:{...good,[key]:'wrong'},connect}),/required|disabled|store|database|URI/);
 }
 assert.equal(calls,0);
});
test('guarded cron worker runs draft-only workstreams in isolated collection',async()=>{
 const writes=[];let closed=false;
 const connect=async()=>({connect:async()=>{},db:name=>{assert.equal(name,'fmgrowthtest');return {collection:n=>{assert.ok(['isolated_workstream_runs','isolated_run_claims'].includes(n));return {createIndex:async()=>{},updateOne:async(k,u,o)=>{if(n==='isolated_workstream_runs')writes.push({k,u});return {upsertedCount:o?.upsert?1:0}}}}}},close:async()=>{closed=true}});
 const result=await runIsolatedCronOnce({env:good,connect,clock:()=>new Date('2026-10-31T14:00:00Z')});
 assert.equal(result.completed,25);assert.equal(result.errors.length,0);
 assert.equal(result.outboundActions,0);assert.equal(writes.length,25);assert.equal(closed,true);
});
