'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createFailureAlerts}=require('./growth-failure-alerts');
function memoryCollection(){
 const rows=new Map();
 return {rows,createIndex:async()=>{},
  updateOne:async(filter,update,opts={})=>{
   const key=filter.alertKey;const exists=rows.has(key);
   if(!exists&&opts.upsert&&update.$setOnInsert){rows.set(key,{...update.$setOnInsert});return {upsertedCount:1,modifiedCount:0};}
   if(exists&&update.$set){Object.assign(rows.get(key),update.$set);return {upsertedCount:0,modifiedCount:1};}
   return {upsertedCount:0,modifiedCount:0};
  }};
}
test('one alert per failure, never repeated after restart',async()=>{
 const sent=[];const transport={sendMail:async(m)=>{sent.push(m);return {messageId:'<m'+sent.length+'@localhost>'};}};
 const collection=memoryCollection();
 const alerts=createFailureAlerts({collection,transport,testMode:true});
 await alerts.init();
 const failures=[...alerts.fromRun('growth_202611011200',{errors:[{id:'boxing:marketing',message:'boom'}]}),...alerts.fromJobs([{id:'j1',state:'failed',lastError:'x'},{id:'j2',state:'completed'}])];
 assert.equal(failures.length,2);
 const first=await alerts.notify(failures);
 assert.equal(first.sent.length,2);
 const again=createFailureAlerts({collection,transport,testMode:true});
 const second=await again.notify(failures);
 assert.equal(second.sent.length,0);
 assert.equal(second.suppressed.every(s=>s.reason==='already_alerted'),true);
 assert.equal(sent.length,2);
 assert.match(sent[0].subject,/Growth Engine ALERT/);
 assert.equal(sent.every(m=>m.to==='growth-owner@localhost'),true);
});
test('refuses non-test mode and non-loopback recipients',()=>{
 const transport={sendMail:async()=>({})};
 assert.throws(()=>createFailureAlerts({collection:memoryCollection(),transport}),/test mode/);
 assert.throws(()=>createFailureAlerts({collection:memoryCollection(),transport,testMode:true,owner:'kelly@example.com'}),/Loopback/);
});
