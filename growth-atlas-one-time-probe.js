'use strict';
// One-time Atlas staging read/write/delete verification. Never run from an HTTP
// endpoint or cron. Requires operator-confirmed isolated Atlas resource and
// a direct, temporary shell invocation with an explicitly supplied URI.
// The test never prints the URI or other credentials.
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {MongoClient}=require('mongodb');
async function main(env=process.env){
 if(env.GROWTH_STAGING_MODE!=='isolated')throw Error('Staging mode not isolated');
 if(env.GROWTH_OUTBOUND_ENABLED!=='false')throw Error('Outbound must be explicitly disabled');
 if(env.GROWTH_ATLAS_STORE_ID!=='store_5mRLkf9U8eKGIaaO')throw Error('Dedicated fmgrowthtest resource not attested');
 if(env.GROWTH_ATLAS_PROBE_APPROVED!=='true')throw Error('One-time test approval required');
 const uri=env.GROWTH_TEST_ATLAS_URI;
 if(!uri||!/^mongodb\+srv:\/\//.test(uri))throw Error('Explicit Atlas test URI required');
 const dbName='fmgrowthtest_probe_'+randomUUID().replace(/-/g,'');
 const client=new MongoClient(uri,{serverSelectionTimeoutMS:10000});
 let created=false;
 try{
  await client.connect();
  // Test is confined to a new random database, never an application collection.
  const db=client.db(dbName);
  const col=db.collection('synthetic_probe');
  const id=randomUUID();
  await col.insertOne({_id:id,kind:'synthetic_growth_probe',createdAt:new Date()});
  created=true;
  const read=await col.findOne({_id:id});
  assert.equal(read.kind,'synthetic_growth_probe');
  assert.equal(await col.deleteOne({_id:id}).then(x=>x.deletedCount),1);
  assert.equal(await col.countDocuments({}),0);
  console.log('PASS Atlas synthetic insert/read/delete; record count 0; no outbound actions');
 }finally{
  try{if(created)await client.db(dbName).dropDatabase();}finally{await client.close();}
 }
}
if(require.main===module)main().catch(e=>{console.error('Atlas probe failed:',e.message);process.exitCode=1});
module.exports={main};
