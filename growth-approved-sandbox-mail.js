'use strict';
// Sandbox-only SMTP adapter: explicitly injected loopback transport.
// Approval gates apply even to test recipients. Never connects to real SMTP.
const {deliveryReceipt}=require('./growth-final-three-gates');
function createSandboxMailSender({transport,from='sandbox-sender@localhost'}={}){
 if(!transport||typeof transport.sendMail!=='function')throw Error('SMTP transport required');
 if(!/^[^@\s]+@localhost$/.test(from))throw Error('Loopback sender required');
 return async function sendApprovedSandboxDraft({draft,approval}={}){
  if(!draft?.id||draft.status!=='approved'||draft.ownerApproved!==true||draft.sendPermitted!==true||approval?.draftId!==draft.id||approval.ownerApproved!==true)
   return {ok:false,reason:'owner_approval_required'};
  if(!/^[^@\s]+@localhost$/.test(draft.recipient||''))return {ok:false,reason:'sandbox_recipient_required'};
  if(!draft.subject||!draft.text)return {ok:false,reason:'draft_content_required'};
  const info=await transport.sendMail({from,to:draft.recipient,subject:draft.subject,text:draft.text,html:draft.html});
  return deliveryReceipt({draft:{id:draft.id,channel:'email'},approval,providerResult:{sandbox:true,accepted:!!info?.messageId,messageId:info?.messageId}});
 };
}
module.exports={createSandboxMailSender};
