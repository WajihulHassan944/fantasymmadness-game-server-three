'use strict';
// Fail-closed provider, conversion and launch contracts for isolated staging.
// This module never performs network requests or invokes production credentials.
const {reconcilePaidReferral}=require('./growth-payment-reconciliation');
function deliveryReceipt({draft,approval,providerResult}={}){
 if(!draft?.id||!['email','social'].includes(draft.channel))return {ok:false,reason:'invalid_draft'};
 if(approval?.draftId!==draft.id||approval?.ownerApproved!==true)return {ok:false,reason:'owner_approval_required'};
 if(providerResult?.sandbox!==true||providerResult?.accepted!==true||!providerResult?.messageId)return {ok:false,reason:'sandbox_receipt_missing'};
 return {ok:true,receipt:{draftId:draft.id,channel:draft.channel,providerMessageId:String(providerResult.messageId),sandbox:true,realDelivery:false}};
}
function conversionProof({signup,affiliate,referral,entry,payment,existingCredit}={}){
 if(signup?.source!=='server_verified'||signup?.status!=='created'||signup?.playerId!==referral?.playerId)return {ok:false,reason:'signup_unverified'};
 return reconcilePaidReferral({affiliate,referral,entry,payment,existingCredit});
}
function launchGate({serviceReceipts=[],conversionVerified=false,securityReview=false,rollbackRehearsed=false,ownerApproved=false,monitoringVerified=false}={}){
 const checks={serviceIntegration:serviceReceipts.some(r=>r?.ok===true&&r.receipt?.sandbox===true),conversionVerified:conversionVerified===true,securityReview:securityReview===true,rollbackRehearsed:rollbackRehearsed===true,ownerApproved:ownerApproved===true,monitoringVerified:monitoringVerified===true};
 return {ready:Object.values(checks).every(Boolean),checks};
}
module.exports={deliveryReceipt,conversionProof,launchGate};
