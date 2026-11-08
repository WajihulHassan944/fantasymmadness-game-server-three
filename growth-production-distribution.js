'use strict';
// Explicit owner distribution decisions are separate from preparation/content approvals.
const crypto=require('node:crypto');
const {contentVersion}=require('./growth-production-review');
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
function createProductionDistribution({col,queue,quality,email,meta,owners,clock=()=>new Date(),enabled=false,suppression=null,reverifyMarketing=async()=>({ok:false,reason:"fresh_registry_check_required"})}={}){
 const now=()=>clock().toISOString();
 async function init(){await queue.createIndex({key:1},{unique:true});await queue.createIndex({status:1,scheduledAt:1});}
 async function policy(){const p=await col.settings.findOne({_id:'distribution-policy'});const emergency=await col.settings.findOne({_id:'autonomy:policy'});return{paused:!enabled||p?.paused!==false||emergency?.paused===true,emergencyStopped:emergency?.paused===true,enabled,version:p?.version||0};}
 async function readiness(){const channels=meta?await meta.readiness():{};const counts=Object.fromEntries(await Promise.all(['scheduled','held','accepted','published','needs_check','failed','cancelled'].map(async status=>[status,await queue.countDocuments({status})])));return{enabled,counts,policy:await policy(),email:email?await email.readiness():{ready:false,provider:'none',blockers:['gmail_app_oauth_credentials_required']},channels,receiptMeaning:'Provider acceptance and publication IDs are recorded separately from delivery confirmation.'};}
 async function pause(paused,owner){if(!owners.includes(owner)||typeof paused!=='boolean')return{ok:false,reason:'verified_owner_and_explicit_pause_required'};if(!paused){const r=await readiness();if(!enabled||r.policy.emergencyStopped)return{ok:false,reason:'emergency_stop_or_distribution_disabled'};if(!r.email.ready&&!Object.values(r.channels).some(c=>c.ready))return{ok:false,reason:'provider_verification_required'};}
 await col.audit.insertOne({action:paused?'distribution_pause':'distribution_resume',owner,at:now()});await col.settings.updateOne({_id:'distribution-policy'},{$set:{paused,by:owner,at:now()},$inc:{version:1}},{upsert:true});return{ok:true,...await policy()};}
 async function activateVerifiedRelease(release,verified){
  if(!enabled||!release||release!==verified||!/^[a-f0-9]{40}$/.test(release))return{ok:false,reason:'exact_owner_authorized_release_required'};
  if(await col.settings.findOne({_id:'distribution-policy'}))return{ok:true,unchanged:true,...await policy()};
  const r=await readiness();if(r.policy.emergencyStopped||!Object.values(r.channels).some(c=>c.ready))return{ok:false,reason:'provider_verification_or_emergency_stop'};
  await col.audit.insertOne({action:'distribution_initial_resume',source:'owner_authorized_issue121_release',release,at:now(),campaignApprovalsGranted:0});
  await col.settings.updateOne({_id:'distribution-policy'},{$setOnInsert:{paused:false,by:'owner_authorized_issue121_release',release,at:now(),version:1}},{upsert:true});
  return{ok:true,...await policy()};
 }
 async function assess(d){const blockers=[...await quality(d,clock())];if(d.kind==='marketing'){const check=await reverifyMarketing(d,clock());if(!check.ok)blockers.push(check.reason||'fresh_registry_check_failed');}if(d.status!=='approved'||d.ownerApproved!==true)blockers.push('content_approval_required');if(d.reviewSafety?.state==='hold')blockers.push(...(d.reviewSafety.reasons||['source_hold']));if(await col.ownerCampaignHolds.findOne({_id:d.id,active:true}))blockers.push('owner_campaign_hold');if(d.kind==='affiliate')blockers.push('recipient_suitability_terms_and_attribution_verification_required');return blockers;}
 function payload(d,channel,destination){if(channel==='email'){const link=suppression?suppression.link('https://fantasymmadness-growth-isolated-tes.vercel.app/api/growth/production-unsubscribe',d.recipient):d.listUnsubscribe;return{channel,recipient:d.recipient,subject:d.subject,text:link&&!d.text.includes(link)?d.text+'\n\nUnsubscribe: '+link:d.text,listUnsubscribe:link};}return{channel,destinationId:destination,text:d.posts?.[channel],imageUrl:d.poster?.portrait?.url||d.contest?.posterUrl||null};}
 async function preview(id,channel){const d=await col.drafts.findOne({id});if(!d||!['email','facebook','instagram'].includes(channel))return{ok:false,reason:'campaign_or_channel_not_found'};const r=await readiness(),destination=channel==='email'?r.email:r.channels[channel];const p=payload(d,channel,destination?.destinationId);return{ok:true,version:contentVersion(d),payload:p,payloadHash:digest(p),providerReady:destination?.ready===true,destinationName:destination?.name||null};}
 async function authorize(id,body,owner){
  if(!enabled||!owners.includes(owner)||body.confirmation!=='AUTHORIZE THIS EXACT DELIVERY')return{ok:false,reason:'explicit_recipient_content_destination_schedule_approval_required'};
  const d=await col.drafts.findOne({id});if(!d||body.version!==contentVersion(d))return{ok:false,reason:'campaign_changed_review_again'};
  const blockers=await assess(d);if(blockers.length)return{ok:false,reason:'campaign_held',blockers};
  const channel=body.channel;if(!['email','facebook','instagram'].includes(channel))return{ok:false,reason:'provider_publishing_scope_required'};
  const at=new Date(body.scheduledAt);if(!Number.isFinite(+at)||+at<+clock()||+at>+clock()+7*86400000)return{ok:false,reason:'explicit_future_schedule_within_seven_days_required'};
  const r=await readiness(),provider=channel==='email'?r.email:r.channels[channel];if(!provider?.ready)return{ok:false,reason:'provider_verification_required'};
  if(channel==='email'&&(!['pr','affiliate'].includes(d.kind)||body.recipient!==d.recipient))return{ok:false,reason:'exact_recipient_required'};
  if(channel!=='email'&&(d.kind!=='marketing'||body.destinationId!==provider.destinationId||d.platformCopy?.[channel]?.ready===false))return{ok:false,reason:'verified_campaign_destination_required'};
  if(channel!=='email'){const future=require('./growth-contest-campaigns').checkCampaign(d,d.contest,{now:at});if(future.length)return{ok:false,reason:'schedule_after_fight_entry_deadline',blockers:future};}
  const p=payload(d,channel,body.destinationId);if(!p.text||channel!=='email'&&!p.imageUrl)return{ok:false,reason:'approved_content_and_artwork_required'};
  if(body.payloadHash!==digest(p))return{ok:false,reason:'exact_delivery_preview_approval_required'};
  const key=digest(p);
  const entry={key,draftId:id,version:body.version,payload:p,payloadHash:digest(p),owner,scheduledAt:at.toISOString(),status:'scheduled',attempts:0,authorizedAt:now()};
  // Audit is written BEFORE the queue becomes dispatchable. Duplicates never reset state.
  await col.audit.insertOne({action:'distribution_authorized',...entry});
  try{await queue.insertOne(entry);}catch(e){if(e.code!==11000)throw e;return{ok:false,reason:'duplicate_delivery'};}
  return{ok:true,key,status:'scheduled',scheduledAt:entry.scheduledAt};
 }
 async function dispatch(){
  const stale=new Date(+clock()-10*60000).toISOString();await queue.updateMany({status:'sending',claimedAt:{$lt:stale}},{$set:{status:'needs_check',reason:'interrupted_provider_request_never_auto_retry'}});
  if((await policy()).paused)return{paused:true};const out={accepted:0,held:0,failed:0};
  for(const job of await queue.find({status:'scheduled',scheduledAt:{$lte:now()}}).sort({scheduledAt:1}).limit(10).toArray()){
   if((await policy()).paused)break;
   const d=await col.drafts.findOne({id:job.draftId});let blockers=[];
   if(!d||contentVersion(d)!==job.version||digest(payload(d,job.payload.channel,job.payload.destinationId))!==job.payloadHash)blockers.push('approved_campaign_changed');else blockers=await assess(d);
   const r=await readiness(),provider=job.payload.channel==='email'?r.email:r.channels[job.payload.channel];
   if(!provider?.ready||job.payload.channel!=='email'&&provider.destinationId!==job.payload.destinationId)blockers.push('provider_destination_unverified');
   if(blockers.length){await queue.updateOne({key:job.key,status:'scheduled'},{$set:{status:'held',blockers,checkedAt:now()}});out.held++;continue;}
   const claim=crypto.randomUUID();const claimed=await queue.findOneAndUpdate({key:job.key,status:'scheduled'},{$set:{status:'sending',claim,claimedAt:now()},$inc:{attempts:1}},{returnDocument:'after'});if(!claimed)continue;
   // Recheck the kill switch after the atomic claim and before the provider request.
   const latest=await col.drafts.findOne({id:job.draftId});if(!latest||contentVersion(latest)!==job.version||(await assess(latest)).length){await queue.updateOne({key:job.key,claim},{$set:{status:'held',blockers:['campaign_changed_before_delivery']}});out.held++;continue;}
   if((await policy()).paused){await queue.updateOne({key:job.key,claim},{$set:{status:'scheduled'}});break;}
   const canSend=async()=>{if((await policy()).paused)return false;const current=await col.drafts.findOne({id:job.draftId});return Boolean(current&&contentVersion(current)===job.version&&!(await assess(current)).length);};
   let result;try{await col.audit.insertOne({action:'distribution_provider_attempt',key:job.key,claim,at:now()});result=job.payload.channel==='email'?await email.send({...d,...job.payload,id:job.key,status:'approved',ownerApproved:true,sendPermitted:true},{canSend}):await meta.publish({...job.payload,id:job.key},{canSend});}catch{result={ok:false,uncertain:true,reason:'provider_outcome_unknown'};}
   const status=result.ok?(job.payload.channel==='email'?'accepted':'published'):result.uncertain?'needs_check':result.retryable&&claimed.attempts<3?'scheduled':'failed';
   const changes={status,receipt:result.receipt||null,lastError:result.reason||null,updatedAt:now()};if(status==='scheduled')changes.scheduledAt=new Date(+clock()+Math.pow(2,claimed.attempts)*60000).toISOString();
   await queue.updateOne({key:job.key,status:'sending',claim},{$set:changes});await col.audit.insertOne({action:'distribution_provider_result',key:job.key,...changes});out[result.ok?'accepted':'failed']++;
  }return out;
 }
 async function cancel(key,owner){if(!owners.includes(owner))return{ok:false};await col.audit.insertOne({action:'distribution_cancel',key,owner,at:now()});const r=await queue.updateOne({key,status:{$in:['scheduled','held','failed']}},{$set:{status:'cancelled',cancelledAt:now(),cancelledBy:owner}});return{ok:r.modifiedCount===1};}
 return{init,readiness,preview,pause,activateVerifiedRelease,authorize,dispatch,cancel,list:async()=>queue.find({},{projection:{_id:0,claim:0}}).sort({scheduledAt:-1}).limit(100).toArray()};
}
module.exports={createProductionDistribution};
