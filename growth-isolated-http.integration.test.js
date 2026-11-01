'use strict';
const assert=require('node:assert/strict');
const {createTestApp}=require('./growth-isolated-http');
(async()=>{
 assert.throws(()=>createTestApp(),/isolated/);
 const app=createTestApp({testMode:true});
 const server=app.listen(0,'127.0.0.1');
 try{
  await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const req=async(path,method='GET',body)=>{const r=await fetch(base+path,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
  let r=await req('/test/affiliates','POST',{id:'a1',name:'Kelise Davis',approved:false,consent:true});
  assert.equal(r.status,201);assert.equal(r.data.status,'pending');
  assert.equal((await req('/test/affiliates/a1/link/fight-1')).status,403);
  r=await req('/test/affiliates','POST',{id:'a2',name:'Test Fighter',approved:true,consent:true});
  assert.equal(r.status,201);
  r=await req('/test/affiliates/a2/link/fight-1');assert.equal(r.data.url,'/affiliate/test-fighter?fight=fight-1');
  const entry={type:'paid_entry',verified:true,paymentStatus:'settled',entryId:'e1',playerId:'p1',fightId:'fight-1',affiliateId:'a2',referralAffiliateId:'a2',amountCents:500};
  assert.equal((await req('/test/paid-entry-events','POST',{...entry,verified:false})).status,422);
  assert.equal((await req('/test/paid-entry-events','POST',entry)).status,201);
  assert.equal((await req('/test/paid-entry-events','POST',entry)).status,422);
  assert.deepEqual((await req('/test/revenue')).data,{a2:{paidEntries:1,revenueCents:500}});
  console.log('PASS isolated HTTP recruitment -> approval gate -> clean link -> rejected unverified entry -> credited settled entry -> duplicate rejection -> revenue');
 }finally{await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
