'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('crypto');
const express = require('express'), jwt = require('jsonwebtoken'), { MongoClient } = require('mongodb');
const { installGrowthSocialOAuth, resolveOAuthConfig, decrypt } = require('./growth-social-oauth-isolated');
const { signConsoleToken, consolePasswordVersion } = require('./growth-social-oauth-token');
const origin = 'https://growth-preview.example.test';
const secret = crypto.randomBytes(48).toString('hex'), key = crypto.randomBytes(32);
const salt = crypto.randomBytes(16), password = 'isolated-fixture-password';
const passwordHash = `scrypt$${salt.toString('base64')}$${crypto.scryptSync(password,salt,64).toString('base64')}`;
const env = { GROWTH_SOCIAL_PUBLIC_ORIGIN: origin, GROWTH_SOCIAL_TOKEN_KEY: key.toString('base64'), GROWTH_TIKTOK_CLIENT_KEY: 'fixture-client', GROWTH_TIKTOK_CLIENT_SECRET: 'fixture-secret', GROWTH_X_CLIENT_ID: 'fixture-x-client', GROWTH_X_CLIENT_SECRET: 'fixture-x-secret', GROWTH_SOCIAL_PASSWORD_LOGIN:'true',GROWTH_ADMIN_PASSWORD_HASH: passwordHash, GROWTH_SOCIAL_PROVIDER: 'none' };
const token = () => signConsoleToken(secret,{pwv:consolePasswordVersion(passwordHash),sid:crypto.randomBytes(16).toString('hex')},{expiresIn:'20m'});
const tikId = 'verified_tiktok_open_id', xId = '123456789012345678';
const uri = process.env.GROWTH_TEST_MONGO_URI;

test('configuration refuses production, other projects, unsafe origins and bad encryption keys',()=>{
 assert.equal(resolveOAuthConfig(env).errors('tiktok').length,0);
 assert.equal(resolveOAuthConfig({...env,GROWTH_X_CLIENT_ID:''}).errors('x')[0],'client_key_missing');
 for(const bad of [{GROWTH_SOCIAL_PUBLIC_ORIGIN:'https://fantasymmadness.com'},{GROWTH_SOCIAL_PUBLIC_ORIGIN:'https://evil.test/?growth=test'},{GROWTH_SOCIAL_PUBLIC_ORIGIN:origin+'/path'},{GROWTH_SOCIAL_TOKEN_KEY:'bad'},{VERCEL:'1',VERCEL_ENV:'production',VERCEL_PROJECT_ID:require('./growth-runtime-config').ISOLATED_PROJECT_ID},{GROWTH_SOCIAL_PROVIDER:'live'},{GROWTH_OUTBOUND_ENABLED:'true'}])assert.throws(()=>resolveOAuthConfig({...env,...bad}));
 assert.deepEqual(resolveOAuthConfig({...env,GROWTH_TIKTOK_REDIRECT_URI:origin+'/wrong'}).errors('tiktok'),['redirect_uri_mismatch']);
 assert.throws(()=>installGrowthSocialOAuth({router:express.Router(),env,db:{databaseName:'live'},adminSecret:secret}),/fmgrowthtest/);
});

test('OAuth security and account confirmation with isolated MongoDB',{skip:!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri||'')},async t=>{
 const client=await new MongoClient(uri).connect(), db=client.db('fmgrowthtest');
 async function harness(over={}){
  await db.dropDatabase();let now=Date.now();const calls=[], authorizationUrls=[], state={...over};const cookies=new Map();
  const fetchImpl=async(url,opts)=>{
   calls.push({url,opts});const p=url.includes('tiktok')?'tiktok':'x';const isToken=url.includes('/token');
   if(isToken){if(state.tokenFailure)return {ok:false,status:400,json:async()=>({error:'invalid_grant',client_secret:'never-expose'})};
    const refresh=new URLSearchParams(opts.body).get('grant_type')==='refresh_token';
    return {ok:true,json:async()=>({access_token:refresh?'rotated-access-token':'fixture-access-token',refresh_token:refresh&&state.noRotatedRefresh?undefined:refresh?'rotated-refresh-token':'fixture-refresh-token',token_type:'Bearer',expires_in:7200,scope:p==='tiktok'?'user.info.basic':'users.read tweet.read offline.access',...(p==='tiktok'?{open_id:state.tokenId===undefined?tikId:state.tokenId}:{}),...(state.malformed?{access_token:''}:{})})};
   }
   if(state.profileFailure)return {ok:false,status:503};
   return {ok:true,json:async()=>p==='tiktok'?{error:{code:state.profileError||'ok'},data:{user:{open_id:state.profileId===undefined?tikId:state.profileId,display_name:'FANTASY MMADNESS'}}}:{data:{id:state.profileId||xId,username:state.username||'FMmadness2024',name:'FANTASY MMADNESS'}}};
  };
  const app=express();app.use(express.json());const router=express.Router();installGrowthSocialOAuth({router,env:{...env,...state.env},db,adminSecret:secret,fetchImpl,clock:()=>new Date(now)});app.use('/api/growth',router);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port+'/api/growth';const admin=token();
  async function call(method,path,{body,auth=admin,cookie,headers={}}={}){
   const r=await fetch(base+path,{method,headers:{Origin:origin,...(auth?{Authorization:'Bearer '+auth}:{}),'Content-Type':'application/json',Cookie:cookie===undefined?[...cookies].map(([k,v])=>k+'='+v).join('; '):cookie,...headers},...(body?{body:JSON.stringify(body)}:{})});
   for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],i=pair.indexOf('=');if(c.includes('Max-Age=0'))cookies.delete(pair.slice(0,i));else cookies.set(pair.slice(0,i),pair.slice(i+1));}
   const text=await r.text();let json;try{json=JSON.parse(text);}catch{}return {status:r.status,text,json,headers:r.headers};
  }
  async function start(p='tiktok'){const r=await call('POST','/social/'+p+'/connect',{body:{}});assert.equal(r.status,200,r.text);const u=new URL(r.json.authorizationUrl);authorizationUrls.push(u);return u.searchParams.get('state');}
  const callback=(s,p='tiktok',extra={})=>call('GET','/social/'+p+'/callback?state='+encodeURIComponent(s)+'&code=fixture-code',extra);
  const status=()=>call('GET','/social/connections');
  async function confirm(p='tiktok',extra={}){const j=(await status()).json;const c=j.pending.find(x=>x.provider===p);assert.ok(c);return call('POST','/social/'+p+'/confirm',{body:{candidateId:c.candidateId,identity:c.identity},...extra});}
  return {call,start,callback,status,confirm,state,calls,cookies,authorizationUrls,advance:ms=>{now+=ms;},close:()=>new Promise(r=>{server.closeAllConnections();server.close(r);})};
 }
 async function run(name,fn,over){await t.test(name,async()=>{const h=await harness(over);try{await fn(h);}finally{await h.close();}});}
 try{
 await run('only scoped administrator sessions access connections or connect',async h=>{
  assert.equal((await h.call('GET','/social/connections',{auth:null})).status,401);
  assert.equal((await h.call('POST','/social/tiktok/connect',{auth:jwt.sign({id:'user'},secret),body:{}})).status,401);
  const productionKey=crypto.createHmac('sha256',secret).update('fmm-growth-console-token/v1').digest();
  const productionToken=jwt.sign({role:'growth_owner',scope:'growth',pwv:consolePasswordVersion(passwordHash)},productionKey,{audience:'fmm-growth-console',issuer:'fmm-growth-engine',expiresIn:'20m'});
  assert.equal((await h.call('GET','/social/connections',{auth:productionToken})).status,401);
  assert.equal((await h.call('POST','/social/tiktok/connect',{body:{},headers:{Origin:'https://evil.test'}})).status,403);
  assert.equal(h.calls.length,0);
 });
 await run('admin login uses existing password, and logout revokes the OAuth session',async h=>{
  assert.equal((await h.call('POST','/social/admin/login',{auth:null,body:{password:'wrong'}})).status,401);
  const login=await h.call('POST','/social/admin/login',{auth:null,body:{password}});assert.equal(login.status,200);
  assert.equal((await h.call('GET','/social/connections',{auth:login.json.token})).status,200);
  assert.equal((await h.call('POST','/social/admin/logout',{auth:login.json.token,body:{}})).status,200);
  assert.equal((await h.call('GET','/social/connections',{auth:login.json.token})).status,401);
 });
 await run('TikTok discovers Open ID without preset identity; confirmation precedes DB credentials',async h=>{
  const s=await h.start();assert.equal(h.authorizationUrls[0].searchParams.get('scope'),'user.info.basic');const authCall=await db.collection('growth_social_oauth_pending').findOne({});assert.ok(authCall.binding);assert.ok(authCall.verifier.ciphertext);
  const result=await h.callback(s);assert.equal(result.status,200,result.text);
  assert.equal(await db.collection('growth_social_accounts').countDocuments({credentials:{$exists:true}}),0);
  const c=await db.collection('growth_social_oauth_candidates').findOne({});assert.equal(c.credentials,undefined);assert.equal(c.tokens,undefined);assert.ok(!JSON.stringify(c).includes('fixture-access-token'));
  assert.ok([...h.cookies.keys()].includes('__Host-growth_tiktok_candidate'));
  const response=await h.confirm();assert.equal(response.status,200,response.text);
  const account=await db.collection('growth_social_accounts').findOne({_id:'tiktok'});assert.equal(account.identity,tikId);assert.equal(account.publishingEnabled,false);assert.equal(decrypt(account.credentials,key).access_token,'fixture-access-token');
  const status=await h.status();assert.ok(!status.text.includes('ciphertext'));assert.ok(!status.text.includes('fixture-access-token'));assert.equal(status.json.connections[0].status,'connected');
 });
 for(const [name,over]of Object.entries({missing_token_identity:{tokenId:null},missing_profile_identity:{profileId:null},mismatched_identity:{profileId:'other_verified_identity'},provider_error:{profileError:'scope_not_authorized'},userinfo_failure:{profileFailure:true},malformed_tokens:{malformed:true},failed_exchange:{tokenFailure:true},unexpected_approved_account:{env:{GROWTH_TIKTOK_EXPECTED_OPEN_ID:'different_approved_id'}}}))await run(name,async h=>{const r=await h.callback(await h.start());assert.ok(r.status>=400);assert.equal(await db.collection('growth_social_accounts').countDocuments({credentials:{$exists:true}}),0);assert.equal(await db.collection('growth_social_oauth_candidates').countDocuments(),0);assert.ok(!r.text.includes('never-expose'));},over);
 await run('expired state is rejected even before Mongo TTL deletion',async h=>{const s=await h.start();h.advance(601000);assert.equal((await h.callback(s)).status,400);assert.equal(h.calls.length,0);});
 await run('wrong browser cannot consume a valid state',async h=>{const s=await h.start();assert.equal((await h.callback(s,'tiktok',{cookie:''})).status,400);assert.equal(await db.collection('growth_social_oauth_pending').countDocuments(),1);assert.equal((await h.callback(s)).status,200);});
 await run('duplicate callbacks exchange a code only once',async h=>{const s=await h.start();const result=await Promise.all([h.callback(s),h.callback(s)]);assert.deepEqual(result.map(r=>r.status).sort(),[200,400]);assert.equal(h.calls.filter(c=>c.url.includes('/token')).length,1);});
 await run('confirmation is bound to the initiating admin session and cookie',async h=>{await h.callback(await h.start());assert.equal((await h.confirm('tiktok',{auth:token()})).status,409);assert.equal((await h.confirm('tiktok',{cookie:''})).status,409);assert.equal((await h.confirm()).status,200);assert.equal((await h.call('POST','/social/tiktok/confirm',{body:{candidateId:'used',identity:tikId}})).status,409);});
 await run('expired confirmation cannot persist credentials',async h=>{await h.callback(await h.start());h.advance(301000);assert.equal((await h.call('POST','/social/tiktok/confirm',{body:{identity:tikId,candidateId:'anything'}})).status,409);assert.equal(await db.collection('growth_social_accounts').countDocuments({credentials:{$exists:true}}),0);});
 await run('X uses S256 PKCE, verified ID and the exact approved username',async h=>{const s=await h.start('x');const record=await db.collection('growth_social_oauth_pending').findOne({provider:'x'});const verifier=decrypt(record.verifier,key);assert.equal(h.authorizationUrls[0].searchParams.get('code_challenge'),crypto.createHash('sha256').update(verifier).digest('base64url'));assert.equal(h.authorizationUrls[0].searchParams.get('code_challenge_method'),'S256');assert.ok(!h.authorizationUrls[0].searchParams.get('scope').includes('tweet.write'));assert.equal((await h.callback(s,'x')).status,200);const request=h.calls.find(c=>c.url.includes('/token'));const params=new URLSearchParams(request.opts.body);assert.equal(params.get('code_verifier'),verifier);assert.match(request.opts.headers.Authorization,/^Basic /);assert.equal(params.has('client_secret'),false);assert.equal(params.get('redirect_uri'),origin+'/api/growth/social/x/callback');assert.equal((await h.confirm('x')).status,200);const a=await db.collection('growth_social_accounts').findOne({_id:'x'});assert.equal(a.identity,xId);assert.equal(a.username,'FMmadness2024');assert.equal(a.publishingEnabled,false);});
 await run('X rejects another authenticated account',async h=>{assert.equal((await h.callback(await h.start('x'),'x')).status,403);assert.equal(await db.collection('growth_social_oauth_candidates').countDocuments(),0);},{username:'SomeoneElse'});
 await run('refresh rotates encrypted tokens only after verifying the same X account',async h=>{await h.callback(await h.start('x'),'x');await h.confirm('x');const r=await h.call('POST','/social/x/refresh',{body:{}});assert.equal(r.status,200,r.text);const a=await db.collection('growth_social_accounts').findOne({_id:'x'});assert.equal(decrypt(a.credentials,key).refresh_token,'rotated-refresh-token');assert.equal(a.publishingEnabled,false);});
 await run('refresh preserves existing credentials on failed exchange or identity mismatch',async h=>{await h.callback(await h.start('x'),'x');await h.confirm('x');const before=(await db.collection('growth_social_accounts').findOne({_id:'x'})).credentials;h.state.tokenFailure=true;assert.equal((await h.call('POST','/social/x/refresh',{body:{}})).status,400);h.state.tokenFailure=false;h.state.username='wrong';assert.equal((await h.call('POST','/social/x/refresh',{body:{}})).status,403);assert.deepEqual((await db.collection('growth_social_accounts').findOne({_id:'x'})).credentials,before);});
 await run('omitted rotated refresh token is retained; disconnect removes stored credentials',async h=>{await h.callback(await h.start('x'),'x');await h.confirm('x');h.state.noRotatedRefresh=true;assert.equal((await h.call('POST','/social/x/refresh',{body:{}})).status,200);assert.equal(decrypt((await db.collection('growth_social_accounts').findOne({_id:'x'})).credentials,key).refresh_token,'fixture-refresh-token');assert.equal((await h.call('POST','/social/x/disconnect',{body:{}})).status,200);const a=await db.collection('growth_social_accounts').findOne({_id:'x'});assert.equal(a.credentials,undefined);assert.equal(a.identity,xId);assert.equal(a.status,'disconnected');assert.equal((await h.call('POST','/social/x/refresh',{body:{}})).status,409);});
 await run('disconnect invalidates any unconfirmed authorization without saving credentials',async h=>{await h.callback(await h.start());const pending=(await h.status()).json.pending[0];const before=await db.collection('growth_social_oauth_candidates').findOne({});assert.ok(before);await h.call('POST','/social/tiktok/disconnect',{body:{}});assert.equal((await h.call('POST','/social/tiktok/confirm',{body:{candidateId:pending.candidateId,identity:pending.identity}})).status,409);assert.equal(await db.collection('growth_social_accounts').countDocuments({credentials:{$exists:true}}),0);});
 await run('backend refuses unrequested publishing routes',async h=>{assert.equal((await h.call('POST','/social/tiktok/publish',{body:{}})).status,404);assert.equal(h.calls.length,0);});
 }finally{await db.dropDatabase();await client.close();}
});
