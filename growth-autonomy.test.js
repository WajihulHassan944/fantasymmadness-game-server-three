'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { defaults, validatePolicy } = require('./growth-autonomy');
const { workerConfig, assertHealth, runWorker } = require('./growth-autonomous-worker');
const crypto = require('node:crypto');
const valid = () => ({ ...defaults(), enabled: true, allowPublishedBusinessContacts: true });
const workerEnv = () => ({ GROWTH_WORKER_ENABLED:'true', GROWTH_STAGING_MODE:'isolated', GROWTH_OUTBOUND_ENABLED:'false', GROWTH_WORKER_ENGINE_URL:'http://127.0.0.1:4388', GROWTH_WORKER_LOOPBACK_TEST:'true', GROWTH_WORKER_INTERVAL_MS:'100', GROWTH_WORKER_CRON_SECRET:crypto.randomBytes(24).toString('hex') });
const health = () => ({ok:true,service:'growth-engine-isolated',mode:'isolated',database:{name:'fmgrowthtest',kind:'loopback-test'},delivery:{provider:'sandbox-capture',realDelivery:false},social:{provider:'sandbox',realPublishing:false}});
test('owner policy has bounded daily limits and never infers live outreach authorization',()=>{
 assert.equal(validatePolicy(valid()).mode,'sandbox');
 for(const change of [{mode:'approved-delivery'},{maxCampaignsPerDepartmentPerDay:10000},{departments:['owner-fallback']},{channels:['email-all']},{genres:['invented']},{approvedRecipients:['not-an-email']}]) assert.throws(()=>validatePolicy({...valid(),...change}));
 assert.equal(validatePolicy({...valid(),mode:'approved-delivery',approvedRecipients:['known@example.invalid']},{liveApproved:true}).approvedRecipients[0],'known@example.invalid');
});
test('daemon rejects production origins, ambient credentials, redirects and non-isolated modes',()=>{
 for(const change of [{GROWTH_WORKER_ENGINE_URL:'https://www.fantasymmadness.com'},{GROWTH_WORKER_ENGINE_URL:'https://fantasymmadness-growth-isolated-tes.vercel.app/other'},{GROWTH_WORKER_ENGINE_URL:'https://user:password@fantasymmadness-growth-isolated-tes.vercel.app'},{GROWTH_STAGING_MODE:'production'},{GROWTH_OUTBOUND_ENABLED:'true'},{GROWTH_WORKER_ENABLED:'false'}])assert.throws(()=>workerConfig({...workerEnv(),...change}));
 const cfg=workerConfig(workerEnv());assert.equal(cfg.loopback,true);
 for(const change of [{database:{name:'production'}},{delivery:{provider:'resend',realDelivery:true}},{social:{provider:'live',realPublishing:true}},{service:'legacy-game-server'}])assert.throws(()=>assertHealth({...health(),...change},cfg));
 assert.throws(()=>assertHealth({...health(),database:{name:'fmgrowthtest',kind:'atlas',hostPinned:false}},{loopback:false}));
});
test('worker performs no privileged tick until isolation health is verified; respects no-overlap, backoff and cancellation',async()=>{
 const env=workerEnv(),abort=new AbortController(),events=[],calls=[];let cycle=0;
 const fetchImpl=async(url,options)=>{calls.push({url,options});if(url.endsWith('/health'))return{ok:true,text:async()=>JSON.stringify(cycle++===0?{...health(),delivery:{realDelivery:true}}:health())};return{ok:true,text:async()=>JSON.stringify({ok:true,summary:{runId:'isolated-fixture',errors:[]}})};};
 let sleeps=0;const state=await runWorker({env,signal:abort.signal,fetchImpl,onEvent:x=>events.push(x),sleep:async()=>{if(++sleeps===2)abort.abort();}});
 assert.equal(state.ticks,1);assert.equal(state.stopped,true);assert.equal(events[0].type,'growth_worker_failure');
 assert.equal(calls.filter(x=>x.url.includes('/cron/tick')).length,1);
 assert.ok(calls.filter(x=>x.url.endsWith('/health')).every(x=>!x.options.headers.Authorization));
 assert.ok(calls.every(x=>x.options.redirect==='error'&&x.options.credentials==='omit'));
 assert.equal(JSON.stringify(events).includes(env.GROWTH_WORKER_CRON_SECRET),false);
});
