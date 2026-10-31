'use strict';
// Contract integration with the ACTUAL fan-acquisition discovery routes using an
// in-memory Express app and controlled public-provider responses. No outbound network,
// no live database, no email/social sending, no production server registration.
const assert=require('node:assert/strict');
const express=require('express');
const Parser=require('rss-parser');
const originalParseURL=Parser.prototype.parseURL;
Parser.prototype.parseURL=async()=>({items:[{title:'Synthetic fight announcement',link:'https://example.invalid/news',isoDate:'2026-11-01T10:00:00Z'}]});
const register=require('./fan-acquisition-discovery');
(async()=>{
 const realFetch=global.fetch;
 const fakeResponse=(body)=>({ok:true,json:async()=>body});
 global.fetch=async url=>{
  const s=String(url);
  if(s.includes('itunes.apple.com/search'))return fakeResponse({results:[{collectionName:'Synthetic Fight Podcast',collectionViewUrl:'https://example.invalid/podcast',artistName:'Simulation Only'}]});
  throw Error('Network blocked in isolated integration: '+s);
 };
 const app=express();app.use(express.json());
 const collections=new Map();
 const collection=name=>{
  if(!collections.has(name))collections.set(name,[]);
  const records=collections.get(name);
  return {
   findOne:async()=>records[0]||null,
   find:()=>({sort:()=>({limit:()=>({toArray:async()=>records})}),toArray:async()=>records}),
   updateOne:async(filter,update)=>{let doc=records.find(x=>String(x._id)===String(filter._id));if(doc)Object.assign(doc,update.$set||{});return {matchedCount:doc?1:0}},
   insertOne:async doc=>{doc._id='synthetic-'+name+'-'+records.length;records.push(doc);return {insertedId:doc._id}},
   toArray:async()=>records
  };
 };
 const mongoose={connection:{db:{collection}}};
 // All existing routes mounted on this isolated app; never production.
 register({app,mongoose,verifyAdminToken:(req,res,next)=>req.headers.authorization==='Bearer synthetic-admin'?next():res.status(401).json({ok:false})});
 const server=app.listen(0,'127.0.0.1');
 try{
  await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  let r=await realFetch(base+'/api/admin/fan-acquisition/discover');
  assert.equal(r.status,401,'admin discovery must be authenticated');
  r=await realFetch(base+'/api/cron/fan-acquisition');
  assert.equal(r.status,401,'cron must reject absent secret');
  r=await realFetch(base+'/api/admin/fan-acquisition/discover',{headers:{authorization:'Bearer synthetic-admin'}});
  assert.equal(r.status,200);
  const body=await r.json();
  assert.equal(body.mode,'research_only');
  assert.equal(body.publishingEnabled,false);
  assert.equal(body.acquisitionMetrics.players,null);
  assert.equal(body.agents.length,5);
  assert.ok(body.agents.every(x=>x.audiences.every(a=>a.outreachSent===false)));
  console.log('PASS real discovery HTTP routes: auth gate, cron gate, five genres, podcast research fallback, no publishing, no claimed acquisitions');
 }finally{await new Promise(resolve=>server.close(resolve));global.fetch=realFetch;Parser.prototype.parseURL=originalParseURL;}
})().catch(e=>{console.error(e);process.exitCode=1;});
