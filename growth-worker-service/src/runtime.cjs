'use strict';
const {MongoClient}=require('mongodb');
const {resolveGrowthRuntimeConfig,ISOLATED_PROJECT_ID}=require('../shared/growth-runtime-config');
const {createGrowthRuntime}=require('../shared/growth-runtime');
const {createDeliveryProvider}=require('../shared/growth-delivery-provider');
const {createExistingMetaReadOnly}=require('../shared/growth-existing-meta-readonly');
const {PREFIX,verifiedOwners,schedulerStatus}=require('../shared/growth-managed-scheduler');
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
 const owners=await verifiedOwners(raw);if(!owners.length)throw Error('verified_website_administrator_audit_missing');
 const settings=rt.collections.settings;
 await settings.updateOne({_id:'managed-owner-allowlist'},{$set:{ids:owners,provenance:'verified_first_party_website_admin_audit',updatedAt:new Date().toISOString()}},{upsert:true});
 await settings.updateOne({_id:'managed-scheduler'},{$setOnInsert:{enabled:true,generation:'sandbox-v1',createdAt:new Date().toISOString()},$set:{ownerCount:owners.length}},{upsert:true});
 const release=process.env.GROWTH_WORKER_RELEASE;
 if(release&&/^[a-z0-9-]{3,80}$/.test(release)&&process.env.GROWTH_WORKER_PREVIOUS_RELEASE){await settings.updateOne({_id:'managed-scheduler',enabled:true,generation:process.env.GROWTH_WORKER_PREVIOUS_RELEASE,$or:[{leaseUntil:{$exists:false}},{leaseUntil:{$lt:new Date().toISOString()}}]},{$set:{generation:release,rolloutAt:new Date().toISOString(),previousGeneration:process.env.GROWTH_WORKER_PREVIOUS_RELEASE}});}
 async function maintainConnections(){const response=await fetch('https://fantasymmadness-growth-git-585652-kelly-davis-projects-6c108d0b.vercel.app/api/growth/internal/connections/maintenance',{method:'POST',headers:{Authorization:'Bearer '+r.secrets.cronSecret,'Content-Type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(55000)});if(!response.ok)throw Error('connection_maintenance_unavailable');const result=await response.json();await settings.updateOne({_id:'connection-maintenance'},{$set:{at:new Date().toISOString(),result}},{upsert:true});return result;}
 return {rt,settings,maintainConnections,cycles:db.collection('managed_worker_cycles')};
 })().catch(e=>{ready=null;throw e;});}
async function cycle(generation,ordinal,metadata,context){
 const {rt,settings,cycles,maintainConnections}=context || await runtime();const s=await settings.findOne({_id:'managed-scheduler'});
 if(!s?.enabled||s.generation!==generation)return {stop:true};
 const now=new Date();const key=generation+':'+ordinal;
 const prior=await cycles.findOne({_id:key});if(prior?.finishedAt)return {stop:false,duplicate:true};
 // One global lease; expiry permits recovery after a killed function. Job leases also persist.
 const lease=await settings.findOneAndUpdate({_id:'managed-scheduler',enabled:true,generation,$or:[{leaseUntil:{$lt:now.toISOString()}},{leaseUntil:{$exists:false}}]},{$set:{leaseUntil:new Date(now.getTime()+10*60000).toISOString(),leaseOwner:key}},{returnDocument:'after'});
 if(!lease)return {stop:false,busy:true};
 try{
  await cycles.updateOne({_id:key},{$set:{startedAt:now.toISOString(),trigger:ordinal?'workflow_timer':'bootstrap',workflowRunId:metadata.workflowRunId,ordinal},$inc:{attempts:1}},{upsert:true});
  await rt.autonomy.heartbeat('vercel-workflow');
  if(!context&&!await rt.autonomy.isPaused()){
   const marker=await settings.findOne({_id:'quality-refinement-v2'});if(!marker){
    const approved=await rt.collections.drafts.find({status:'approved'},{projection:{_id:0,id:1,text:1,html:1,posts:1,poster:1}}).sort({id:1}).toArray();
    const protectedBefore=require('node:crypto').createHash('sha256').update(JSON.stringify(approved)).digest('hex');
    const marketing=await rt.refreshMarketing(new Date(),{trigger:'staging_quality_refinement'});const emails=await rt.refineEmailDrafts();
    const after=await rt.collections.drafts.find({status:'approved'},{projection:{_id:0,id:1,text:1,html:1,posts:1,poster:1}}).sort({id:1}).toArray();
    const approvedPreserved=protectedBefore===require('node:crypto').createHash('sha256').update(JSON.stringify(after)).digest('hex');
    if(!approvedPreserved)throw Error('approved_content_changed');
    await settings.updateOne({_id:'quality-refinement-v2'},{$set:{at:new Date().toISOString(),marketing:marketing.refinement,emails,approvedPreserved}},{upsert:true});
   }
  }
  const summary=await rt.tick();
  if(maintainConnections&&!await rt.autonomy.isPaused()){try{summary.connections=await maintainConnections();}catch{summary.errors.push({id:'connection_maintenance',message:'Connection status or renewal unavailable; inspect Connections.'});}}
  const errors=(summary.errors||[]).length+(summary.jobs||[]).filter(j=>!j.ok).length;
  const finished=new Date();
  await cycles.updateOne({_id:key},{$set:{finishedAt:finished.toISOString(),runId:summary.runId,jobCount:(summary.jobs||[]).length,errorCount:errors,skipped:summary.skipped||null,outbound:false,publishing:false}});
  const update={$set:{lastWorkflowRunId:metadata.workflowRunId||null,lastRunId:summary.runId,lastCycleAt:finished.toISOString(),lastError:errors?'workstream_error_check_execution_log':null,nextWakeAt:new Date(finished.getTime()+(ordinal<2?65000:900000)).toISOString()},$unset:{leaseUntil:'',leaseOwner:''}};
  if(ordinal){update.$set.lastScheduledAt=finished.toISOString();update.$set.lastScheduledGeneration=generation;update.$inc={scheduledExecutions:1};}
  await settings.updateOne({_id:'managed-scheduler',leaseOwner:key},update);
  const evidence=!context?{recruitment:(await rt.recruitment.list()).filter(p=>p.researchedAt).slice(0,8).map(p=>({id:p.id,name:p.name,sport:p.sport,partnerType:p.partnerType,sourceUrl:p.sourceUrl,contactVerified:p.contact?.verified===true,status:p.status,error:p.error||null})),invitationPreviews:(await rt.collections.drafts.find({kind:'affiliate',status:'needs_owner_review',emailQualityVersion:{$in:[2,3]}},{projection:{_id:0,id:1,subject:1,text:1,approvalBlockers:1}}).limit(3).toArray())}:undefined;
  return {stop:false,...(evidence?{evidence}:{})};
 }catch(e){await settings.updateOne({_id:'managed-scheduler',leaseOwner:key},{$set:{lastError:'worker_cycle_failed'},$unset:{leaseUntil:'',leaseOwner:''}});throw Error('sandbox_worker_cycle_failed');}
}
async function status(){const {settings,rt}=await runtime();const m=await settings.findOne({_id:'quality-refinement-v2'}),connections=await settings.findOne({_id:'connection-maintenance'});return {...await schedulerStatus(settings),refinement:m?{marketing:m.marketing,emails:m.emails,approvedPreserved:m.approvedPreserved}:null,connections:connections?{at:connections.at,oauth:(connections.result.connections||[]).map(x=>({provider:x.provider,status:x.status,reason:x.reason||null,refreshAvailable:x.refreshAvailable,grantedScopes:x.grantedScopes})),meta:connections.result.meta}:null,recruitment:{discovered:await rt.collections.recruitment.countDocuments({}),researched:await rt.collections.recruitment.countDocuments({researchedAt:{$exists:true}}),drafts:await rt.collections.drafts.countDocuments({recruitmentSource:'independent_public_partner'})}};}
module.exports={runtime,cycle,status,validate};
