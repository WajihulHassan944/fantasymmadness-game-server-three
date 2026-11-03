'use strict';
const assert = require('node:assert/strict');
const { createStore, LEASE_MS } = require('./growth-unattended-store');
const t=Date.parse('2026-11-01T12:00:00Z');
const rows=new Map(); const indexes=[];
const matches=(r,q)=>Object.entries(q).every(([k,v])=>{
 if(k==='$or')return v.some(x=>matches(r,x));
 if(v && typeof v==='object' && !Array.isArray(v))return Object.entries(v).every(([op,x])=>op==='$in'?x.includes(r[k]):op==='$lte'?r[k]<=x:op==='$lt'?r[k]<x:op==='$gt'?r[k]>x:false);
 return r[k]===v;
});
const collection={
 async createIndex(keys,options){indexes.push({keys,options});},
 async updateOne(query,update,options={}){
  let r=[...rows.values()].find(x=>matches(x,query));
  if(!r && options.upsert){r={...update.$setOnInsert};rows.set(r.id,r);return {modifiedCount:0,upsertedCount:1};}
  if(!r)return {modifiedCount:0};
  if(update.$set)Object.assign(r,update.$set);
  if(update.$inc)for(const [k,v] of Object.entries(update.$inc))r[k]=(r[k]||0)+v;
  return {modifiedCount:1};
 },
 async findOne(q){return rows.get(q.id)||null;},
 async findOneAndUpdate(query,update){
  const r=[...rows.values()].filter(x=>matches(x,query)).sort((a,b)=>a.dueAt.localeCompare(b.dueAt))[0];
  if(!r)return null;
  Object.assign(r,update.$set);
  for(const [k,v] of Object.entries(update.$inc))r[k]=(r[k]||0)+v;
  return {...r};
 },
 aggregate(){return {toArray:async()=>Object.entries([...rows.values()].reduce((a,r)=>(a[r.state]=(a[r.state]||0)+1,a),{})).map(([_id,count])=>({_id,count}))};}
};
(async()=>{
 assert.throws(()=>createStore(collection),/isolated test/);
 const store=createStore(collection,{testMode:true});await store.init();
 assert.equal(indexes.length,2);assert.equal(indexes[0].options.unique,true);
 const input={id:'campaign:one',type:'prepare_campaign',dueAt:new Date(t).toISOString()};
 await store.enqueue(input);await store.enqueue(input);assert.equal(rows.size,1,'enqueue idempotent');
 let j=await store.claim(t);assert.equal(j.attempts,1);assert.ok(j.leaseToken);
 assert.equal(await store.claim(t),null,'lease blocks second worker');
 await assert.rejects(()=>store.finish({...j,leaseToken:'wrong'},{success:true,now:t+1000}),/Lease expired/);
 await assert.rejects(()=>store.finish(j,{success:true,now:t+LEASE_MS+1}),/Lease expired/);
 j=await store.claim(t+LEASE_MS);assert.equal(j.attempts,2,'expired lease recovered');
 await store.finish(j,{success:false,error:'temporary',now:t+LEASE_MS+1000});
 assert.equal(rows.get(j.id).state,'retry');
 assert.equal(await store.claim(t+LEASE_MS+2000),null,'retry waits');
 const retryAt=Date.parse(rows.get(j.id).dueAt);
 j=await store.claim(retryAt);assert.equal(j.attempts,3);
 await store.finish(j,{success:false,error:'again',now:retryAt+1000});
 assert.equal(rows.get(j.id).state,'failed','exhausted retries terminal');
 assert.equal(await store.claim(retryAt+LEASE_MS*10),null);
 assert.deepEqual(await store.summary(),{failed:1});
 console.log('ok - persistent queue indexes, idempotent enqueue, atomic claim, fencing, lease recovery, backoff, terminal failure, reporting');
})().catch(e=>{console.error(e);process.exitCode=1;});
