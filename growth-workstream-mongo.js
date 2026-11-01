'use strict';
// Dedicated isolated Mongo collection persistence for workstream results.
// Caller supplies an already-authorized test collection. No production access.
const {executeWorkstreams}=require('./growth-workstream-executor');
function createWorkstreamPersistence(collection,{testMode=false}={}){
 if(!testMode||!collection||typeof collection.updateOne!=='function'||typeof collection.createIndex!=='function')throw Error('Isolated test collection required');
 return {
  init:()=>collection.createIndex({runId:1,workstreamId:1},{unique:true}),
  persist:async(runId,record)=>{
   if(!/^[-a-zA-Z0-9_]{1,80}$/.test(runId))throw Error('Invalid run ID');
   if(!record||typeof record.workstreamId!=='string'||record.mode!=='isolated')throw Error('Invalid isolated result');
   await collection.updateOne({runId,workstreamId:record.workstreamId},{$setOnInsert:{...record,runId,createdAt:new Date().toISOString()}},{upsert:true});
  }
 };
}
async function runIsolatedWorkstreams({collection,testMode=false,runId,adapters,capacity=5,workstreams,signal}={}){
 const store=createWorkstreamPersistence(collection,{testMode});
 await store.init();
 return executeWorkstreams({adapters,capacity,workstreams,signal,persist:r=>store.persist(runId,r)});
}
module.exports={createWorkstreamPersistence,runIsolatedWorkstreams};
