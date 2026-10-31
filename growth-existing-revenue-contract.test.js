'use strict';
// Tests the EXISTING revenue route in isolation, not a replacement endpoint.
// Demonstrates that public analytics events cannot be trusted as settled payments.
const assert=require('node:assert/strict');
const express=require('express');
const {registerRevenueAnalyticsRoutes}=require('./revenue-analytics');
(async()=>{
 const events=[];
 class Schema { constructor(){ } index(){} }
 Schema.Types={Mixed:class Mixed{}};
 const mongoose={
  Schema,
  models:{},
  model(name){return {create:async doc=>{events.push(doc);return doc;}};}
 };
 const app=express();app.use(express.json());
 registerRevenueAnalyticsRoutes({app,mongoose,verifyAdminToken:(_req,_res,next)=>next()});
 const server=app.listen(0,'127.0.0.1');
 try {
  await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const response=await fetch(base+'/api/revenue/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event:'paid_entry',fightId:'synthetic-fight',affiliateRef:'synthetic-affiliate',entryFee:500})});
  assert.equal(response.status,202);
  assert.equal(events.length,1);
  assert.equal(events[0].event,'paid_entry');
  assert.equal(events[0].affiliateRef,'synthetic-affiliate');
  // This is an expected SECURITY GAP: no verified payment or authenticated player required.
  // The test is a contract audit, not a passing assertion of production payment integrity.
  console.log('CONFIRMED GAP: existing public /api/revenue/events accepts unverified paid_entry analytics; never use as settled payment or affiliate commission source');
 } finally {await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
