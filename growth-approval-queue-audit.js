'use strict';
const {verifiedCurrentRecipient}=require('./growth-recipient-safety');
const crypto=require('node:crypto');
const {createPreparationOperations}=require('./growth-preparation-operations');
async function auditApprovalQueue({db,clock=()=>new Date()}){
 if(db.databaseName!=='fmgrowthtest')throw Error('isolated_queue_database_required');
 const now=clock().toISOString(),c=n=>db.collection('preview198_'+n),col={drafts:c('growth_drafts'),settings:c('growth_settings'),contestVerifications:c('growth_contest_verifications'),prospects:c('growth_prospects'),recruitment:c('affiliate_prospects'),preparationJobs:c('growth_preparation_jobs')};
 const quality=createPreparationOperations({col,clock,isSuppressed:async email=>Boolean(await c('growth_suppressions').findOne({email}))});
 const rows=[];
 for(const d of await col.drafts.find({status:{$in:['needs_owner_review','approved']}}).sort({createdAt:1}).toArray()){
  const lead=d.prospectId?await (d.recruitmentSource==='independent_public_partner'?col.recruitment:col.prospects).findOne({id:d.prospectId}):null;
  const reportedUnsafe=/\bdory\s+funk\b/i.test([d.subject,d.text,lead?.name].join(' '));
  const holds=[];
  if(reportedUnsafe)holds.push('owner_reported_recipient_status_requires_verification');
  if(d.kind==='affiliate'&&!verifiedCurrentRecipient(lead,clock()))holds.push('current_recipient_status_requires_verification');
  if(holds.length){
   const r=await col.drafts.updateOne({id:d.id,status:{$in:['needs_owner_review','approved']}},{$addToSet:{approvalBlockers:{$each:holds}},$set:{reviewSafety:{state:'hold',reasons:holds,checkedAt:now,authority:'owner_requested_emergency_audit'},ownerApproved:false,sendPermitted:false}});
   if(reportedUnsafe&&lead)await col.recruitment.updateOne({id:lead.id},{$set:{outreachHold:{reason:holds[0],checkedAt:now,authority:'owner_reported_status_not_independently_confirmed'}}});
   await c('growth_audit_log').updateOne({action:'emergency_recipient_hold',draftId:d.id},{$setOnInsert:{action:'emergency_recipient_hold',draftId:d.id,at:now,reasons:holds,recordsDeleted:false,publishingEnabled:false}},{upsert:true});
   d.approvalBlockers=[...new Set([...(d.approvalBlockers||[]),...holds])];d.ownerApproved=false;d.sendPermitted=false;
  }
  const blockers=await quality.quality(d,clock());
  const contact=d.recruitmentSource==='independent_public_partner'?lead?.contact:lead?.research?.contact;
  rows.push({id:d.id,kind:d.kind,title:d.subject||d.headline,prospectId:d.prospectId,name:lead?.name||null,sourceId:lead?.sourceId||null,sourceUrl:lead?.sourceUrl||null,website:lead?.website||null,createdAt:d.createdAt,discoveryHistory:lead?.history||[],researchAt:lead?.researchedAt||null,contactSource:contact?.source||null,contactAddressSourceVerified:contact?.verified===true||lead?.research?.ok===true,recipientDomain:String(d.recipient||'').split('@')[1]||null,recipientDigest:crypto.createHash('sha256').update(String(d.recipient||'').toLowerCase()).digest('hex'),contactMatches:Boolean(contact?.email&&contact.email.toLowerCase()===String(d.recipient||'').toLowerCase()),recipientStatus:reportedUnsafe?'OWNER_REPORTED_UNSAFE_UNCONFIRMED':verifiedCurrentRecipient(lead,clock())?'verified_current':'unverified_current_status',blockers,decision:blockers.length?'HOLD':'TECHNICALLY_ELIGIBLE_FOR_OWNER_REVIEW',ownerApproved:d.ownerApproved===true,sendPermitted:d.sendPermitted===true,evidence:lead?.evidence||lead?.research?.evidence||[]});
 }
 return{checkedAt:now,database:'fmgrowthtest',collectionPrefix:'preview198_',rows,counts:{total:rows.length,held:rows.filter(x=>x.decision==='HOLD').length,eligibleForOwnerReview:rows.filter(x=>x.decision!=='HOLD').length},publishingEnabled:false,outboundEnabled:false,productionChanged:false,credentialsChanged:false};
}
module.exports={auditApprovalQueue};
