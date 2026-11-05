'use strict';
// Shared safe monitoring/allowlist contract. No credential or provider-record writes.
const PREFIX='preview198_';
const SITE='https://fmm-ver2-growth-social-preview.vercel.app';
async function verifiedOwners(rawDb) {
 const rows=await rawDb.collection('growth_social_sso_audit').find({action:'sso_login',method:'website_admin',transport:'first_party_assertion',issuerConfirmed:true,site:SITE},{projection:{adminId:1}}).toArray();
 return [...new Set(rows.map(r=>String(r.adminId||'').toLowerCase()).filter(id=>/^[a-f0-9]{24}$/.test(id)))];
}
async function schedulerStatus(settings,now=new Date()) {
 const s=await settings.findOne({_id:'managed-scheduler'});
 const age=s?.lastScheduledAt?now.getTime()-Date.parse(s.lastScheduledAt):Infinity;
 return {schedulerEnabled:s?.enabled===true,provider:'vercel-workflow',generation:s?.generation||null,lastScheduledGeneration:s?.lastScheduledGeneration||null,lastWorkflowRunId:s?.lastWorkflowRunId||null,schedule:'every 15 minutes',healthy:s?.enabled===true&&!s.lastError&&(!s.generation||s.generation==='sandbox-v1'||s.lastScheduledGeneration===s.generation)&&age>=0&&age<=35*60000,lastScheduledAt:s?.lastScheduledAt||null,scheduledExecutions:s?.scheduledExecutions||0,lastRunId:s?.lastRunId||null,lastError:s?.lastError||null,nextWakeAt:s?.nextWakeAt||null,ownerAllowlistConfigured:(s?.ownerCount||0)>0,approvalMode:'owner_required',publishingEnabled:false,outboundEnabled:false};
}
module.exports={PREFIX,SITE,verifiedOwners,schedulerStatus};
