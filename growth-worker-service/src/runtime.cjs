'use strict';
const {MongoClient}=require('mongodb');
const {resolveGrowthRuntimeConfig,ISOLATED_PROJECT_ID}=require('../shared/growth-runtime-config');
const {createGrowthRuntime}=require('../shared/growth-runtime');
const {createDeliveryProvider}=require('../shared/growth-delivery-provider');
const {createExistingMetaReadOnly}=require('../shared/growth-existing-meta-readonly');
const {PREFIX,pinnedOwners,schedulerStatus,activateRelease}=require('../shared/growth-managed-scheduler');
let ready;
function validate(env=process.env){
 const r=resolveGrowthRuntimeConfig(env);
 if(!r.ok||env.VERCEL_ENV!=='preview'||env.VERCEL_PROJECT_ID!==ISOLATED_PROJECT_ID||env.GROWTH_MANAGED_SCHEDULER!=='true'||env.GROWTH_OUTBOUND_ENABLED!=='false'||env.GROWTH_SOCIAL_PROVIDER!=='sandbox'||env.GROWTH_DELIVERY_PROVIDER!=='sandbox-capture'||env.GROWTH_AUTOMATION_LIVE_APPROVED==='true'||env.GROWTH_SOCIAL_PUBLISHING_APPROVED==='true'||!r.config.database.hostPinned)throw Error('isolated_sandbox_worker_configuration_required');
 return r;
}
async function runtime(){return ready ||= (async()=>{
 const r=validate();const client=await new MongoClient(r.secrets.mongoUri,{maxPoolSize:3,serverSelectionTimeoutMS:10000}).connect();const raw=client.db('fmgrowthtest');
 const db={databaseName:'fmgrowthtest',collection:n=>{if(!/^[a-z_]+$/.test(n))throw Error('invalid_collection');return raw.collection(PREFIX+n);}};
 const provider=createDeliveryProvider({config:r.config,secrets:r.secrets,captureCollection:db.collection('growth_sandbox_mail')});
 const rt=createGrowthRuntime({db,config:r.config,secrets:r.secrets,provider,metaConnection:createExistingMetaReadOnly({db:raw,env:process.env})});await rt.init();
 // Scheduled operation prepares work. No policy can grant this worker approval authority.
 rt.autonomy.run=async()=>({skipped:'owner_approval_required'});
 const settings=rt.collections.settings;const owners=await pinnedOwners(raw,settings,r.config.autonomy.owners);
 await settings.updateOne({_id:'managed-owner-allowlist'},{$set:{ids:owners,provenance:'pinned_verified_first_party_owner',updatedAt:new Date().toISOString()}},{upsert:true});
 await settings.updateOne({_id:'managed-scheduler'},{$setOnInsert:{enabled:true,generation:'sandbox-v1',createdAt:new Date().toISOString()},$set:{ownerCount:owners.length}},{upsert:true});
 async function ensureRelease(){if(await rt.autonomy.isPaused())return{modifiedCount:0};return activateRelease(settings,{release:process.env.GROWTH_WORKER_RELEASE,previous:process.env.GROWTH_WORKER_PREVIOUS_RELEASE,deploymentId:process.env.VERCEL_DEPLOYMENT_ID,origin:process.env.VERCEL_URL?'https://'+process.env.VERCEL_URL:null});}
 await ensureRelease();
 async function maintainConnections(){const response=await fetch('https://fantasymmadness-growth-git-585652-kelly-davis-projects-6c108d0b.vercel.app/api/growth/internal/connections/maintenance',{method:'POST',headers:{Authorization:'Bearer '+r.secrets.cronSecret,'Content-Type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(55000)});if(!response.ok)throw Error('connection_maintenance_unavailable');const result=await response.json();await settings.updateOne({_id:'connection-maintenance'},{$set:{at:new Date().toISOString(),result}},{upsert:true});return result;}
 return {rt,settings,ensureRelease,maintainConnections,cycles:db.collection('managed_worker_cycles')};
 })().catch(e=>{ready=null;throw e;});}
async function cycle(generation,ordinal,metadata,context){
 const {rt,settings,cycles,maintainConnections}=context || await runtime();const s=await settings.findOne({_id:'managed-scheduler'});
 if(!s?.enabled||s.generation!==generation||!context&&s.workerDeploymentId&&s.workerDeploymentId!==process.env.VERCEL_DEPLOYMENT_ID)return {stop:true};
 const now=new Date();const key=generation+':'+ordinal;const cycleLease=require('node:crypto').randomUUID();
 const prior=await cycles.findOne({_id:key});if(prior?.finishedAt)return {stop:false,duplicate:true};
 // One global lease; expiry permits recovery after a killed function. Job leases also persist.
 const lease=await settings.findOneAndUpdate({_id:'managed-scheduler',enabled:true,generation,$or:[{leaseUntil:{$lt:now.toISOString()}},{leaseUntil:{$exists:false}}]},{$set:{leaseUntil:new Date(now.getTime()+10*60000).toISOString(),leaseOwner:key,leaseToken:cycleLease}},{returnDocument:'after'});
 if(!lease)return {stop:false,busy:true};
 try{
  await cycles.updateOne({_id:key},{$set:{cycleLease,startedAt:now.toISOString(),trigger:ordinal?'workflow_timer':'bootstrap',workflowRunId:metadata.workflowRunId,ordinal},$inc:{attempts:1}},{upsert:true});
  await rt.autonomy.heartbeat('vercel-workflow');
  if(!context&&!await rt.autonomy.isPaused()){
   const marker=await settings.findOne({_id:'quality-refinement-v2'});if(!marker){
    const approved=await rt.collections.drafts.find({status:'approved'},{projection:{_id:0,id:1,text:1,html:1,posts:1,poster:1}}).sort({id:1}).toArray();
    const protectedBefore=require('node:crypto').createHash('sha256').update(JSON.stringify(approved)).digest('hex');
    await rt.recruitment.seedInitialSources();
    const marketing=await rt.refreshMarketing(new Date(),{trigger:'staging_quality_refinement'});const emails=await rt.refineEmailDrafts();
    const after=await rt.collections.drafts.find({status:'approved'},{projection:{_id:0,id:1,text:1,html:1,posts:1,poster:1}}).sort({id:1}).toArray();
    const approvedPreserved=protectedBefore===require('node:crypto').createHash('sha256').update(JSON.stringify(after)).digest('hex');
    if(!approvedPreserved)throw Error('approved_content_changed');
    await settings.updateOne({_id:'quality-refinement-v2'},{$set:{at:new Date().toISOString(),marketing:marketing.refinement,emails,approvedPreserved}},{upsert:true});
   }
  }
  if(!context&&!await rt.autonomy.isPaused()&&!await settings.findOne({_id:'poster-runtime-repair-v3'})){
   const refreshed=await rt.refreshMarketing(new Date(),{trigger:'poster_runtime_repair_v3'});
   if(!refreshed.sourceReachable||refreshed.posters?.error||refreshed.posters?.failed?.length)throw Error('poster_runtime_repair_incomplete');
   const drafts=await rt.collections.drafts.find({kind:'marketing',status:'needs_owner_review','poster.renderVersion':require('../shared/growth-poster-studio').RENDER_VERSION}).toArray();
   const remainingRuntimeAlerts=await rt.collections.alerts.countDocuments({kind:'poster',state:'open',error:{$regex:'(__dirname is not defined|renderPremium is not a function)'}});
   const repair={remainingRuntimeAlerts,at:new Date().toISOString(),generated:refreshed.posters?.generated||0,ready:drafts.filter(d=>d.poster.status==='ready'&&!d.poster.needsArtwork).length,held:drafts.filter(d=>d.poster.status!=='ready'||d.poster.needsArtwork).length,sports:refreshed.coverage.sports,sourceReachable:refreshed.coverage.sourceReachable,sourceErrors:refreshed.coverage.sourceErrors};
   await settings.updateOne({_id:'poster-runtime-repair-v3'},{$set:repair},{upsert:true});
  }
  const summary=await rt.tick({preparationOnly:true});
  if(!context&&!await rt.autonomy.isPaused())summary.preparation=await rt.preparation.run();
  if(maintainConnections&&!await rt.autonomy.isPaused()){try{summary.connections=await maintainConnections();}catch{summary.errors.push({id:'connection_maintenance',message:'Connection status or renewal unavailable; inspect Connections.'});}}
  const errors=(summary.preparation?.jobs||[]).filter(j=>!j.ok).length+(summary.errors||[]).length+(summary.jobs||[]).filter(j=>!j.ok).length;
  const finished=new Date();
  const owned=await settings.findOne({_id:'managed-scheduler',generation,leaseOwner:key,leaseToken:cycleLease,leaseUntil:{$gt:finished.toISOString()}});if(!owned)return{stop:false,leaseLost:true};
  const settledCycle=await cycles.updateOne({_id:key,cycleLease},{$set:{finishedAt:finished.toISOString(),runId:summary.runId,jobCount:(summary.jobs||[]).length+(summary.preparation?.jobs||[]).length,errorCount:errors,skipped:summary.skipped||null,outbound:false,publishing:false}});if(!settledCycle.modifiedCount)return{stop:false,leaseLost:true};
  if(!context)await rt.collections.runs.updateOne({runId:summary.runId},{$set:{workerGeneration:generation,workerPreparation:{completed:(summary.preparation?.jobs||[]).filter(j=>j.ok).length,failed:(summary.preparation?.jobs||[]).filter(j=>!j.ok).length,mode:'preparation_only'},errorCount:errors,state:errors?'failed':'completed',finishedAt:finished.toISOString()}});
  const update={$set:{lastWorkflowRunId:metadata.workflowRunId||null,lastRunId:summary.runId,lastCycleAt:finished.toISOString(),lastError:errors?'workstream_error_check_execution_log':null,nextWakeAt:new Date(finished.getTime()+(ordinal<2?65000:900000)).toISOString()},$unset:{leaseUntil:'',leaseOwner:'',leaseToken:''}};
  if(ordinal){update.$set.lastScheduledAt=finished.toISOString();update.$set.lastScheduledGeneration=generation;update.$inc={scheduledExecutions:1,generationScheduledExecutions:1};}
  await settings.updateOne({_id:'managed-scheduler',generation,leaseOwner:key,leaseToken:cycleLease},update);
  if(!context)await rt.collections.reports.updateOne({day:finished.toISOString().slice(0,10).replaceAll('-','')},{$set:{preparation:await rt.preparation.summary(),preparationCheckedAt:finished.toISOString()}},{upsert:false});
  if(!context)await rt.collections.alerts.updateMany({kind:'worker',id:key,state:'open'},{$set:{state:'acknowledged',ackBy:'verified-worker-recovery',ackAt:finished.toISOString()}});
  const evidence=!context?{checkedAt:finished.toISOString(),operations:await rt.preparation.summary(),connections:summary.connections?{at:finished.toISOString(),oauth:(summary.connections.connections||[]).map(({identity,username,displayName,...safe})=>safe),meta:summary.connections.meta,permissions:summary.connections.metaPermissions}:null,jobResults:summary.preparation?.jobs||[],errors,websiteSessionUsed:false,outboundEnabled:false,publishingEnabled:false}:undefined;
  return {stop:false,...(evidence?{evidence}:{})};
 }catch(e){if(!await settings.findOne({_id:'managed-scheduler',generation,leaseOwner:key,leaseToken:cycleLease})){const observed=await settings.findOne({_id:'managed-scheduler'});return{stop:!observed?.enabled||observed.generation!==generation,leaseLost:true};}if(!context)await rt.collections.alerts.updateOne({alertKey:'worker:'+key},{$setOnInsert:{alertKey:'worker:'+key,kind:'worker',id:key,createdAt:new Date().toISOString()},$set:{state:'open',error:'sandbox_worker_cycle_failed',action:'Automatic retry is bounded; inspect the durable run and preparation queue. No external delivery is authorized.'}},{upsert:true});await settings.updateOne({_id:'managed-scheduler',generation,leaseOwner:key,leaseToken:cycleLease},{$set:{lastError:'worker_cycle_failed'},$unset:{leaseUntil:'',leaseOwner:'',leaseToken:''}});throw Error('sandbox_worker_cycle_failed');}
}
async function status(){const {settings,rt}=await runtime();const m=await settings.findOne({_id:'quality-refinement-v2'}),connections=await settings.findOne({_id:'connection-maintenance'});const repair=await settings.findOne({_id:'poster-runtime-repair-v3'});return {...await schedulerStatus(settings),operations:await rt.preparation.summary(),posterRepair:repair?{at:repair.at,ready:repair.ready,held:repair.held,generated:repair.generated,remainingRuntimeAlerts:repair.remainingRuntimeAlerts,sourceReachable:repair.sourceReachable,sourceErrors:repair.sourceErrors,sports:Object.fromEntries(Object.entries(repair.sports).map(([k,v])=>[k,{verifiedContests:v.verifiedContests,campaignsActive:v.campaignsActive,rejectedContests:v.rejectedContests}]))}:null,refinement:m?{marketing:m.marketing,emails:m.emails,approvedPreserved:m.approvedPreserved}:null,connections:connections?{at:connections.at,oauth:(connections.result.connections||[]).map(x=>({provider:x.provider,status:x.status,accessStatus:x.accessStatus,renewalStatus:x.renewalStatus,warnings:x.warnings||[],reason:x.reason||null,refreshAvailable:x.refreshAvailable,grantedScopes:x.grantedScopes})),meta:connections.result.meta,metaScopesVerified:connections.result.metaPermissions?.verified===true,metaScopeReason:connections.result.metaPermissions?.reason||null}:null,recruitment:{discovered:await rt.collections.recruitment.countDocuments({}),researched:await rt.collections.recruitment.countDocuments({researchedAt:{$exists:true}}),drafts:await rt.collections.drafts.countDocuments({recruitmentSource:'independent_public_partner'})}};}
module.exports={runtime,cycle,status,validate};
