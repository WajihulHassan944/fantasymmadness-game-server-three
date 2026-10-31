'use strict';
// One scheduled isolated campaign tick: execute workstreams, deliver explicitly
// approved localhost-only test mail, record receipts, and produce a safe report.
// The caller supplies a dedicated test collection and a loopback SMTP transport.
const {createIsolatedWorkstreamScheduler}=require('./growth-workstream-scheduler');
const {createSandboxMailSender}=require('./growth-approved-sandbox-mail');
const {recordSandboxReceipt,sandboxCampaignReport}=require('./growth-sandbox-receipt-reporting');
async function runScheduledSandboxCampaign({collection,testMode=false,adapters={},workstreams,transport,approvedDrafts=[],clock=()=>new Date()}={}){
 if(testMode!==true)throw Error('Isolated test mode required');
 if(!Array.isArray(approvedDrafts))throw Error('Draft batch required');
 const scheduler=createIsolatedWorkstreamScheduler({collection,testMode,adapters,workstreams,clock});
 const execution=await scheduler.tick();
 if(execution?.errors?.length||execution?.completed===0||execution?.aborted||execution?.skipped===true){
  return {execution,report:sandboxCampaignReport([]),receipts:[],blocked:approvedDrafts.map(d=>({id:d?.id||null,reason:'workstream_execution_not_verified'})),mode:'ISOLATED_SANDBOX_ONLY',realMessagesSent:0,productionWrites:0};
 }
 const send=createSandboxMailSender({transport});
 const receipts=[],blocked=[],seenDraftIds=new Set();
 for(const draft of approvedDrafts){
  if(!draft?.id||seenDraftIds.has(draft.id)){
   blocked.push({id:draft?.id||null,reason:'invalid_or_duplicate_draft'});
   continue;
  }
  seenDraftIds.add(draft.id);
  try{
   const delivery=await send({draft,approval:{draftId:draft?.id,ownerApproved:draft?.ownerApproved===true}});
   if(!delivery.ok){blocked.push({id:draft?.id||null,reason:delivery.reason});continue;}
   receipts.push(recordSandboxReceipt({draft,delivery,now:clock().toISOString()}));
  }catch(error){
   blocked.push({id:draft?.id||null,reason:'sandbox_delivery_failed'});
  }
 }
 return {execution,report:sandboxCampaignReport(receipts),receipts,blocked,mode:'ISOLATED_SANDBOX_ONLY',realMessagesSent:0,productionWrites:0};
}
module.exports={runScheduledSandboxCampaign};
