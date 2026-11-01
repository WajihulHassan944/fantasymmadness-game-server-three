'use strict';
// Isolated workstream runner: execute authorized adapters, never publish/send/pay.
// Bounded parallelism, per-workstream error isolation, and durable-result hook.
const {planWorkstreams,distribute}=require('./growth-global-workstreams');
const clean=s=>String(s||'').slice(0,200);
async function executeWorkstreams({adapters={},persist,capacity=5,workstreams=planWorkstreams(),signal}={}){
 if(!Number.isInteger(capacity)||capacity<1||capacity>25)throw Error('Invalid capacity');
 if(typeof persist!=='function')throw Error('Persistent result adapter required');
 if(!Array.isArray(workstreams))throw Error('Workstreams must be an array');
 const seen=new Set(),results=[],errors=[],skipped=[];
 const eligible=[];
 for(const w of workstreams){
  if(!w||typeof w.id!=='string'||seen.has(w.id)){skipped.push({id:w?.id||null,reason:'invalid_or_duplicate'});continue;}
  seen.add(w.id);
  if(w.enabled!==true){skipped.push({id:w.id,reason:'disabled'});continue;}
  const handler=adapters[w.functionName];
  if(typeof handler!=='function'){skipped.push({id:w.id,reason:'adapter_not_configured'});continue;}
  eligible.push({w,handler});
 }
 for(const batch of distribute({workers:eligible,capacity})){
  if(signal?.aborted)break;
  await Promise.all(batch.map(async({w,handler})=>{
   if(signal?.aborted)return;
   try{
    const data=await handler({genre:w.genre,functionName:w.functionName,signal,mode:'isolated'});
    if(signal?.aborted)return;
    const record={workstreamId:w.id,genre:w.genre,functionName:w.functionName,mode:'isolated',data};
    await persist(record);
    results.push({id:w.id,persisted:true});
   }catch(e){errors.push({id:w.id,message:clean(e?.message)||'Execution failed'});}
  }));
 }
 return {configured:workstreams.length,attempted:results.length+errors.length,completed:results.length,results,errors,skipped,outboundActions:0,aborted:!!signal?.aborted};
}
module.exports={executeWorkstreams};
