'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),express=require('express');
const {installGrowthSocialOAuth,requestedScopes}=require('./growth-social-oauth-isolated');
const {signConsoleToken,consolePasswordVersion}=require('./growth-social-oauth-token');
test('publishing scopes require explicit configuration and preserve identity and refresh scopes',()=>{
 assert.equal(requestedScopes('x'),'tweet.read users.read offline.access');
 assert.equal(requestedScopes('tiktok'),'user.info.basic');
 const e={GROWTH_SOCIAL_PUBLISHING_SCOPE_REQUEST_ENABLED:'true'};
 assert.equal(requestedScopes('x',e),'tweet.read users.read offline.access tweet.write');
 assert.equal(requestedScopes('tiktok',e),'user.info.basic video.publish');
});
test('real connect endpoints request publishing and reject partial grants without replacing saved connections',async()=>{
 for(const provider of ['x','tiktok']){
  const maps=new Map(),collection=n=>{if(!maps.has(n))maps.set(n,new Map());const rows=maps.get(n);return{createIndex:async()=>{},find:()=>({toArray:async()=>[...rows.values()]}),findOne:async q=>rows.get(q._id)||null,insertOne:async d=>rows.set(d._id,d),updateOne:async(q,u,o)=>{if(!rows.has(q._id)&&o?.upsert)rows.set(q._id,{_id:q._id,...u.$setOnInsert});return{};},findOneAndDelete:async q=>{const r=rows.get(q._id);if(!r||r.binding!==q.binding)return null;rows.delete(q._id);return r;}};};
  const saved={_id:provider,confirmed:true,generation:1,credentials:{fixture:'unchanged'}};collection('growth_social_accounts');maps.get('growth_social_accounts').set(provider,saved);
  const secret=crypto.randomBytes(48).toString('hex'),origin='https://growth-preview.example.test',passwordHash='fixture-password-hash';
  const env={GROWTH_SOCIAL_PUBLIC_ORIGIN:origin,GROWTH_SOCIAL_TOKEN_KEY:crypto.randomBytes(32).toString('base64'),GROWTH_X_CLIENT_ID:'fixture-x',GROWTH_X_CLIENT_SECRET:'fixture-secret',GROWTH_TIKTOK_CLIENT_KEY:'fixture-tiktok',GROWTH_TIKTOK_CLIENT_SECRET:'fixture-secret',GROWTH_SOCIAL_PASSWORD_LOGIN:'true',GROWTH_ADMIN_PASSWORD_HASH:passwordHash,GROWTH_SOCIAL_PROVIDER:'none',GROWTH_SOCIAL_PUBLISHING_SCOPE_REQUEST_ENABLED:'true'};
  const app=express();app.use(express.json());const router=express.Router();installGrowthSocialOAuth({router,env,db:{databaseName:'fmgrowthtest',collection},adminSecret:secret,fetchImpl:async()=>({ok:true,json:async()=>({access_token:'fixture-access-token',token_type:'Bearer',expires_in:7200,scope:provider==='x'?'users.read tweet.read offline.access':'user.info.basic'})})});app.use(router);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  try{
   const token=signConsoleToken(secret,{pwv:consolePasswordVersion(passwordHash),sid:'fixture-session'},{expiresIn:'20m'});
   const start=await fetch(base+'/social/'+provider+'/connect',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+token}});assert.equal(start.status,200);const data=await start.json(),url=new URL(data.authorizationUrl);
   assert.ok(url.searchParams.get('scope').split(' ').includes(provider==='x'?'tweet.write':'video.publish'));
   if(provider==='x')assert.equal(url.searchParams.get('code_challenge_method'),'S256');
   const cookie=start.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
   const response=await fetch(base+'/social/'+provider+'/callback?state='+url.searchParams.get('state')+'&code=fixture-code',{headers:{Cookie:cookie}});
   assert.equal(response.status,403);assert.match(await response.text(),/existing connection was preserved/i);assert.deepEqual(maps.get('growth_social_accounts').get(provider),saved);assert.equal(maps.get('growth_social_oauth_candidates')?.size||0,0);
  }finally{await new Promise(r=>server.close(r));}
 }
});
