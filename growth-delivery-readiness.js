'use strict';
// Stage 11: fail-closed campaign delivery readiness. Never sends mail or accesses credentials.
const EXPECTED_SENDER='contact@fantasymmadnesscom.com';
function assessDeliveryReadiness({drafts=[],senderAddress='',senderIdentityVerified=false,stagingDatabaseIsolated=false,mailSandboxIsolated=false,recipientReviewApproved=false,ownerCampaignApproved=false,unsubscribeOperational=false}={}){
 const blockers=[];
 if(senderAddress.trim().toLowerCase()!==EXPECTED_SENDER||senderIdentityVerified!==true)blockers.push('business_sender_not_verified');
 if(stagingDatabaseIsolated!==true)blockers.push('isolated_database_not_verified');
 if(mailSandboxIsolated!==true)blockers.push('mail_sandbox_not_verified');
 if(!Array.isArray(drafts)||drafts.length===0||drafts.some(d=>!d||d.sent||d.status!=='draft'||d.sendPermitted!==false))blockers.push('draft_batch_invalid');
 if(recipientReviewApproved!==true)blockers.push('recipient_review_required');
 if(ownerCampaignApproved!==true)blockers.push('owner_approval_required');
 if(unsubscribeOperational!==true)blockers.push('unsubscribe_not_verified');
 return {mode:'DELIVERY_READINESS_ONLY',readyForSandboxTest:blockers.length===0,realDeliveryPermitted:false,blockers,expectedSender:EXPECTED_SENDER};
}
module.exports={assessDeliveryReadiness,EXPECTED_SENDER};
