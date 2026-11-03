'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {createIsolatedWorkstreamScheduler}=require('./growth-workstream-scheduler');
const {planWorkstreams}=require('./growth-global-workstreams');
test('isolated scheduler tick saves a result and prevents overlap',async()=>{
 let release;
 const gate=new Promise(resolve=>release=resolve);
 const writes=[];
 const collection={createIndex:async()=>{},updateOne:async(key,update)=>{writes.push({key,update})}};
 const scheduler=createIsolatedWorkstreamScheduler({collection,testMode:true,clock:()=>new Date('2026-10-30T20:00:00Z'),workstreams:planWorkstreams().slice(0,1),adapters:{audience:async()=>{await gate;return {count:1}}}});
 const first=scheduler.tick();
 await Promise.resolve();await Promise.resolve();
 const overlapping=await scheduler.tick();
 assert.deepEqual(overlapping,{skipped:true,reason:'previous_run_in_progress'});
 release();
 const result=await first;
 assert.equal(result.completed,1);assert.equal(writes.length,1);
 assert.equal(writes[0].key.runId,'growth_202610302000');
 assert.equal(scheduler.isRunning(),false);
});
test('scheduler rejects non-isolated use',()=>{
 assert.throws(()=>createIsolatedWorkstreamScheduler({}),/Isolated/);
});
