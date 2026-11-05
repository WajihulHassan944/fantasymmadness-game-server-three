'use strict';
const crypto=require('node:crypto');
const {assertProductionDatabase,productionReadOnlyFetch,PREFIX}=require('./growth-production-preparation-config');
// Only this validated composition root can open the new production namespace.
// No staging copy, affiliate signup, OAuth exchange, payment or send API exists.
async function createProductionPreparation({rawDb,config,secrets,fetchImpl,verifiedOwnerIds,clock=()=>new Date(),runtimeFactory}={}){
 assertProductionDatabase(rawDb,config);
 const owners=config.autonomy.owners;
 if(!Array.isArray(verifiedOwnerIds)||!owners.every(id=>verifiedOwnerIds.includes(id)))throw Error('production_first_party_owner_evidence_required');
 const db={databaseName:rawDb.databaseName,collection:name=>{if(!/^[a-z_]+$/.test(name)||name.startsWith('preview'))throw Error('production_collection_not_permitted');return rawDb.collection(PREFIX+name);}};
 const provider=Object.freeze({name:'none',realDelivery:false,send:async()=>{throw Error('production_preparation_delivery_disabled');}});
 const runtime=(runtimeFactory||require('./growth-runtime').createGrowthRuntime)({db,config,secrets,provider,fetchImpl:productionReadOnlyFetch(fetchImpl),alertSender:null});
 await runtime.init();
 const settings=runtime.collections.settings,cycles=db.collection('preparation_cycles');
 await settings.updateOne({_id:'production-preparation'},{$setOnInsert:{enabled:false,generation:'production-preparation-v1',createdAt:clock().toISOString()},$set:{ownerCount:owners.length,approvalMode:'owner_required',publishingEnabled:false,outboundEnabled:false}},{upsert:true});
 const stopped=async()=>{const s=await settings.findOne({_id:'production-preparation'}),p=await settings.findOne({_id:'autonomy:policy'});return !s?.enabled||p?.paused===true;};
 async function cycle({generation,ordinal,deploymentId}){
  const state=await settings.findOne({_id:'production-preparation'});if(await stopped()||state.generation!==generation||state.deploymentId!==deploymentId)return{stop:true};
  const now=clock(),bucket=Math.floor(+now/900000),key=generation+':'+bucket,lease=crypto.randomUUID();
  const existing=await cycles.findOne({_id:key});if(existing?.completedAt)return{stop:false,duplicate:true};
  const claimed=await settings.findOneAndUpdate({_id:'production-preparation',enabled:true,generation,deploymentId,$or:[{leaseUntil:{$exists:false}},{leaseUntil:{$lte:now.toISOString()}}]},{$set:{lease,leaseUntil:new Date(+now+10*60000).toISOString()}},{returnDocument:'after'});if(!claimed)return{stop:false,busy:true};
  try{
   if(await stopped())return{stop:true};
   // No dispatch/autonomy/publisher/affiliate mutation methods are exposed.
   const report=await runtime.tick({now,preparationOnly:true});
   if(await stopped())return{stop:true};
   const preparation=await runtime.preparation.run(now),operations=await runtime.preparation.summary();
   const finished=clock(),current=await settings.findOne({_id:'production-preparation',enabled:true,generation,deploymentId,lease,leaseUntil:{$gt:finished.toISOString()}});if(!current)return{stop:true,leaseLost:true};
   const errors=(report.errors||[]).length+(preparation.jobs||[]).filter(j=>!j.ok).length;
   const evidence={generation,ordinal,completedAt:finished.toISOString(),environment:'production',database:rawDb.databaseName,collectionPrefix:PREFIX,operations,errors,websiteSessionUsed:false,ownerApprovalRequired:true,publishingEnabled:false,outboundEnabled:false,automaticApprovals:0,paymentMutations:0};
   await cycles.updateOne({_id:key},{$setOnInsert:evidence},{upsert:true});
   await settings.updateOne({_id:'production-preparation',enabled:true,generation,deploymentId,lease},{$set:{lastCompletedAt:evidence.completedAt,nextWakeAt:new Date(+finished+900000).toISOString(),lastError:errors?'preparation_jobs_require_review':null},$inc:{completedCycles:1}});
   return{stop:false,evidence};
  }catch{await settings.updateOne({_id:'production-preparation',lease},{$set:{lastError:'production_preparation_cycle_failed'}});await runtime.collections.alerts.updateOne({alertKey:'production-preparation'},{$set:{state:'open',error:'production_preparation_cycle_failed',action:'Inspect jobs; external actions remain disabled.',at:clock().toISOString()}},{upsert:true});throw Error('production_preparation_cycle_failed');}
  finally{await settings.updateOne({_id:'production-preparation',lease},{$unset:{lease:'',leaseUntil:''}});}
 }
 async function status(){const s=await settings.findOne({_id:'production-preparation'});return{environment:'production',database:rawDb.databaseName,collectionPrefix:PREFIX,scheduler:{enabled:s?.enabled===true,generation:s?.generation,lastCompletedAt:s?.lastCompletedAt||null,completedCycles:s?.completedCycles||0,healthy:s?.enabled===true&&!s.lastError&&Boolean(s.lastCompletedAt)&&+clock()-Date.parse(s.lastCompletedAt)<=35*60000,lastError:s?.lastError||null},operations:await runtime.preparation.summary(),ownerApprovalRequired:true,publishingEnabled:false,outboundEnabled:false,paymentMutationsEnabled:false,syntheticImportsSupported:false};}
 async function activate({deploymentId,confirmation}){if(confirmation!=='ACTIVATE PRODUCTION PREPARATION ONLY'||!/^dpl_[A-Za-z0-9]+$/.test(deploymentId||''))throw Error('explicit_verified_deployment_activation_required');const state=await settings.findOne({_id:'production-preparation'});if(state?.enabled&&state.deploymentId!==deploymentId)throw Error('another_production_deployment_is_active');await settings.updateOne({_id:'autonomy:policy'},{$set:{paused:false,enabled:false}},{upsert:true});await settings.updateOne({_id:'production-preparation',enabled:false},{$set:{enabled:true,deploymentId,activatedAt:clock().toISOString()}});}
 async function stop(){await settings.updateOne({_id:'autonomy:policy'},{$set:{paused:true,enabled:false}},{upsert:true});await settings.updateOne({_id:'production-preparation'},{$set:{enabled:false,stoppedAt:clock().toISOString(),generation:'production-preparation-'+crypto.randomUUID()},$unset:{lease:'',leaseUntil:''}});}
 async function read(section,query={}){if(section==='overview')return{ok:true,overview:await runtime.overview()};if(section==='drafts')return{ok:true,drafts:await runtime.listDrafts({kind:query.kind,status:query.status,limit:Math.min(100,Number(query.limit)||30)})};const mapping={research:['prospects','shows'],affiliates:['affiliates','affiliates'],reports:['reports','reports'],alerts:['alerts','alerts'],audit:['audit','entries'],attribution:['attribution','events'],jobs:['jobs','jobs'],social:['social','posts']},entry=mapping[section];if(!entry)return{ok:true,mode:'production_preparation',...await status()};const filter=section==='affiliates'?{synthetic:{$ne:true},status:'active',liveAffiliateId:{$regex:'^[a-f0-9]{24}$'},'identityVerification.verified':true,'identityVerification.environment':'production','identityVerification.source':'website_affiliate_authority'}:{};return{ok:true,[entry[1]]:await runtime.collections[entry[0]].find(filter,{projection:{credentials:0,tokenSealed:0,verificationSealed:0}}).limit(100).toArray()};}
 return{cycle,status,activate,stop,read,sessionCollections:{nonces:runtime.collections.ssoNonces,revocations:runtime.collections.sessionRevocations,audit:runtime.collections.audit}};
}
module.exports={createProductionPreparation};
