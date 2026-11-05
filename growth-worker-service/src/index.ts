import express from 'express';
import {start} from 'workflow/api';
import {HookConflictError} from 'workflow/errors';
import {sandboxLoop} from '../workflows/sandbox';
import worker from './runtime.cjs';
import {affiliateLinkAudit} from '../workflows/link-audit';
import {affiliateStagingAcceptance} from '../workflows/affiliate-acceptance';
import {productionLaunchAudit} from '../workflows/production-launch-audit';
import production from './production-preparation.cjs';
import {productionPreparationLoop} from '../workflows/production-preparation';
import {activateVerifiedProductionPreparation,stopProductionPreparation,inspectProductionPreparation} from '../workflows/production-release';
import {createProductionPreparationApp} from '../shared/growth-production-preparation-http.js';
const app=express();app.disable('x-powered-by');
const productionControlAvailable=Boolean(activateVerifiedProductionPreparation&&stopProductionPreparation&&inspectProductionPreparation);
if(process.env.GROWTH_PREPARATION_MODE==='production_preparation'){app.use(createProductionPreparationApp({env:process.env,context:production.context,startScheduled:async(generation:string)=>{try{await start(productionPreparationLoop,[generation,0],{experimental_hook:{token:`production-preparation:${generation}:0`}});}catch(e){if(!HookConflictError.is(e))throw e;}}}));}
app.get('/health',async(_req,res)=>{
 res.set('Cache-Control','no-store');
 try{
  const {settings,ensureRelease}=await worker.runtime();await ensureRelease();const s=await settings.findOne({_id:'managed-scheduler'});
  if(s?.enabled&&(s.workerRelease||s.generation)===process.env.GROWTH_WORKER_RELEASE&&(!s.workerDeploymentId||s.workerDeploymentId===process.env.VERCEL_DEPLOYMENT_ID)){try{await start(sandboxLoop,[s.generation,0],{experimental_hook:{token:`growth:${s.generation}:0`}});}catch(e){if(!HookConflictError.is(e))throw e;}}
  res.json({ok:true,environment:'preview',database:'fmgrowthtest',collectionPrefix:'preview198_',readOnlyAuditAvailable:Boolean(affiliateLinkAudit),isolatedAcceptanceAvailable:Boolean(affiliateStagingAcceptance),productionReadinessAuditAvailable:Boolean(productionLaunchAudit),productionControlAvailable,scheduler:await worker.status()});
 }catch{res.status(503).json({ok:false,error:'managed_scheduler_unavailable',publishingEnabled:false,outboundEnabled:false});}
});
app.use((_req,res)=>res.status(404).json({ok:false}));
export default app;
