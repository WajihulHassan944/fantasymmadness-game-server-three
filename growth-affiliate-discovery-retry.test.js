'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{MongoClient}=require('mongodb');
const {createRecruitment}=require('./growth-affiliate-recruitment');
const uri=process.env.GROWTH_TEST_MONGO_URI,skip=!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri||'');
test('a discovery outage is isolated, rotates sports, backs off durably, sanitizes errors and closes only on actual recovery',{skip},async()=>{
 const client=await new MongoClient(uri).connect(),db=client.db('fmgrowthtest'),prefix='retry_'+crypto.randomBytes(6).toString('hex')+'_',col=Object.fromEntries(['recruitment','settings','drafts','affiliates','alerts'].map(k=>[k,db.collection(prefix+k)]));let now=new Date(),network=0,failing=true;
 const make=()=>createRecruitment({col,clock:()=>now,fetchImpl:async url=>{network++;if(failing)throw Error('PRIVATE_PROVIDER_RESPONSE_TOKEN');return{ok:true,json:async()=>({search:[]}),text:async()=>'<html>Affiliate</html>'};}});
 try{
  const first=await make().tick();assert.equal(first.error,undefined);assert.equal(first.discoveryStatus,'held');assert.equal(first.sourceWarning,'public_discovery_temporarily_unavailable');assert.equal(first.sourceHolds,1);const key='affiliate-discovery-retry:boxing:fighter';const saved=await col.settings.findOne({_id:key});assert.equal(saved.failures,1);assert.equal(Date.parse(saved.nextRetryAt)-+now,900000);assert.equal((await col.settings.findOne({_id:'affiliate-discovery-cursor'})).cursor,1);assert.equal(await col.drafts.countDocuments(),0);
  // Recreate the process and revisit the same slot before its due time: zero network.
  await col.settings.updateOne({_id:'affiliate-discovery-cursor'},{$set:{cursor:0}});const before=network;const backoff=await make().tick();assert.equal(backoff.discoveryStatus,'backoff');assert.equal(network,before);assert.equal((await col.alerts.findOne({alertKey:key})).state,'open');
  const second=await make().tick();assert.equal(second.sport,'mma-ufc');assert.equal(second.discoveryStatus,'held');assert.equal((await col.settings.findOne({_id:key})).failures,1);
  await col.settings.updateOne({_id:'affiliate-discovery-cursor'},{$set:{cursor:0}});now=new Date(+now+900000);await make().tick();assert.equal((await col.settings.findOne({_id:key})).failures,2);assert.equal(Date.parse((await col.settings.findOne({_id:key})).nextRetryAt)-+now,1800000);
  failing=false;now=new Date(+now+1800000);await col.settings.updateOne({_id:'affiliate-discovery-cursor'},{$set:{cursor:0}});assert.equal((await make().tick()).discoveryStatus,'verified');assert.equal((await col.settings.findOne({_id:key})).failures,0);assert.equal((await col.alerts.findOne({alertKey:key})).state,'acknowledged');assert.equal(await col.alerts.countDocuments({state:'open'}),1,'unrelated source warning must stay open');assert.equal(JSON.stringify(await col.alerts.find({}).toArray()).includes('PRIVATE_PROVIDER'),false);
 }finally{for(const c of Object.values(col))await c.drop().catch(()=>{});await client.close();}
});
