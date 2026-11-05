'use strict';
// Durable preparation receipts are NOT delivery receipts or owner approvals.
const crypto=require('node:crypto');
const {createStore}=require('./growth-unattended-store');
const {greetingFor}=require('./growth-text-quality');
const DEPARTMENTS=['marketing','pr','affiliate'];
const digest=d=>crypto.createHash('sha256').update(JSON.stringify([d.subject,d.text,d.html,d.posts,d.contestFingerprint,d.poster?.portrait?.id,d.poster?.story?.id,d.approvalBlockers])).digest('hex');
function createPreparationOperations({col,actions={},isPaused=async()=>false,isSuppressed=async()=>false,clock=()=>new Date()}){
 const store=createStore(col.preparationJobs,{testMode:true});
 async function init(){await store.init();await col.preparationReceipts.createIndex({id:1},{unique:true});await col.preparationReceipts.createIndex({draftId:1,createdAt:-1});}
 async function quality(d,now=clock()){
  const held=[...(d.approvalBlockers||[])];
  if(d.kind==='marketing'){
   held.push(...require('./growth-contest-campaigns').checkCampaign(d,d.contest,{now}));
   if(d.poster?.status!=='ready'||d.poster?.needsArtwork||!d.poster?.qr?.decodedMatches||!d.poster?.qr?.destination?.ok)held.push('verified_original_artwork_and_qr_required');
   if(d.poster?.liveAffiliateId){try{if(new URL(d.poster.qrUrl).searchParams.get('ref')!==d.poster.liveAffiliateId)held.push('affiliate_qr_identity_mismatch');}catch{held.push('affiliate_qr_identity_mismatch');}}
  }else{
   if(!d.subject||!d.text||!d.html)held.push('complete_subject_and_message_required');
   if(String(d.subject||'').length>200)held.push('subject_too_long');
   if(/\$\s?\d|\b\d{1,3}\s*%/.test((d.subject||'')+' '+(d.text||'')))held.push('financial_claim_requires_verified_terms');
   const independent=d.recruitmentSource==='independent_public_partner';
   const lead=d.prospectId?await (independent?col.recruitment:col.prospects).findOne({id:d.prospectId}):null;
   const contact=independent?lead?.contact:lead?.research?.contact;
   if(!contact||contact.email?.toLowerCase()!==String(d.recipient||'').toLowerCase()||!/^https:\/\//.test(contact.source||'')||independent&&contact.verified!==true)held.push('verified_recipient_contact_required');
   if(lead?.researchHold)held.push('source_reverification_pending');
   if(!d.contactSource||!d.consentBasis)held.push('published_business_contact_provenance_required');
   if(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.recipient||'')&&await isSuppressed(d.recipient))held.push('recipient_suppressed');
   const expected=greetingFor(contact,lead?.research?.show||{});if(String(d.text||'').split('\n')[0].trim()!==expected)held.push('verified_greeting_required');
   if(/&(?:amp|quot|apos|lt|gt|#\d+|#x[a-f0-9]+);/i.test(String(d.subject||'')+'\n'+String(d.text||'')))held.push('unrendered_html_entity');
   if(/[\r\n\x00-\x1f]/.test(d.subject||''))held.push('subject_header_control_character');
   if(/\bI (?:listened|watched|have been following)\b/i.test(d.text||''))held.push('unsupported_personal_experience_claim');
   if(!lead||(independent?!(lead.evidence||[]).some(e=>e.kind==='role'&&/^https:\/\//.test(e.sourceUrl||'')):lead.research?.ok!==true||!(d.personalization?.evidence||[]).some(e=>e.text)))held.push('sourced_personalization_required');
   if(d.kind==='affiliate'){
    const terms=await col.settings.findOne({_id:'affiliate-program-readiness'});if(terms?.termsVerified!==true)held.push('affiliate_terms_require_owner_review');
    let url;try{url=new URL(d.signupUrl||String(d.text||'').match(/https:\/\/www\.fantasymmadness\.com\/auth\?[^\s]+/)?.[0]);}catch{}
    if(!url||url.hostname!=='www.fantasymmadness.com'||url.pathname!=='/auth'||url.searchParams.get('role')!=='affiliate'||!url.searchParams.get('utm_campaign')||!url.searchParams.get('utm_source'))held.push('tracked_affiliate_signup_required');
   }
  }
  return [...new Set(held)];
 }
 async function capture(department,now=clock(),{activityOk=true,canWrite=async()=>true}={}){
  let created=0;const drafts=await col.drafts.find({kind:department,status:'needs_owner_review'}).sort({createdAt:1}).limit(100).toArray();
  for(const d of drafts){if(await isPaused()||!await canWrite())break;const blockers=await quality(d,now);if(!activityOk)blockers.push('latest_source_refresh_failed');const version=digest(d),id='prepared-'+crypto.createHash('sha256').update(d.id+':'+version).digest('hex').slice(0,32);
   if(!await canWrite())break;const r=await col.preparationReceipts.updateOne({id},{$setOnInsert:{id,draftId:d.id,department,contentVersion:version,createdAt:now.toISOString(),sandbox:true,researchMayUseReadOnlyNetwork:true,receiptType:'preparation_only',sent:false,published:false,network:false,deliveryAttempted:false,ownerApproved:false},$set:{stage:blockers.length?'held_for_evidence':'awaiting_owner_approval',blockers,lastCheckedAt:now.toISOString()}},{upsert:true});created+=r.upsertedCount;
  }return{created,checked:drafts.length};
 }
 async function run(now=clock()){
  if(await isPaused())return{skipped:'emergency_stop',jobs:[]};await init();for(const dead of await col.preparationJobs.find({state:'running',attempts:{$gte:3},leaseUntil:{$lte:clock().toISOString()}}).limit(9).toArray()){const r=await col.preparationJobs.updateOne({id:dead.id,state:'running',leaseToken:dead.leaseToken},{$set:{state:'failed',lastError:'lease_expired_retry_budget_exhausted',updatedAt:clock().toISOString()}});if(r.modifiedCount){const department=dead.payload.department;await col.settings.updateOne({_id:'preparation-cooldown:'+department},{$set:{until:new Date(+clock()+3600000).toISOString()}},{upsert:true});await col.alerts.updateOne({alertKey:'preparation:'+department},{$setOnInsert:{alertKey:'preparation:'+department,kind:'preparation',createdAt:clock().toISOString()},$set:{id:dead.id,department,state:'open',error:'lease_expired_retry_budget_exhausted',action:'An interrupted job exhausted its retries. The department will retry after a one-hour cooldown; an owner can requeue earlier.'}},{upsert:true});}}const bucket=Math.floor(+now/900000);
  for(const department of DEPARTMENTS){const cooldown=await col.settings.findOne({_id:'preparation-cooldown:'+department});const active=await col.preparationJobs.findOne({'payload.department':department,state:{$in:['pending','retry','running']}});if(active||cooldown?.until>now.toISOString())continue;await store.enqueue({id:`preparation-${bucket}-${department}`,type:department==='pr'?'prepare_pr':'prepare_campaign',dueAt:now.toISOString(),payload:{department}});}
  const jobs=[];
  for(let i=0;i<3;i++){
   if(await isPaused())break;const job=await store.claim(+clock());if(!job)break;const department=job.payload?.department;
   const owns=async()=>Boolean(await col.preparationJobs.findOne({id:job.id,state:'running',leaseToken:job.leaseToken,leaseUntil:{$gt:clock().toISOString()}}));
   try{
    if(!DEPARTMENTS.includes(department)||typeof actions[department]!=='function')throw Error('preparation_department_unavailable');
    const result=await actions[department](clock(),job.payload||{});if(Array.isArray(result?.failedProspectIds))job.payload={...job.payload,retryTargets:result.failedProspectIds.slice(0,25)};if(await isPaused())throw Error('emergency_stop');
    if(result?.sourceReachable===false||result?.error||(result?.errors>0&&department!=='pr')||result?.posters?.failed?.length)throw Error('preparation_source_temporarily_unavailable');
    if(!await owns()){jobs.push({department,ok:false,reason:'preparation_lease_lost'});continue;}const receipt=await capture(department,clock(),{canWrite:owns});if(!await owns()){jobs.push({department,ok:false,reason:'preparation_lease_lost'});continue;}await store.finish(job,{success:true,now:+clock()});
    await col.alerts.updateMany({kind:'preparation',department,state:'open'},{$set:{state:'acknowledged',ackBy:'verified-preparation-recovery',ackAt:clock().toISOString(),resolution:'The same durable preparation job completed; no delivery was attempted.'}});jobs.push({department,ok:true,sourceHolds:result?.errors||0,receipt});
   }catch(e){if(!await owns()){jobs.push({department,ok:false,reason:'preparation_lease_lost'});continue;}const reason=['emergency_stop','preparation_department_unavailable','preparation_source_temporarily_unavailable'].includes(e.message)?e.message:'preparation_activity_failed';const settled=await store.finish(job,{success:false,error:reason,now:+clock()});if(settled.state==='failed')await col.settings.updateOne({_id:'preparation-cooldown:'+department},{$set:{until:new Date(+clock()+3600000).toISOString()}},{upsert:true});if(reason!=='emergency_stop'&&!await isPaused())await capture(department,clock(),{activityOk:false,canWrite:async()=>true});await col.alerts.updateOne({alertKey:'preparation:'+department},{$setOnInsert:{alertKey:'preparation:'+department,kind:'preparation',createdAt:clock().toISOString()},$set:{id:job.id,state:'open',error:reason,department,attempts:job.attempts,nextRetryAt:settled.state==='retry'?settled.dueAt:null,action:settled.state==='failed'?'Retry budget exhausted; department cools down for one hour before a fresh bounded attempt. An owner may inspect and requeue earlier. No external action occurred.':'Recoverable preparation failure; retry is queued. No external action occurred.'}},{upsert:true});jobs.push({department,ok:false,state:settled.state,reason});}
  }
  return{jobs,mode:'preparation_only',publishingEnabled:false,outboundEnabled:false};
 }
 async function summary({details=false}={}){
  const departments={};for(const kind of DEPARTMENTS){const current=await col.drafts.find({kind,status:'needs_owner_review'},{projection:{id:1}}).toArray(),ids=current.map(d=>d.id);departments[kind]={awaitingOwnerReview:ids.length,receipts:await col.preparationReceipts.countDocuments({department:kind}),ready:0,held:0};const seen=new Set();for(const r of await col.preparationReceipts.find({draftId:{$in:ids}}).sort({lastCheckedAt:-1}).toArray()){if(seen.has(r.draftId))continue;seen.add(r.draftId);if(r.stage==='awaiting_owner_approval')departments[kind].ready++;else departments[kind].held++;}departments[kind].awaitingReceipt=ids.length-seen.size;departments[kind].sourceHolds=kind==='pr'?await col.prospects.countDocuments({researchHold:'source_retry_pending'}):kind==='affiliate'?await col.recruitment.countDocuments({error:{$type:'string'}}):0;departments[kind].approvedDrafts=await col.drafts.countDocuments({kind,status:'approved'});}
  return{...(details?{recentJobs:await jobs()}:{}),mode:'preparation_only',departments,jobs:await store.summary(),receiptMeaning:'Prepared evidence snapshots only; never messages sent, publication, owner approval or conversion.',realDeliveriesObserved:col.deliveries?await col.deliveries.countDocuments({realDelivery:true}):0,liveSocialPostsObserved:col.social?await col.social.countDocuments({status:'published',sandbox:{$ne:true}}):0,attributedPayingConversions:null,publishingEnabled:false,outboundEnabled:false};
 }
 async function jobs(){return(await col.preparationJobs.find({}).sort({createdAt:-1}).limit(30).toArray()).map(({_id,leaseToken,...safe})=>safe);}
 async function requeue(id){const job=await col.preparationJobs.findOne({id,state:'failed'});if(!job)return{ok:false};const r=await col.preparationJobs.updateOne({id,state:'failed'},{$set:{state:'retry',attempts:0,dueAt:clock().toISOString(),lastError:null},$inc:{ownerRequeues:1}});if(r.modifiedCount)await col.settings.deleteOne({_id:'preparation-cooldown:'+job.payload.department});return{ok:r.modifiedCount===1};}
 return{init,quality,capture,run,summary,jobs,requeue};
}
module.exports={createPreparationOperations,DEPARTMENTS};
