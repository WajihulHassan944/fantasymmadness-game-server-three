'use strict';
// Shared safe monitoring/allowlist contract. No credential or provider-record writes.
const PREFIX='preview198_';
const SITE='https://fmm-ver2-growth-social-preview.vercel.app';
async function verifiedOwners(rawDb) {
 const rows=await rawDb.collection('growth_social_sso_audit').find({action:'sso_login',method:'website_admin',transport:'first_party_assertion',issuerConfirmed:true,site:SITE},{projection:{adminId:1}}).toArray();
 return [...new Set(rows.map(r=>String(r.adminId||'').toLowerCase()).filter(id=>/^[a-f0-9]{24}$/.test(id)))];
}
async function pinnedOwners(rawDb,settings,configured=[]){
 const verified=await verifiedOwners(rawDb),saved=await settings.findOne({_id:'managed-owner-allowlist'});
 const explicit=(saved?.ids?.length?saved.ids:configured.filter(id=>/^[a-f0-9]{24}$/i.test(id))).map(x=>String(x).toLowerCase());
 const owners=explicit.length?explicit.filter(id=>verified.includes(id)):verified.length===1?verified:[];
 if(!owners.length)throw Error('explicit_verified_owner_binding_required');return [...new Set(owners)];
}
async function schedulerStatus(settings,now=new Date()) {
 const s=await settings.findOne({_id:'managed-scheduler'});
 const policy=await settings.findOne({_id:'autonomy:policy'});
 const age=s?.lastScheduledAt?now.getTime()-Date.parse(s.lastScheduledAt):Infinity;
 return {schedulerEnabled:s?.enabled===true,preparationEnabled:s?.enabled===true&&policy?.paused!==true,preparationPaused:policy?.paused===true,provider:'vercel-workflow',resumePending:s?.enabled===true&&Boolean(s?.resumedAt)&&s.lastScheduledGeneration!==s.generation,workerBindingReady:Boolean(s?.workerRelease&&s?.workerDeploymentId&&s?.workerOrigin),generation:s?.generation||null,lastScheduledGeneration:s?.lastScheduledGeneration||null,lastWorkflowRunId:s?.lastWorkflowRunId||null,schedule:'every 15 minutes',healthy:s?.enabled===true&&!s.lastError&&(!s.generation||s.generation==='sandbox-v1'||s.lastScheduledGeneration===s.generation)&&age>=0&&age<=35*60000,lastScheduledAt:s?.lastScheduledAt||null,scheduledExecutions:s?.scheduledExecutions||0,generationScheduledExecutions:s?.generationScheduledExecutions||0,lastRunId:s?.lastRunId||null,lastError:s?.lastError||null,nextWakeAt:s?.nextWakeAt||null,ownerAllowlistConfigured:(s?.ownerCount||0)>0,approvalMode:'owner_required',publishingEnabled:false,outboundEnabled:false};
}
async function activateRelease(settings,{release,previous,deploymentId=null,origin=null,now=new Date()}={}){if(!/^[a-z0-9-]{3,80}$/.test(release||'')||!previous)return{modifiedCount:0};return settings.updateOne({_id:'managed-scheduler',enabled:true,generation:previous,$or:[{leaseUntil:{$exists:false}},{leaseUntil:{$lt:now.toISOString()}}]},{$set:{generation:release,workerRelease:release,workerDeploymentId:deploymentId,workerOrigin:origin,rolloutAt:now.toISOString(),previousGeneration:previous,generationScheduledExecutions:0}});}
module.exports={PREFIX,SITE,verifiedOwners,pinnedOwners,schedulerStatus,activateRelease};
