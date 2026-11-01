'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {executeWorkstreams}=require('./growth-workstream-executor');
const {planWorkstreams}=require('./growth-global-workstreams');
test('25 workstreams execute with authorized adapters and persisted results',async()=>{
 const saved=[];
 const adapters=Object.fromEntries(['audience','marketing','public-relations','affiliate-recruitment','performance'].map(k=>[k,async({genre,mode})=>({genre,mode})]));
 const r=await executeWorkstreams({adapters,persist:async x=>saved.push(x),capacity:4});
 assert.equal(r.configured,25);assert.equal(r.completed,25);assert.equal(saved.length,25);
 assert.equal(r.outboundActions,0);assert(saved.every(x=>x.mode==='isolated'));
});
test('missing adapters never execute, failures do not stop other workstreams',async()=>{
 const r=await executeWorkstreams({workstreams:planWorkstreams().slice(0,3),adapters:{audience:async()=>{throw Error('offline')},marketing:async()=>({ok:true})},persist:async()=>{}});
 assert.equal(r.errors.length,1);assert.equal(r.completed,1);assert.equal(r.skipped.length,1);
});
test('persistence failure is reported, never counted as completed',async()=>{
 const r=await executeWorkstreams({workstreams:planWorkstreams().slice(0,1),adapters:{audience:async()=>({ok:true})},persist:async()=>{throw Error('storage unavailable')}});
 assert.equal(r.completed,0);assert.equal(r.errors.length,1);
});
test('rejects unbounded concurrency and missing persistence',async()=>{
 await assert.rejects(()=>executeWorkstreams({capacity:0,persist:async()=>{}}),/capacity/);
 await assert.rejects(()=>executeWorkstreams({}),/Persistent/);
});
