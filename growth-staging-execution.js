'use strict';
// Isolated staging execution model. Never connects to social/email providers.
// Delivery is an explicitly simulated receipt, never real outreach.
const {makeJob,claimDue,settle,followupAllowed,safeReport}=require('./growth-unattended-controller');
function stageApprovedDrafts(drafts,now=Date.now()){
 const jobs=[],blocked=[];
 for(const d of drafts){
  if(d.status!=='approved'||d.ownerApproved!==true||!d.id||!['campaign','pr','affiliate'].includes(d.kind)){
   blocked.push({id:d.id||null,reason:'not_owner_approved'});continue;
  }
  jobs.push(makeJob({id:'stage-'+d.id,type:d.kind==='pr'?'prepare_pr':'prepare_campaign',dueAt:new Date(now).toISOString(),payload:{draftId:d.id,mode:'simulated_delivery'}}));
 }
 return {jobs,blocked};
}
function executeStage(jobs,now=Date.now()){
 const claimed=claimDue(jobs,now);
 const receipts=claimed.map(job=>({id:job.id,mode:'SIMULATED_ONLY',delivered:false,providerMessageId:null,reviewed:true}));
 const completed=claimed.map(job=>settle(job,{success:true,now}));
 return {completed,receipts,externalActions:0};
}
function stageFollowup(contact,now=Date.now()){
 if(!followupAllowed(contact))return {blocked:true,reason:'consent_or_contact_status'};
 return {blocked:false,job:makeJob({id:'followup-'+String(contact.id),type:'prepare_followup',dueAt:new Date(now).toISOString(),payload:{contactId:contact.id}})};
}
function stageReport(events){return {...safeReport(events),realDeliveries:0,mode:'SIMULATED_ONLY'};}
module.exports={stageApprovedDrafts,executeStage,stageFollowup,stageReport};
