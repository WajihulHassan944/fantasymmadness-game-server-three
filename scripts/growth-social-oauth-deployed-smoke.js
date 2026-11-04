'use strict';
// Read-only deployed Preview checks. No provider calls, credentials, authorization or posts.
const assert = require('node:assert/strict');
const base = 'https://fantasymmadness-growth-git-585652-kelly-davis-projects-6c108d0b.vercel.app';
async function get(path) { const r = await fetch(path.startsWith('https://') ? path : base + path, {redirect:'error',signal:AbortSignal.timeout(20000)});const text=await r.text();let json;try{json=JSON.parse(text);}catch{}return {status:r.status,text,json,headers:r.headers}; }
(async()=>{
 const h=await get('/api/growth/health');assert.equal(h.status,200,h.text);assert.equal(h.json.service,'growth-social-oauth-isolated-preview');assert.equal(h.json.environment,'preview');assert.equal(h.json.database.name,'fmgrowthtest');assert.equal(h.json.database.connected,true);assert.equal(h.json.database.hostPinned,true);assert.equal(h.json.publishingEnabled,false);assert.equal(h.json.outboundEnabled,false);assert.deepEqual(h.json.errors,[]);
 const tiktok=h.json.providers.find(p=>p.provider==='tiktok'),x=h.json.providers.find(p=>p.provider==='x');assert.equal(tiktok.configured,true,JSON.stringify(tiktok.blockers));
 for(const p of [tiktok,x])assert.equal(p.callbackUrl,base+'/api/growth/social/'+p.provider+'/callback');
 const ui=await get('/api/growth/console');assert.equal(ui.status,200);assert.match(ui.text,/Growth Engine/);assert.match(ui.headers.get('content-security-policy'),/script-src 'self'/);
 const signIn=await get('/api/growth/social/admin/sign-in');assert.equal(signIn.status,200);assert.equal(signIn.json.configured,true);assert.equal(signIn.json.method,'website_admin');
 const website='https://fmm-ver2-growth-social-preview.vercel.app';assert.equal(signIn.json.url,website+'/administration/growth-connections');
 const bridge=await get(website+'/api/admin/growth-social-session');assert.equal(bridge.status,200);assert.equal(bridge.json.ok,true);assert.equal(bridge.json.environment,'preview');assert.equal(bridge.json.engineOrigin,base);assert.deepEqual(bridge.json.siteOrigins,[website]);assert.equal(bridge.json.keyId,signIn.json.keyId);
 const signInPage=await get(signIn.json.url);assert.equal(signInPage.status,200);assert.match(signInPage.text,/Connect to Growth Engine Preview/);
 const anon=await get('/api/growth/social/connections');assert.equal(anon.status,401);assert.equal(anon.json.error,'admin_required');
 assert.equal((await get('/api/growth/social/tiktok/callback')).status,400);
 assert.equal((await get('/api/growth/social/x/callback')).status,x.configured?400:503);
 for(const path of ['/users','/api/payments/webhook','/api/growth/cron/tick','/api/growth/admin/run-now'])assert.equal((await get(path)).status,404,path);
 console.log(JSON.stringify({preview:base,database:h.json.database,administratorOnly:true,websiteSignInConfigured:true,stagingSigningKeysMatch:true,authenticatedOwnerSignInPerformed:false,callbackRoutesVerified:true,publishingEnabled:false,outboundEnabled:false,tiktokConfigured:tiktok.configured,xConfigured:x.configured,xBlockers:x.blockers,realProviderAuthorizationPerformed:false}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
