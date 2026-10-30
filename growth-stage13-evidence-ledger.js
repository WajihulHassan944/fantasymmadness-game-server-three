'use strict';
// Stage 13 evidence ledger. Assertions are not proof: require independently recorded
// verification evidence before permitting any sandbox integration test.
const REQUIRED=['official_logo','business_sender','isolated_database','sandbox_mail','unsubscribe','attribution','production_baseline'];
function reviewEvidence(records=[]){
 if(!Array.isArray(records))throw Error('evidence_array_required');
 const accepted={};
 for(const item of records){
  if(!item||!REQUIRED.includes(item.kind)||accepted[item.kind])continue;
  if(item.status!=='verified'||!item.evidenceId||!item.verifiedBy||!item.verifiedAt||!Number.isFinite(Date.parse(item.verifiedAt)))continue;
  if(item.kind==='business_sender'&&item.account!=='contact@fantasymmadnesscom.com')continue;
  if(item.kind==='isolated_database'&&item.productionShared===true)continue;
  if(item.kind==='sandbox_mail'&&item.realExternalDelivery===true)continue;
  accepted[item.kind]={evidenceId:item.evidenceId,verifiedAt:item.verifiedAt};
 }
 const missing=REQUIRED.filter(k=>!accepted[k]);
 return {mode:'EVIDENCE_REVIEW_ONLY',readyForSandboxIntegration:missing.length===0,realDeliveryPermitted:false,verified:accepted,missing};
}
module.exports={reviewEvidence,REQUIRED};
