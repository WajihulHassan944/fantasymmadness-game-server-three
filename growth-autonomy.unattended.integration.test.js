'use strict';
// REAL local MongoDB + HTTP runtime + independent timer processes. External
// discovery/art sources and publishing providers are explicitly sandbox fixtures.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');const express=require('express'),sharp=require('sharp'),{MongoClient}=require('mongodb');
const {registerIsolatedGrowthRoutes}=require('./growth-isolated-routes'),{signConsoleToken,consolePasswordVersion}=require('./growth-console-token');
const {contestFeed}=require('./growth-contest-feed.fixture'),{researchWeb}=require('./growth-podcast-research.fixture'),{defaults}=require('./growth-autonomy');
const uri=process.env.GROWTH_TEST_MONGO_URI;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=90000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await delay(100);}throw Error('unattended condition timed out');}
test('unattended three-department sandbox operation, process restart, durable recovery, owner-only control and emergency stop',{skip:!/^mongodb:\/\/(127\.0\.0\.1|localhost):27017/.test(uri||''),timeout:200000},async()=>{
 const started=new Date(),owner='owner@fixture.invalid',secret=crypto.randomBytes(32).toString('hex'),cron=crypto.randomBytes(24).toString('hex');
 const client=await new MongoClient(uri).connect(),physical=client.db('fmgrowthtest'),prefix='autonomous198_'+crypto.randomUUID().replaceAll('-','')+'_';
 const database={databaseName:'fmgrowthtest',collection:name=>physical.collection(prefix+name)};
 const art=await sharp({create:{width:900,height:1100,channels:3,background:'#8b1020'}}).jpeg().toBuffer();
 const feed=contestFeed(),research=researchWeb();const requests=[];let origin;const PUBLIC='https://growth198.test';
 const fetchImpl=async(url,opts)=>{
  const u=String(url);requests.push({url:u,method:opts?.method||'GET'});
  if(u.startsWith(PUBLIC))return fetch(u.replace(PUBLIC,origin),opts);
  const f=feed(u);if(f)return{...f,json:async()=>{const j=await f.json();for(const row of j.items)row.fightPosterImage='https://res.cloudinary.com/demo/image/upload/v1/isolated198.jpg';return j;}};
  if(u.startsWith('https://res.cloudinary.com/demo/image/upload/'))return{ok:true,status:200,headers:new Headers({'content-type':'image/jpeg'}),arrayBuffer:async()=>art};
  if(u.startsWith('https://www.fantasymmadness.com/fight/')||u.startsWith('https://www.fantasymmadness.com/pro-wrestling/'))return{ok:true,status:200,url:u};
  if(u.includes('/images/brand/'))return{ok:false,status:404,headers:new Headers()};
  const r=await research(u,opts);if(r)return r;
  throw Error('unexpected external fixture request');
 };
 const app=express(),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));origin=`http://127.0.0.1:${server.address().port}`;
 const env={GROWTH_STAGING_MODE:'isolated',GROWTH_OUTBOUND_ENABLED:'false',GROWTH_TEST_MONGO_URI:uri,JWT_SECRET_ADMIN:secret,GROWTH_UNSUBSCRIBE_SECRET:secret,CRON_SECRET:cron,GROWTH_DELIVERY_PROVIDER:'sandbox-capture',GROWTH_SOCIAL_PROVIDER:'sandbox',GROWTH_POSTERS:'on',GROWTH_POSTERS_PER_RUN:'20',GROWTH_PUBLIC_ORIGIN:PUBLIC,GROWTH_RESEARCH_PER_RUN:'10',GROWTH_ART_CLOUDINARY_CLOUDS:'demo',GROWTH_FIGHT_URL_DISCOVERY:'off',GROWTH_AUTOMATION_OWNER_IDS:owner};
 const mount=registerIsolatedGrowthRoutes({app,env,express,fetchImpl,connect:async()=>({connect:async()=>{},db:()=>database})});assert.equal(mount.mounted,true,JSON.stringify(mount.errors));
 const rt=await mount.getRuntime(),token=signConsoleToken(secret,{email:owner,pwv:consolePasswordVersion(env.GROWTH_ADMIN_PASSWORD_HASH)}),outsider=signConsoleToken(secret,{email:'other@fixture.invalid',pwv:consolePasswordVersion(env.GROWTH_ADMIN_PASSWORD_HASH)});
 const api=async(method,endpoint,body,credential=token)=>{const r=await fetch(origin+'/api/growth'+endpoint,{method,headers:{Authorization:'Bearer '+credential,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return{status:r.status,body:await r.json()};};
 const healthFile=path.join(os.tmpdir(),'growth-worker-198-'+crypto.randomUUID()+'.json'),logs=[];let child;
 const launch=()=>{const p=spawn(process.execPath,['growth-autonomous-worker.js'],{cwd:__dirname,env:{...process.env,GROWTH_WORKER_ENABLED:'true',GROWTH_STAGING_MODE:'isolated',GROWTH_OUTBOUND_ENABLED:'false',GROWTH_WORKER_LOOPBACK_TEST:'true',GROWTH_WORKER_ENGINE_URL:origin,GROWTH_WORKER_CRON_SECRET:cron,GROWTH_WORKER_INTERVAL_MS:'200',GROWTH_WORKER_ID:'unattended-198-fixture',GROWTH_WORKER_HEALTH_FILE:healthFile},stdio:['ignore','pipe','pipe']});p.stdout.on('data',b=>logs.push(b.toString()));p.stderr.on('data',b=>logs.push(b.toString()));return p;};
 const stop=async p=>{if(!p||p.exitCode!==null)return;p.kill('SIGTERM');await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('worker did not stop gracefully')),10000);p.once('exit',()=>{clearTimeout(timer);resolve();});});};
 try{
  assert.equal((await api('GET','/admin/autonomy',undefined,outsider)).status,403);
  assert.equal((await api('PUT','/admin/autonomy',{policy:defaults(),expectedVersion:0},outsider)).status,403);
  assert.equal((await api('POST','/admin/autonomy/stop',{},outsider)).status,403);
  const approved=await api('PUT','/admin/autonomy',{policy:{...defaults(),enabled:true,allowPublishedBusinessContacts:true,maxCampaignsPerDepartmentPerDay:20},expectedVersion:0});assert.equal(approved.status,200,JSON.stringify(approved));
  child=launch();
  await until(async()=>await rt.collections.runs.countDocuments({state:{$in:['completed','failed']}})>0,120000);
  assert.ok(await rt.collections.socialSandbox.countDocuments()>0, 'first autonomous cycle must produce a Marketing sandbox receipt');
  await until(async()=>{try{return JSON.parse(fs.readFileSync(healthFile)).ticks>=1;}catch{return false;}},120000);
  const emailKinds=await until(async()=>{const kinds=await rt.collections.drafts.distinct('kind',{status:'delivered',sandbox:true});return kinds.includes('pr')&&kinds.includes('affiliate')?kinds:null;},90000);assert.ok(emailKinds.includes('pr')&&emailKinds.includes('affiliate'),JSON.stringify(emailKinds));
  assert.equal((await rt.collections.drafts.distinct('genre',{kind:'marketing'})).length,5);
  const social=await rt.collections.social.find({status:'published',sandbox:true}).toArray();assert.ok(social.length>0,'marketing sandbox receipts');
  assert.ok(await rt.collections.posters.countDocuments()>0,'existing renderer generated poster assets');
  const before=await rt.collections.deliveries.countDocuments({status:'delivered'});
  await stop(child);
  // Persist a due task before restarting the independent process. The real
  // minute claim may delay it until the next wall-clock minute; no virtual clock.
  await rt.collections.jobs.insertOne({id:'issue198-restart-report',type:'aggregate_report',state:'pending',attempts:0,dueAt:new Date().toISOString(),createdAt:new Date().toISOString()});
  child=launch();await until(async()=>Boolean(await rt.collections.jobs.findOne({id:'issue198-restart-report',state:'completed'})),90000);
  assert.equal(await rt.collections.deliveries.countDocuments({status:'delivered'}),before,'restart never sends duplicates');
  const observed=await api('GET','/admin/autonomy');assert.ok(observed.body.heartbeat.observations>1);
  const stopped=await api('POST','/admin/autonomy/stop',{});assert.equal(stopped.status,200);assert.equal(stopped.body.policy.paused,true);
  const count=await rt.collections.runs.countDocuments();await delay(700);assert.equal(await rt.collections.runs.countDocuments(),count,'kill switch prevents new run claims');
  await stop(child);child=null;
  assert.equal(logs.join('').includes(cron),false);assert.equal(logs.join('').includes(secret),false);
  assert.ok((await rt.collections.sandboxMail.find({}).toArray()).every(m=>m.sent===false&&m.network===false));
  const implementationFiles=['growth-autonomy.js','growth-runtime.js','growth-social-scheduler.js','growth-autonomous-worker.js','growth-isolated-routes.js'];
  const receipt={scope:'local-sandbox-only',implementationSha256:Object.fromEntries(implementationFiles.map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,name))).digest('hex')])),startedAt:started.toISOString(),finishedAt:new Date().toISOString(),wallClockMilliseconds:Date.now()-started.getTime(),departments:{marketing:{posts:social.length},pr:{deliveredDrafts:await rt.collections.drafts.countDocuments({kind:'pr',sandbox:true,status:'delivered'})},affiliate:{deliveredDrafts:await rt.collections.drafts.countDocuments({kind:'affiliate',sandbox:true,status:'delivered'})}},sports:await rt.collections.drafts.distinct('genre',{kind:'marketing'}),posterAssets:await rt.collections.posters.countDocuments(),restartRecovery:true,duplicateEmailRejection:true,emergencyStop:true,unauthorizedOwnerRejected:true,realProviderReceipts:false,deployed24x7Observed:false};
  fs.writeFileSync(process.env.GROWTH_198_RECEIPT_PATH||path.join(os.tmpdir(),'growth198-unattended-receipt.json'),JSON.stringify(receipt,null,2));
 }catch(e){console.error('LOCAL FIXTURE DIAGNOSTICS',JSON.stringify({policyCycle:await rt.collections.settings.findOne({_id:'autonomy:lastCycle'}),social:await rt.collections.social.find({},{projection:{status:1,heldReason:1,lastError:1}}).limit(8).toArray(),runs:await rt.collections.runs.find({},{projection:{state:1,errorCount:1}}).toArray()}));throw e;}finally{await stop(child).catch(()=>{});await new Promise(r=>server.close(r));for(const c of await physical.listCollections({name:{$regex:'^'+prefix}}).toArray())await physical.collection(c.name).drop();await client.close();fs.rmSync(healthFile,{force:true});}
});
