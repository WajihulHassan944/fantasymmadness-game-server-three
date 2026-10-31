'use strict';
// One-shot isolated scheduler entry point for an external cron runner.
// Explicitly refuses production, outbound activity and non-test databases.
const {MongoClient}=require('mongodb');
const {createIsolatedWorkstreamScheduler}=require('./growth-workstream-scheduler');
const {createDraftAdapters}=require('./growth-workstream-draft-adapters');
async function runIsolatedCronOnce({env=process.env,connect,adapters,clock}={}){
 if(env.GROWTH_STAGING_MODE!=='isolated'||env.GROWTH_OUTBOUND_ENABLED!=='false')throw Error('Isolated mode with outbound disabled required');
 if(env.GROWTH_CRON_ENABLED!=='true')throw Error('Explicit isolated cron opt-in required');
 if(env.GROWTH_ATLAS_STORE_ID!=='store_5mRLkf9U8eKGIaaO')throw Error('Dedicated Atlas store ID required');
 if(env.GROWTH_CRON_DB!=='fmgrowthtest')throw Error('Dedicated test database required');
 if(!/^mongodb\+srv:\/\//.test(env.GROWTH_TEST_ATLAS_URI||''))throw Error('Dedicated Atlas test URI required');
 const client=connect?await connect(env.GROWTH_TEST_ATLAS_URI):new MongoClient(env.GROWTH_TEST_ATLAS_URI,{serverSelectionTimeoutMS:10000});
 try{
  await client.connect();
  const collection=client.db('fmgrowthtest').collection('isolated_workstream_runs');
  const scheduler=createIsolatedWorkstreamScheduler({collection,testMode:true,adapters:adapters||createDraftAdapters(),clock});
  const result=await scheduler.tick();
  return {completed:result.completed,errors:result.errors,skipped:result.skipped.length,mode:'isolated',outboundActions:0};
 }finally{await client.close();}
}
if(require.main===module)runIsolatedCronOnce().then(x=>{console.log(JSON.stringify(x));if(x.errors.length)process.exitCode=1}).catch(()=>{console.error('Isolated cron failed; configuration or connectivity not verified');process.exitCode=1});
module.exports={runIsolatedCronOnce};
