'use strict';
// Read-only deployed Preview checks. No provider calls, credentials, authorization or posts.
const assert = require('node:assert/strict');
const base = 'https://fantasymmadness-growth-git-585652-kelly-davis-projects-6c108d0b.vercel.app';
async function get(path) { const url=path.startsWith('https://') ? path : base+path;let r;try { r=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(20000)}); } catch(e) { throw Error(new URL(url).host+new URL(url).pathname+' fetch failed: '+(e.cause?.code||e.cause?.message||e.message)); } const text=await r.text();let json;try{json=JSON.parse(text);}catch{}return {status:r.status,text,json,headers:r.headers}; }

(async()=>{
 const h=await get('/api/growth/health');assert.equal(h.status,200,h.text);assert.equal(h.json.service,'growth-social-oauth-isolated-preview');assert.equal(h.json.environment,'preview');assert.equal(h.json.database.name,'fmgrowthtest');assert.equal(h.json.database.connected,true);assert.equal(h.json.database.hostPinned,true);assert.equal(h.json.publishingEnabled,false);assert.equal(h.json.outboundEnabled,false);assert.deepEqual(h.json.errors,[]);
 const tiktok=h.json.providers.find(p=>p.provider==='tiktok'),x=h.json.providers.find(p=>p.provider==='x');assert.equal(tiktok.configured,true,JSON.stringify(tiktok.blockers));
 for(const p of [tiktok,x])assert.equal(p.callbackUrl,base+'/api/growth/social/'+p.provider+'/callback');
 const ui=await get('/api/growth/console');assert.equal(ui.status,200);assert.match(ui.text,/Growth Engine/);assert.match(ui.headers.get('content-security-policy'),/script-src 'self'/);
 const signIn=await get('/api/growth/social/admin/sign-in');assert.equal(signIn.status,200);assert.equal(signIn.json.configured,true);assert.equal(signIn.json.method,'website_admin');
 const website='https://fmm-ver2-growth-social-preview.vercel.app';assert.equal(signIn.json.url,website+'/administration/growth-connections');
 assert.equal(signIn.json.keyId,'6fed666f6d72a111'); // Matched against authenticated frontend metadata, never a private key.
 const bridge=await get(website+'/api/admin/growth-social-session');
 const frontendProtected=[302,303,307,308].includes(bridge.status);
 if(frontendProtected){const target=new URL(bridge.headers.get('location'));assert.equal(target.hostname,'vercel.com');assert.match(target.pathname,/^\/sso-api/);}
 else {assert.equal(bridge.status,200);assert.equal(bridge.json.ok,true);assert.equal(bridge.json.environment,'preview');assert.equal(bridge.json.engineOrigin,base);assert.deepEqual(bridge.json.siteOrigins,[website]);assert.equal(bridge.json.keyId,signIn.json.keyId);}
 const preflight=await fetch('https://fantasymmadness-game-server-three-taupe.vercel.app/admin/login',{method:'OPTIONS',redirect:'error',headers:{Origin:website,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'},signal:AbortSignal.timeout(20000)});assert.ok(preflight.ok);assert.equal(preflight.headers.get('access-control-allow-origin'),website);assert.equal(preflight.headers.get('access-control-allow-credentials'),'true');
 const signInPage=await get(signIn.json.url);if(frontendProtected){assert.ok([302,303,307,308].includes(signInPage.status));const target=new URL(signInPage.headers.get('location'));assert.equal(target.hostname,'vercel.com');assert.match(target.pathname,/^\/sso-api/);}else{assert.equal(signInPage.status,200);assert.match(signInPage.text,/Connect to Growth Engine Preview/);}
 const anon=await get('/api/growth/social/connections');assert.equal(anon.status,401);assert.equal(anon.json.error,'admin_required');
 assert.equal((await get('/api/growth/social/tiktok/callback')).status,400);
 assert.equal((await get('/api/growth/social/x/callback')).status,x.configured?400:503);
 for(const path of ['/users','/api/payments/webhook','/api/growth/cron/tick','/api/growth/admin/run-now'])assert.equal((await get(path)).status,404,path);
 console.log(JSON.stringify({preview:base,database:h.json.database,administratorOnly:true,websiteSignInConfigured:true,websiteLoginCorsVerified:true,stagingPublicKeyPinned:true,frontendDeploymentProtected:frontendProtected,frontendMetadataPubliclyVerified:!frontendProtected,authenticatedOwnerSignInPerformed:false,callbackRoutesVerified:true,publishingEnabled:false,outboundEnabled:false,tiktokConfigured:tiktok.configured,xConfigured:x.configured,xBlockers:x.blockers,realProviderAuthorizationPerformed:false}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
