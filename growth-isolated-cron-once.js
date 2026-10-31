'use strict';
// One-shot isolated scheduler entry point for an external cron runner.
// Explicitly refuses production, outbound activity and non-test databases.
const {MongoClient}=require('mongodb');
const {createIsolatedWorkstreamScheduler}=require('./growth-workstream-scheduler');
const {createDraftAdapters}=require('./growth-workstream-draft-adapters');
const {createIsolatedRunClaims}=require('./growth-isolated-run-claims');
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
  const now=clock?clock():new Date();
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw Error('Invalid clock');
  const runId='growth_'+now.toISOString().replace(/[^0-9]/g,'').slice(0,12);
  const claims=createIsolatedRunClaims(client.db('fmgrowthtest').collection('isolated_run_claims'),{testMode:true});
  await claims.init();
  if(!await claims.claim(runId))return {completed:0,errors:[],skipped:25,mode:'isolated',outboundActions:0,alreadyClaimed:true};
  const scheduler=createIsolatedWorkstreamScheduler({collection,testMode:true,adapters:adapters||createDraftAdapters(),clock:()=>now});
  const result=await scheduler.tick();
  await claims.complete(runId,result);
  return {completed:result.completed,errors:result.errors,skipped:result.skipped.length,mode:'isolated',outboundActions:0};
 }finally{await client.close();}
}
if(require.main===module)runIsolatedCronOnce().then(x=>{console.log(JSON.stringify(x));if(x.errors.length)process.exitCode=1}).catch(()=>{console.error('Isolated cron failed; configuration or connectivity not verified');process.exitCode=1});
module.exports={runIsolatedCronOnce};
