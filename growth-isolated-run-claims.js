'use strict';
// Distributed run claim for isolated cron invocations. One immutable claim per
// scheduled minute, before executing any workstreams. Never auto-retry a claimed
// minute: an uncertain result requires explicit operator inspection.
function createIsolatedRunClaims(collection,{testMode=false}={}){
 if(testMode!==true||!collection||typeof collection.createIndex!=='function'||typeof collection.updateOne!=='function')throw Error('Dedicated isolated run claims collection required');
 return {
  init:()=>collection.createIndex({runId:1},{unique:true}),
  async claim(runId){
   if(typeof runId!=='string'||!/^growth_[0-9]{12}$/.test(runId))throw Error('Invalid scheduled run ID');
   const r=await collection.updateOne({runId},{$setOnInsert:{runId,mode:'isolated',state:'claimed',createdAt:new Date().toISOString()}},{upsert:true});
   return r?.upsertedCount===1;
  },
  async complete(runId,summary){
   if(!summary||!Number.isInteger(summary.completed)||!Array.isArray(summary.errors))throw Error('Invalid run summary');
   await collection.updateOne({runId,state:'claimed'},{$set:{state:summary.errors.length?'failed':'completed',completed:summary.completed,errorCount:summary.errors.length,finishedAt:new Date().toISOString()}},{upsert:false});
  }
 };
}
module.exports={createIsolatedRunClaims};
