'use strict';
const assert=require('node:assert/strict');
const origin=process.env.WORKER_URL;
assert.match(origin||'',/^https:\/\/fantasymmadness-growth-isolated-test-[a-z0-9]+\.vercel\.app$/);
(async()=>{
 let last;
 for(let i=0;i<36;i++){
  const r=await fetch(origin+'/health',{signal:AbortSignal.timeout(60000),redirect:'error'});last=await r.json();
  assert.equal(r.status,200,JSON.stringify(last));assert.equal(last.environment,'preview');assert.equal(last.database,'fmgrowthtest');assert.equal(last.collectionPrefix,'preview198_');assert.equal(last.scheduler.publishingEnabled,false);assert.equal(last.scheduler.outboundEnabled,false);
  if(last.scheduler.scheduledExecutions>=2&&(!process.env.EXPECTED_WORKER_RELEASE||(last.scheduler.generation===process.env.EXPECTED_WORKER_RELEASE&&last.scheduler.lastScheduledGeneration===process.env.EXPECTED_WORKER_RELEASE&&last.scheduler.generationScheduledExecutions>=2))){assert.equal(last.scheduler.healthy,true);assert.equal(last.scheduler.ownerAllowlistConfigured,true);console.log(JSON.stringify({verifiedAt:new Date().toISOString(),...last,websiteSessionUsed:false}));return;}
  await new Promise(r=>setTimeout(r,20000));
 }
 throw Error('No two actual durable timer executions observed: '+JSON.stringify(last));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
