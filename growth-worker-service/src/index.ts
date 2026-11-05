import express from 'express';
import {start} from 'workflow/api';
import {HookConflictError} from 'workflow/errors';
import {sandboxLoop} from '../workflows/sandbox';
import worker from './runtime.cjs';
const app=express();app.disable('x-powered-by');
app.get('/health',async(_req,res)=>{
 res.set('Cache-Control','no-store');
 try{
  const {settings,ensureRelease}=await worker.runtime();await ensureRelease();const s=await settings.findOne({_id:'managed-scheduler'});
  if(s?.enabled){try{await start(sandboxLoop,[s.generation,0],{experimental_hook:{token:`growth:${s.generation}:0`}});}catch(e){if(!HookConflictError.is(e))throw e;}}
  res.json({ok:true,environment:'preview',database:'fmgrowthtest',collectionPrefix:'preview198_',scheduler:await worker.status()});
 }catch{res.status(503).json({ok:false,error:'managed_scheduler_unavailable',publishingEnabled:false,outboundEnabled:false});}
});
app.use((_req,res)=>res.status(404).json({ok:false}));
export default app;
