'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),express=require('express');
const {MongoClient}=require('mongodb');
const {installGrowthSocialOAuth}=require('./growth-social-oauth-isolated');
const {signAssertion}=require('./growth-social-admin-sso');
const uri=process.env.GROWTH_TEST_MONGO_URI;
test('website administrator SSO issues Preview sessions with signature, expiry, replay and logout enforcement',{skip:!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri||'')},async()=>{
 const client=await new MongoClient(uri).connect(),db=client.db('fmgrowthtest');await db.dropDatabase();
 const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519'),site='https://fmm-ver2-fixture.vercel.app';
 const origin='https://growth-preview.example.test';const env={GROWTH_SOCIAL_PUBLIC_ORIGIN:origin,GROWTH_SOCIAL_TOKEN_KEY:crypto.randomBytes(32).toString('base64'),GROWTH_SOCIAL_SSO_PUBLIC_KEY:publicKey.export({type:'spki',format:'pem'}),GROWTH_SOCIAL_ADMIN_SITE_ORIGIN:site};
 let now=Date.now();const app=express();app.use(express.json());const router=express.Router();installGrowthSocialOAuth({router,env,db,adminSecret:crypto.randomBytes(48).toString('hex'),clock:()=>new Date(now)});app.use('/api/growth',router);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const claims=over=>({iss:'fmm-admin-site',aud:'fmm-growth-engine',purpose:'session',sub:'0123456789abcdef01234567',email:'fixture@example.test',site,jti:crypto.randomBytes(24).toString('base64url'),iat:Math.floor(now/1000),exp:Math.floor(now/1000)+60,adminExp:Math.floor(now/1000)+3600,verifiedBy:'live-admin-authority',...over});
 const call=async(path,body,headers={})=>{const r=await fetch(base+'/api/growth'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,json:await r.json()};};
 const exchange=assertion=>call('/admin/sso/assertion',{assertion});
 try{
  assert.equal((await call('/social/admin/login',{password:'any-guessed-password'})).status,403);
  const config=await call('/social/admin/sign-in');assert.equal(config.json.configured,true);assert.equal(config.json.url,site+'/administration/growth-connections');
  assert.equal((await call('/social/connections')).status,401);
  const assertion=signAssertion(privateKey,claims());assert.equal((await call('/admin/sso/assertion',{assertion},{Origin:site})).status,403);
  const login=await exchange(assertion);assert.equal(login.status,200);assert.ok(login.json.expiresAt<=now+1201000);
  const header={Authorization:'Bearer '+login.json.token};assert.equal((await call('/social/connections',null,header)).status,200);
  assert.equal((await exchange(assertion)).json.reason,'assertion_replayed');
  assert.equal((await exchange(signAssertion(crypto.generateKeyPairSync('ed25519').privateKey,claims()))).status,401);
  assert.equal((await exchange(signAssertion(privateKey,claims({site:'https://evil.test'})))).status,401);
  assert.equal((await exchange(signAssertion(privateKey,claims({iat:Math.floor(now/1000)-70,exp:Math.floor(now/1000)-10})))).json.reason,'assertion_expired');
  const rev=await call('/admin/sso/revoke',{assertion:signAssertion(privateKey,claims({purpose:'revoke'}))});assert.equal(rev.status,200);assert.equal((await call('/social/connections',null,header)).status,401);
  now+=2000;const second=await exchange(signAssertion(privateKey,claims()));assert.equal(second.status,200);assert.equal((await call('/social/connections',null,{Authorization:'Bearer '+second.json.token})).status,200);
  now+=1201000;assert.equal((await call('/social/connections',null,{Authorization:'Bearer '+second.json.token})).status,401);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await db.dropDatabase();await client.close();}
});
