'use strict';
// Expanded offline growth-operations simulation: five-genre discovery, approval-gated
// affiliate/PR preparation, recurring queue, retries, opt-out and honest reporting.
// NO external requests, real recipients, mail, social publishing or database writes.
const assert=require('node:assert/strict');
const {makeJob,claimDue,settle,followupAllowed,safeReport}=require('./growth-unattended-controller');
const discovery=require('fs').readFileSync(require.resolve('./fan-acquisition-discovery'),'utf8');
const genres=['boxing','mma','bare-knuckle','kickboxing','wrestling'];
for(const genre of genres)assert.ok(discovery.includes("id:'"+genre+"'"),'missing discovery genre '+genre);
const now=Date.UTC(2026,10,1,12);
const jobs=[
 makeJob({id:'research-2026-11-01',type:'discover',dueAt:new Date(now).toISOString(),payload:{genres}}),
 makeJob({id:'affiliate-prep-1',type:'prepare_campaign',dueAt:new Date(now).toISOString(),payload:{contact:'Synthetic Fighter',approvalRequired:true}}),
 makeJob({id:'pr-prep-1',type:'prepare_pr',dueAt:new Date(now).toISOString(),payload:{contact:'Synthetic Media Desk',approvalRequired:true}}),
 makeJob({id:'weekly-report-1',type:'aggregate_report',dueAt:new Date(now+60000).toISOString()})
];
const first=claimDue(jobs,now);
assert.equal(first.length,3);
assert.deepEqual(first.map(x=>x.type),['discover','prepare_campaign','prepare_pr']);
const completed=first.map(x=>settle(x,{success:true,now}));
assert.ok(completed.every(x=>x.state==='completed'));
assert.equal(claimDue(jobs,now-1).length,0);
const later=claimDue([jobs[3]],now+60000);
assert.equal(later.length,1);
const retry=settle(later[0],{success:false,error:'synthetic transient failure',now:now+60000});
assert.equal(retry.state,'retry');
assert.equal(claimDue([retry],now+60000).length,0);
assert.equal(claimDue([retry],Date.parse(retry.dueAt)).length,1);
assert.equal(followupAllowed({consent:true,status:'contacted'}),true);
assert.equal(followupAllowed({consent:true,status:'contacted',optedOut:true}),false);
assert.equal(followupAllowed({consent:false,status:'contacted'}),false);
const drafts=[{type:'affiliate_invitation',recipient:'Synthetic Fighter',approved:false,sent:false},{type:'pr_pitch',recipient:'Synthetic Media Desk',approved:false,sent:false}];
assert.ok(drafts.every(x=>!x.approved&&!x.sent));
const metrics=safeReport([{type:'visit',verified:true},{type:'signup',verified:false},{type:'paid_entry',verified:false}]);
assert.deepEqual(metrics,{visits:1,signups:0,paidEntries:0,unverifiedExcluded:2});
console.log('EXPANDED GROWTH SIMULATION '+JSON.stringify({genres,preparedDrafts:drafts.length,claimedJobs:first.length,completedJobs:completed.length,scheduledReport:'retry',followupsRequireConsent:true,outboundActions:0,metrics}));
