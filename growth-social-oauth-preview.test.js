'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('crypto');
const {MongoClient}=require('mongodb');const {createPreviewApp}=require('./growth-social-oauth-preview');
const uri=process.env.GROWTH_TEST_MONGO_URI;
test('Preview entry point connects only to fmgrowthtest and rejects legacy/scheduler/publishing routes',{skip:!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri||'')},async()=>{
 const client=await new MongoClient(uri).connect();const app=createPreviewApp({env:{GROWTH_STAGING_MODE:'isolated',GROWTH_TEST_MONGO_URI:uri,JWT_SECRET_ADMIN:crypto.randomBytes(32).toString('hex'),GROWTH_SOCIAL_OAUTH_ENABLED:'true',GROWTH_SOCIAL_TOKEN_KEY:crypto.randomBytes(32).toString('base64'),GROWTH_SOCIAL_PUBLIC_ORIGIN:'https://growth-preview.example.test',GROWTH_DELIVERY_PROVIDER:'none',GROWTH_OUTBOUND_ENABLED:'false'},connect:async()=>client});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 try{const r=await fetch(base+'/api/growth/health'),j=await r.json();assert.equal(r.status,200,JSON.stringify(j));assert.equal(j.database.name,'fmgrowthtest');assert.equal(j.database.connected,true);assert.equal(j.publishingEnabled,false);
 for(const path of ['/users','/api/signup','/api/payments/webhook','/api/growth/cron/tick','/api/growth/admin/run-now','/api/growth/social/tiktok/publish'])assert.equal((await fetch(base+path)).status,404,path);
 assert.equal((await fetch(base+'/api/growth/social/connections')).status,401);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await client.close();}
});

test('the Vercel bootstrap selects OAuth Preview before requiring any legacy module',()=>{
 const fs=require('node:fs'),vm=require('node:vm');const loaded=[];const preview={isolated:true};const output={exports:{}};
 vm.runInNewContext(fs.readFileSync(require.resolve('./full-card-bootstrap'),'utf8'),{module:output,process:{env:{GROWTH_SOCIAL_OAUTH_ENABLED:'true',VERCEL_ENV:'preview',VERCEL_PROJECT_ID:require('./growth-runtime-config').ISOLATED_PROJECT_ID}},require(name){loaded.push(name);if(name==='./growth-runtime-config')return require('./growth-runtime-config');if(name==='./growth-social-oauth-preview')return preview;throw Error('Legacy module was loaded: '+name);}});
 assert.equal(output.exports,preview);assert.deepEqual(loaded,['./growth-runtime-config','./growth-social-oauth-preview']);
});
