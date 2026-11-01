'use strict';
// Stage 12 integration audit: pure evaluation only; no network, credentials, mail or DB.
const {assessDeliveryReadiness,EXPECTED_SENDER}=require('./growth-delivery-readiness');
function auditLaunchIntegration(input={}){
 const checks={
  officialLogoVerified:input.officialLogoVerified===true&&typeof input.officialLogoUrl==='string'&&/^https:\/\//.test(input.officialLogoUrl),
  businessSenderVerified:input.businessSenderVerified===true&&String(input.senderAddress||'').toLowerCase()===EXPECTED_SENDER,
  isolatedDatabaseVerified:input.isolatedDatabaseVerified===true,
  sandboxMailVerified:input.sandboxMailVerified===true,
  suppressionAndUnsubscribeVerified:input.suppressionAndUnsubscribeVerified===true,
  attributionVerified:input.attributionVerified===true,
  productionUnchanged:input.productionUnchanged===true
 };
 const delivery=assessDeliveryReadiness({
  drafts:input.drafts||[],senderAddress:input.senderAddress||'',senderIdentityVerified:checks.businessSenderVerified,
  stagingDatabaseIsolated:checks.isolatedDatabaseVerified,mailSandboxIsolated:checks.sandboxMailVerified,
  recipientReviewApproved:input.recipientReviewApproved===true,
  ownerCampaignApproved:input.ownerCampaignApproved===true,
  unsubscribeOperational:checks.suppressionAndUnsubscribeVerified
 });
 return {stage:12,mode:'AUDIT_ONLY',checks,blockers:[...Object.entries(checks).filter(([,ok])=>!ok).map(([name])=>name),...delivery.blockers],readyForSandboxTest:Object.values(checks).every(Boolean)&&delivery.readyForSandboxTest,realDeliveryPermitted:false,productionChanges:0};
}
module.exports={auditLaunchIntegration};
