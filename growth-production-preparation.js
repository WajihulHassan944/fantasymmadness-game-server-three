'use strict';
const crypto=require('node:crypto');
const {assertProductionDatabase,productionReadOnlyFetch,preparationCollectionName}=require('./growth-production-preparation-config');
// Only this validated composition root can open the new production namespace.
// No staging copy, affiliate signup, OAuth exchange, payment or send API exists.
async function createProductionPreparation({rawDb,config,secrets,fetchImpl,verifiedOwnerIds,originalConnections=null,clock=()=>new Date(),runtimeFactory}={}){
 assertProductionDatabase(rawDb,config);
 const PREFIX=config.collectionPrefix,environment=config.environment||'production';
 const owners=config.autonomy.owners;
 if(!owners.length||!Array.isArray(verifiedOwnerIds)||!owners.every(id=>verifiedOwnerIds.includes(id)))throw Error('production_first_party_owner_evidence_required');
 const db={databaseName:rawDb.databaseName,collection:name=>{return rawDb.collection(preparationCollectionName(name,PREFIX));}};
 const marker=await db.collection('growth_settings').findOne({_id:'production-preparation'});
 if(marker&&(marker.environment!==environment||marker.database!==rawDb.databaseName||marker.schemaVersion!==1))throw Error('production_namespace_requires_review');
 if(!marker){for(const name of ['growth_drafts','growth_affiliates','growth_attribution_events','growth_prospects'])if(await db.collection(name).countDocuments({}))throw Error('production_namespace_requires_review');}
 const provider=Object.freeze({name:'none',realDelivery:false,send:async()=>{throw Error('production_preparation_delivery_disabled');}});
 const runtime=(runtimeFactory||require('./growth-runtime').createGrowthRuntime)({db,config,secrets,provider,fetchImpl:productionReadOnlyFetch(fetchImpl),alertSender:null});
 await runtime.init();
 const settings=runtime.collections.settings,cycles=db.collection('preparation_cycles');
 await settings.updateOne({_id:'production-preparation'},{$setOnInsert:{enabled:false,environment,database:rawDb.databaseName,schemaVersion:1,generation:'production-preparation-v1',createdAt:clock().toISOString()},$set:{ownerCount:owners.length,approvalMode:'owner_required',publishingEnabled:false,outboundEnabled:false}},{upsert:true});
 const stopped=async()=>{const s=await settings.findOne({_id:'production-preparation'}),p=await settings.findOne({_id:'autonomy:policy'});return !s?.enabled||p?.paused===true;};
 async function cycle({generation,ordinal,deploymentId,workflowRunId=null}){
  const state=await settings.findOne({_id:'production-preparation'});if(await stopped()||state.generation!==generation||state.deploymentId!==deploymentId)return{stop:true};
  const now=clock(),bucket=Math.floor(+now/900000),key=generation+':'+bucket+(ordinal===1?':confirmation':''),lease=crypto.randomUUID();
  const existing=await cycles.findOne({_id:key});if(existing?.completedAt)return{stop:false,duplicate:true};
  const claimed=await settings.findOneAndUpdate({_id:'production-preparation',enabled:true,generation,deploymentId,$or:[{leaseUntil:{$exists:false}},{leaseUntil:{$lte:now.toISOString()}}]},{$set:{lease,leaseUntil:new Date(+now+10*60000).toISOString()}},{returnDocument:'after'});if(!claimed)return{stop:false,busy:true};
  try{
   if(await stopped())return{stop:true};
   // No dispatch/autonomy/publisher/affiliate mutation methods are exposed.
   // Release bootstrap must not inherit a completed preparation bucket from the old worker.
   if(ordinal===0&&typeof runtime.refreshMarketing==='function'){await runtime.refreshMarketing(now,{trigger:'verified_production_release'});await runtime.preparation.capture('marketing',now);}
   const report=await runtime.tick({now,preparationOnly:true});
   if(await stopped())return{stop:true};
   const preparation=await runtime.preparation.run(now),operations=await runtime.preparation.summary();
   const finished=clock(),current=await settings.findOne({_id:'production-preparation',enabled:true,generation,deploymentId,lease,leaseUntil:{$gt:finished.toISOString()}});if(!current)return{stop:true,leaseLost:true};
   const errors=(report.errors||[]).length+(report.jobs||[]).filter(j=>!j.ok).length+(preparation.jobs||[]).filter(j=>!j.ok).length;
   const evidence={generation,ordinal,cyclePurpose:ordinal===1?'release_confirmation':'scheduled_preparation',jobsProcessed:(report.jobs||[]).filter(j=>j.ok).length,preparationJobsProcessed:(preparation.jobs||[]).filter(j=>j.ok).length,deploymentId,commit:config.releaseCommit,workflowRunId,trigger:ordinal>0?'workflow_timer':'bootstrap',completedAt:finished.toISOString(),environment,database:rawDb.databaseName,collectionPrefix:PREFIX,operations,errors,websiteSessionUsed:false,ownerApprovalRequired:true,publishingEnabled:false,outboundEnabled:false,automaticApprovals:0,paymentMutations:0};
   await cycles.updateOne({_id:key},{$setOnInsert:evidence},{upsert:true});
   await settings.updateOne({_id:'production-preparation',enabled:true,generation,deploymentId,lease},{$set:{lastCompletedAt:evidence.completedAt,nextWakeAt:new Date(+finished+900000).toISOString(),lastError:errors?'preparation_jobs_require_review':null},$inc:{completedCycles:1,scheduledCycles:ordinal>0?1:0}});
   return{stop:false,evidence};
  }catch{await settings.updateOne({_id:'production-preparation',lease},{$set:{lastError:'production_preparation_cycle_failed'}});await runtime.collections.alerts.updateOne({alertKey:'production-preparation'},{$set:{state:'open',error:'production_preparation_cycle_failed',action:'Inspect jobs; external actions remain disabled.',at:clock().toISOString()}},{upsert:true});throw Error('production_preparation_cycle_failed');}
  finally{await settings.updateOne({_id:'production-preparation',lease},{$unset:{lease:'',leaseUntil:''}});}
 }
 async function status(){const s=await settings.findOne({_id:'production-preparation'}),coverage=await runtime.collections.coverage?.find({}).sort({checkedAt:-1}).limit(1).next(),acceptance=await settings.findOne({_id:'owner-production-acceptance'},{projection:{_id:0}});return{environment,ownerAcceptance:acceptance||null,discovery:coverage?{checkedAt:coverage.checkedAt,recordsChecked:coverage.contestsChecked,eligibleContests:coverage.verifiedContests,sourceReachable:coverage.sourceReachable,complete:coverage.complete,sourceErrors:coverage.sourceErrors,sources:coverage.sources,sports:coverage.sports,horizonDays:config.marketingHorizonDays,campaignsCreated:coverage.created}:null,database:rawDb.databaseName,databaseIsolation:config.database.isolation,sharedAtlasCluster:config.database.sharedCluster,collectionPrefix:PREFIX,scheduler:{enabled:s?.enabled===true,activeDeploymentId:s?.deploymentId||null,servedCommit:config.releaseCommit,lastScheduledReceipts:(await workerReceipts(2)).receipts,generation:s?.generation,lastCompletedAt:s?.lastCompletedAt||null,completedCycles:s?.completedCycles||0,scheduledCycles:s?.scheduledCycles||0,healthy:s?.enabled===true&&!s.lastError&&Boolean(s.lastCompletedAt)&&+clock()-Date.parse(s.lastCompletedAt)<=35*60000,lastError:s?.lastError||null},operations:await runtime.preparation.summary(),connections:(typeof originalConnections==='function'?await originalConnections():originalConnections)||{source:'existing_authorized_connection_service',productionPublishingAuthorized:false,reason:'provider_status_not_yet_verified'},ownerApprovalRequired:true,publishingEnabled:false,outboundEnabled:false,paymentMutationsEnabled:false,syntheticImportsSupported:false};}
 async function activate({deploymentId,confirmation}){if(confirmation!=='ACTIVATE PRODUCTION PREPARATION ONLY'||!/^dpl_[A-Za-z0-9]+$/.test(deploymentId||''))throw Error('explicit_verified_deployment_activation_required');const state=await settings.findOne({_id:'production-preparation'});if(state?.enabled&&state.deploymentId!==deploymentId)throw Error('another_production_deployment_is_active');await settings.updateOne({_id:'autonomy:policy'},{$set:{paused:false,enabled:false}},{upsert:true});await settings.updateOne({_id:'production-preparation',enabled:false},{$set:{enabled:true,deploymentId,activatedAt:clock().toISOString()}});}
 async function handover({fromDeploymentId,deploymentId,confirmation}){
  if(confirmation!=='HANDOVER PRODUCTION PREPARATION ONLY'||![fromDeploymentId,deploymentId].every(x=>/^dpl_[A-Za-z0-9]+$/.test(x||''))||fromDeploymentId===deploymentId)throw Error('explicit_verified_handover_required');
  const before=await settings.findOne({_id:'production-preparation'});
  if(before?.enabled&&before.deploymentId===deploymentId)return status();
  if(!before?.enabled||before.deploymentId!==fromDeploymentId)throw Error('handover_source_not_active');
  const generation='production-preparation-'+crypto.randomUUID(),at=clock().toISOString();
  const changed=await settings.findOneAndUpdate({_id:'production-preparation',enabled:true,deploymentId:fromDeploymentId,generation:before.generation,$or:[{leaseUntil:{$exists:false}},{leaseUntil:{$lte:at}}]},{$set:{deploymentId,generation,handoverAt:at,previousDeploymentId:fromDeploymentId}},{returnDocument:'after'});
  if(!changed)throw Error('handover_busy_or_fenced');
  await runtime.collections.audit.insertOne({action:'production_preparation_handover',fromDeploymentId,deploymentId,generation,at,publishingEnabled:false,outboundEnabled:false});
  return status();
 }
 async function stop(){await settings.updateOne({_id:'autonomy:policy'},{$set:{paused:true,enabled:false}},{upsert:true});await settings.updateOne({_id:'production-preparation'},{$set:{enabled:false,stoppedAt:clock().toISOString(),generation:'production-preparation-'+crypto.randomUUID()},$unset:{lease:'',leaseUntil:''}});}
 const backoffice=require('./growth-production-backoffice').createProductionBackoffice({runtime,config,status,clock});
 async function read(section,query={}){const view=await backoffice.read(section,query);if(view)return view;if(section==='overview')return{ok:true,overview:await runtime.overview()};if(section==='drafts')return{ok:true,drafts:await runtime.listDrafts({kind:query.kind,status:query.status,limit:Math.min(100,Number(query.limit)||30)})};const mapping={research:['prospects','shows'],affiliates:['affiliates','affiliates'],reports:['reports','reports'],alerts:['alerts','alerts'],audit:['audit','entries'],attribution:['attribution','events'],jobs:['jobs','jobs'],social:['social','posts']},entry=mapping[section];if(!entry)return{ok:false,reason:'production_read_route_not_found'};const filter=section==='affiliates'?{synthetic:{$ne:true},status:'active',liveAffiliateId:{$regex:'^[a-f0-9]{24}$'},'identityVerification.verified':true,'identityVerification.environment':'production','identityVerification.source':'website_affiliate_authority'}:{};return{ok:true,[entry[1]]:await runtime.collections[entry[0]].find(filter,{projection:{credentials:0,tokenSealed:0,verificationSealed:0}}).limit(100).toArray()};}
 async function recordOwnerAcceptance(owner){
  if(!owners.includes(owner))throw Error('verified_owner_required');
  const targets=[['overview','overview',{}],['approvals','drafts',{status:'needs_owner_review'}],['marketing','marketing/coverage',{}],['pr','research',{track:'pr'}],['affiliates','recruitment',{}],['publishing','social',{}],['posters','posters',{}],['automation','jobs',{}],['analytics','analytics',{}],['revenue','attribution',{}],['connections','connections',{}]],checks=[];
  for(const [page,section,query] of targets){try{const view=await read(section,query);checks.push({page,ok:view?.ok===true});}catch{checks.push({page,ok:false});}}
  const receipt={verifiedOwnerSession:true,at:clock().toISOString(),releaseCommit:config.releaseCommit,checks,allReadModelsPassed:checks.every(x=>x.ok),publishingEnabled:false,outboundEnabled:false};
  await settings.updateOne({_id:'owner-production-acceptance'},{$set:receipt},{upsert:true});await runtime.collections.audit.insertOne({action:'owner_production_acceptance',owner,...receipt});return{ok:receipt.allReadModelsPassed,...receipt};
 }
 async function workerReceipts(limit=20){return{ok:true,environment,receiptType:'preparation_only',receipts:await cycles.find({environment,trigger:'workflow_timer',completedAt:{$type:'string'}},{projection:{_id:1,generation:1,ordinal:1,cyclePurpose:1,jobsProcessed:1,preparationJobsProcessed:1,deploymentId:1,commit:1,workflowRunId:1,trigger:1,completedAt:1,environment:1,database:1,collectionPrefix:1,errors:1,websiteSessionUsed:1,ownerApprovalRequired:1,publishingEnabled:1,outboundEnabled:1,automaticApprovals:1,paymentMutations:1}}).sort({completedAt:-1}).limit(Math.min(100,Math.max(1,Number(limit)||20))).toArray()};}
 async function posterImage(id){
  if(!/^[a-f0-9]{20}-(portrait|story)$/.test(String(id)))return null;
  const image=await runtime.collections.posters.findOne({id,withdrawnAt:{$exists:false}});
  if(!image||image.art?.needsArtwork||!image.art?.used||image.qrDecoded!==image.qrUrl)return null;
  const draft=await runtime.collections.drafts.findOne({id:image.draftId,kind:'marketing',status:{$in:['needs_owner_review','approved']}});
  if(!draft||draft.poster?.status!=='ready'||draft.poster?.needsArtwork||draft.poster?.qr?.decodedMatches!==true||draft.poster?.qr?.destination?.ok!==true||![draft.poster?.portrait?.id,draft.poster?.story?.id].includes(id))return null;
  return runtime.posters.getImage(id);
 }
 async function preparePosterAssets(){
  if(environment!=='production'||await stopped()||!config.posters?.enabled)return{ok:true,skipped:'poster_preparation_not_active',publishingEnabled:false};
  const now=clock(),key='poster-assets:'+Math.floor(+now/900000),receipts=db.collection('poster_preparation_cycles');
  if(await receipts.findOne({_id:key,completedAt:{$exists:true}}))return{ok:true,duplicate:true,publishingEnabled:false};
  const token=crypto.randomUUID();await settings.updateOne({_id:'poster-preparation-lease'},{$setOnInsert:{createdAt:now.toISOString()}},{upsert:true});
  const lease=await settings.findOneAndUpdate({_id:'poster-preparation-lease',$or:[{until:{$exists:false}},{until:{$lte:now.toISOString()}}]},{$set:{token,until:new Date(+now+10*60000).toISOString()}},{returnDocument:'after'});if(!lease)return{ok:true,busy:true,publishingEnabled:false};
  try{
   if(await stopped())return{ok:true,skipped:'emergency_stop',publishingEnabled:false};
   const candidates=await runtime.collections.drafts.find({kind:'marketing',status:'needs_owner_review',editedBy:{$exists:false},editedAt:{$exists:false},editCount:{$not:{$gt:0}}}).limit(20).toArray(),ids=[];
   for(const d of candidates)if(await runtime.collections.contestVerifications.findOne({_id:d.contestId,fingerprint:d.contestFingerprint,eligible:true,verifiedAt:{$gte:new Date(+now-35*60000).toISOString()}}))ids.push(d.id);
   const result=ids.length?await runtime.ensurePosters(now,{ids,limit:2}):{generated:0,failed:[],waiting:0};
   await runtime.preparation.capture('marketing',clock());
   await receipts.updateOne({_id:key},{$setOnInsert:{completedAt:clock().toISOString(),environment,receiptType:'poster_preparation_only',result,publishingEnabled:false,outboundEnabled:false,ownerApprovalRequired:true}},{upsert:true});
   return{ok:true,...result,publishingEnabled:false,outboundEnabled:false};
  }catch{await runtime.collections.alerts.updateOne({alertKey:'production-poster-preparation'},{$set:{state:'open',error:'production_poster_preparation_failed',at:clock().toISOString()}},{upsert:true});throw Error('production_poster_preparation_failed');}
  finally{await settings.updateOne({_id:'poster-preparation-lease',token},{$unset:{token:'',until:''}});}
 }
 const review=require('./growth-production-review').createProductionReview({col:runtime.collections,quality:runtime.preparation.quality,clock});
 async function reviewDraft(id,decision){const result=await review.decide(id,decision);if(result.ok){const d=await runtime.collections.drafts.findOne({id});if(d)try{await runtime.preparation.capture(d.kind,clock());}catch{result.evidenceRefreshPending=true;}}return result;}
 async function ownerAction(route,body={},owner){
  if(!owners.includes(owner))return{ok:false,reason:'verified_production_owner_required'};
  let match;
  if((match=/^drafts\/([^/]+)\/edit$/.exec(route)))return backoffice.editDraft(match[1],{headline:body.headline,text:body.text,subject:body.subject,channel:body.channel,admin:owner,now:clock()});
  if((match=/^alerts\/([^/]+)\/ack$/.exec(route)))return runtime.ackAlert(match[1],{admin:owner});
  if((match=/^jobs\/([^/]+)\/requeue$/.exec(route)))return runtime.requeueJob(match[1],{admin:owner,now:clock()});
  if((match=/^preparation\/jobs\/([^/]+)\/requeue$/.exec(route))){const result=await runtime.preparation.requeue(match[1]);if(result.ok)await runtime.collections.audit.insertOne({action:'preparation_job_owner_requeue',id:match[1],admin:owner,at:clock().toISOString()});return result;}
  if(route==='suppressions'){const address=String(body.address||'').trim();if(address.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))return{ok:false,reason:'valid_email_required'};await runtime.suppression.suppress(address,{source:'operator',reason:body.reason,now:clock()});await runtime.collections.audit.insertOne({action:'suppress',admin:owner,at:clock().toISOString()});return{ok:true};}
  return{ok:false,reason:'owner_action_not_available'};
 }
 return{verifiedOwnerIds:owners,cycle,status,activate,handover,stop,read,recordOwnerAcceptance,workerReceipts,posterImage,preparePosterAssets,ownerAction,reviewDraft,sessionCollections:{nonces:runtime.collections.ssoNonces,revocations:runtime.collections.sessionRevocations,audit:runtime.collections.audit}};
}
module.exports={createProductionPreparation};
