'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runIsolatedWorkstreams}=require('./growth-workstream-mongo');
const {planWorkstreams}=require('./growth-global-workstreams');
test('isolated workstream results are stored with run id and idempotent keys',async()=>{
 const records=new Map(),indexes=[];
 const collection={
  async createIndex(key,options){indexes.push({key,options});},
  async updateOne(key,update,options){
   assert.equal(options.upsert,true);
   const id=key.runId+':'+key.workstreamId;
   if(!records.has(id))records.set(id,update.$setOnInsert);
   return {upsertedCount:1};
  }
 };
 const opts={collection,testMode:true,runId:'synthetic-run-1',workstreams:planWorkstreams().slice(0,2),adapters:{audience:async()=>({count:2}),marketing:async()=>({drafts:1})}};
 const first=await runIsolatedWorkstreams(opts);
 const second=await runIsolatedWorkstreams(opts);
 assert.equal(first.completed,2);assert.equal(second.completed,2);
 assert.equal(records.size,2);assert.equal(indexes.length,2);
 assert([...records.values()].every(r=>r.mode==='isolated'&&r.runId==='synthetic-run-1'));
});
test('rejects non-test collection and invalid run IDs',async()=>{
 const collection={createIndex:async()=>{},updateOne:async()=>{}};
 await assert.rejects(()=>runIsolatedWorkstreams({collection,runId:'a'}),/Isolated test/);
 const r=await runIsolatedWorkstreams({collection,testMode:true,runId:'invalid run',workstreams:planWorkstreams().slice(0,1),adapters:{audience:async()=>({})}});
 assert.equal(r.completed,0);assert.equal(r.errors.length,1);
});
