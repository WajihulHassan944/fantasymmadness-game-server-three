'use strict';
// Isolated workstream scheduling adapter. Caller owns the actual timer/cron.
// This file never starts a production timer or opens a database connection.
const {runIsolatedWorkstreams}=require('./growth-workstream-mongo');
function createIsolatedWorkstreamScheduler({collection,testMode=false,adapters={},capacity=5,clock=()=>new Date(),workstreams}={}){
 if(testMode!==true)throw Error('Isolated test mode required');
 if(!collection||typeof collection.updateOne!=='function')throw Error('Dedicated test collection required');
 if(typeof clock!=='function')throw Error('Clock required');
 let running=false;
 async function tick(){
  if(running)return {skipped:true,reason:'previous_run_in_progress'};
  running=true;
  try{
   const now=clock();
   if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw Error('Invalid clock');
   const runId='growth_'+now.toISOString().replace(/[^0-9]/g,'').slice(0,12);
   return await runIsolatedWorkstreams({collection,testMode:true,runId,adapters,capacity,workstreams});
  }finally{running=false;}
 }
 return {tick,isRunning:()=>running};
}
module.exports={createIsolatedWorkstreamScheduler};
