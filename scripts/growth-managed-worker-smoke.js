'use strict';
const assert=require('node:assert/strict');
const origin=process.env.WORKER_URL;
assert.match(origin||'',/^https:\/\/fantasymmadness-growth-isolated-test-[a-z0-9]+\.vercel\.app$/);
(async()=>{
 let last;
 for(let i=0;i<36;i++){
  const r=await fetch(origin+'/health',{signal:AbortSignal.timeout(60000),redirect:'error'});last=await r.json();
  assert.equal(r.status,200,JSON.stringify(last));assert.equal(last.environment,'preview');assert.equal(last.database,'fmgrowthtest');assert.equal(last.collectionPrefix,'preview198_');assert.equal(last.scheduler.publishingEnabled,false);assert.equal(last.scheduler.outboundEnabled,false);
  if(last.scheduler.scheduledExecutions>=2&&(!process.env.EXPECTED_WORKER_RELEASE||(last.scheduler.generation===process.env.EXPECTED_WORKER_RELEASE&&last.scheduler.lastScheduledGeneration===process.env.EXPECTED_WORKER_RELEASE&&last.scheduler.generationScheduledExecutions>=2))){assert.equal(last.scheduler.healthy,true);assert.equal(last.scheduler.ownerAllowlistConfigured,true);if(process.env.EXPECTED_WORKER_RELEASE==='poster-status-repair-v3'){assert.ok(last.scheduler.posterRepair,'Missing actual poster repair evidence');assert.equal(last.scheduler.posterRepair.remainingRuntimeAlerts,0);assert.deepEqual(Object.keys(last.scheduler.posterRepair.sports).sort(),['bare-knuckle','boxing','kickboxing','mma-ufc','pro-wrestling']);assert.equal(last.scheduler.posterRepair.sourceReachable,true);}if(process.env.EXPECTED_WORKER_RELEASE==='autonomous-preparation-v4'){const o=last.scheduler.operations;assert.equal(last.scheduler.workerBindingReady,true);assert.equal(o.mode,'preparation_only');assert.deepEqual(Object.keys(o.departments).sort(),['affiliate','marketing','pr']);assert.equal(o.realDeliveriesObserved,0);assert.equal(o.liveSocialPostsObserved,0);assert.equal(o.attributedPayingConversions,null);for(const d of Object.values(o.departments)){assert.ok(d.receipts>0,'Missing actual department preparation receipts');assert.equal(d.ready+d.held+d.awaitingReceipt,d.awaitingOwnerReview);}assert.ok((o.jobs.completed||0)>=3,'No three-department completion evidence');assert.equal(last.scheduler.connections.meta.facebook.state,'connected');assert.equal(last.scheduler.connections.meta.instagram.state,'connected');assert.equal(last.scheduler.connections.metaScopesVerified,true);for(const p of ['tiktok','x'])assert.ok(last.scheduler.connections.oauth.some(c=>c.provider===p),'Missing preserved OAuth account');}console.log(JSON.stringify({verifiedAt:new Date().toISOString(),...last,websiteSessionUsed:false}));return;}
  await new Promise(r=>setTimeout(r,20000));
 }
 throw Error('No two actual durable timer executions observed: '+JSON.stringify(last));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
