'use strict';
// Sandbox delivery receipts feed reporting and follow-up decisions.
// A sandbox receipt is never proof of real-world delivery.
const {campaignMetrics,nextFollowup}=require('./growth-followup-reporting');
function recordSandboxReceipt({draft,delivery,now=new Date().toISOString()}={}){
 if(!draft?.id||delivery?.ok!==true||delivery.receipt?.draftId!==draft.id||delivery.receipt?.sandbox!==true||delivery.receipt?.realDelivery!==false||!delivery.receipt?.providerMessageId)
  throw Error('Verified sandbox receipt required');
 if(!Number.isFinite(Date.parse(now)))throw Error('Invalid timestamp');
 return {id:draft.id,genre:draft.genre||null,category:draft.category||null,sent:false,deliveryVerified:false,
  sandboxDelivered:true,sandboxMessageId:delivery.receipt.providerMessageId,sandboxDeliveredAt:now,
  ownerApproved:draft.ownerApproved===true,followupCount:0,lastSentAt:null,mode:'sandbox_only'};
}
function sandboxCampaignReport(records=[]){
 if(!Array.isArray(records))throw Error('Records required');
 const sandboxReceipts=records.filter(x=>x?.sandboxDelivered===true&&x?.mode==='sandbox_only').length;
 return {...campaignMetrics(records),sandboxReceipts,realMessagesSent:0,mode:'sandbox_only'};
}
function evaluateSandboxFollowup(record,nowMs=Date.now()){
 if(record?.mode==='sandbox_only')return {action:'hold',reason:'sandbox_receipt_not_real_delivery',sendPermitted:false};
 return nextFollowup(record,nowMs);
}
module.exports={recordSandboxReceipt,sandboxCampaignReport,evaluateSandboxFollowup};
