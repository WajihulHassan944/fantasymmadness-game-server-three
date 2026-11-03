'use strict';
// Failure alerts for the isolated Growth Engine scheduler.
// Turns failed runs and exhausted jobs into ONE owner alert per failure,
// delivered through the injected sandbox transport only (loopback recipients).
// Alerts are recorded in a dedicated collection so a restart never re-alerts.
function createFailureAlerts({collection,transport,owner='growth-owner@localhost',from='growth-alerts@localhost',testMode=false}={}){
 if(testMode!==true)throw Error('Isolated test mode required');
 if(!collection||typeof collection.updateOne!=='function'||typeof collection.createIndex!=='function')throw Error('Dedicated alert collection required');
 if(!transport||typeof transport.sendMail!=='function')throw Error('Sandbox transport required');
 if(!/^[^@\s]+@localhost$/.test(owner)||!/^[^@\s]+@localhost$/.test(from))throw Error('Loopback alert addresses required');
 const clean=s=>String(s||'').replace(/[\r\n\x00-\x1f]/g,' ').slice(0,200);
 async function init(){await collection.createIndex({alertKey:1},{unique:true});}
 // failures: [{key, kind:'run'|'job', id, error}]
 async function notify(failures=[],{now=new Date()}={}){
  if(!Array.isArray(failures))throw Error('Failure list required');
  const sent=[],suppressed=[];
  for(const f of failures){
   const key=clean(f?.key);
   if(!key){suppressed.push({key:null,reason:'invalid'});continue;}
   const claim=await collection.updateOne({alertKey:key},{$setOnInsert:{alertKey:key,kind:clean(f.kind),id:clean(f.id),error:clean(f.error),state:'claimed',createdAt:now.toISOString()}},{upsert:true});
   if(claim.upsertedCount!==1){suppressed.push({key,reason:'already_alerted'});continue;}
   const info=await transport.sendMail({from,to:owner,subject:`[Growth Engine ALERT] ${clean(f.kind)} failed: ${clean(f.id)}`,
    text:`Isolated Growth Engine failure\n\nKind: ${clean(f.kind)}\nID: ${clean(f.id)}\nError: ${clean(f.error)}\nAt: ${now.toISOString()}\n\nNo outbound or production action was taken.`});
   await collection.updateOne({alertKey:key},{$set:{state:'sent',messageId:String(info?.messageId||'')}});
   sent.push({key,messageId:String(info?.messageId||'')});
  }
  return {sent,suppressed};
 }
 // Collect failures from scheduler results and the job store.
 function fromRun(runId,result){
  const out=[];
  if(result&&Array.isArray(result.errors))for(const e of result.errors)out.push({key:`run:${runId}:${e.id}`,kind:'workstream',id:`${runId} ${e.id}`,error:e.message});
  return out;
 }
 function fromJobs(jobs=[]){
  return jobs.filter(j=>j&&j.state==='failed').map(j=>({key:`job:${j.id}:failed`,kind:'job',id:j.id,error:j.lastError||'retries exhausted'}));
 }
 return {init,notify,fromRun,fromJobs};
}
module.exports={createFailureAlerts};
