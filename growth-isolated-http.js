'use strict';
// Isolated test-only HTTP adapter. Never mounted into production Express app.
const express=require('express');
const {createRecruit,makeLink,verifyPaidEntry,report}=require('./growth-affiliate-attribution');
function createTestApp({testMode=false}={}){
 if(!testMode)throw new Error('Explicit isolated test mode required');
 const app=express();app.use(express.json({limit:'16kb'}));
 const affiliates=new Map(),entries=new Map();
 app.post('/test/affiliates',(req,res)=>{
  try {
   const a=createRecruit(req.body||{});
   if(affiliates.has(a.id))return res.status(409).json({error:'duplicate_affiliate'});
   affiliates.set(a.id,a);return res.status(201).json(a);
  }catch(e){return res.status(400).json({error:e.message});}
 });
 app.get('/test/affiliates/:id/link/:fightId',(req,res)=>{
  try {
   const a=affiliates.get(req.params.id);
   return res.json({url:makeLink(a,req.params.fightId)});
  }catch(e){return res.status(403).json({error:e.message});}
 });
 app.post('/test/paid-entry-events',(req,res)=>{
  const outcome=verifyPaidEntry(req.body,{affiliates,entries});
  return res.status(outcome.credited?201:422).json(outcome);
 });
 app.get('/test/revenue',(req,res)=>res.json(report(entries)));
 return app;
}
module.exports={createTestApp};
