'use strict';
// Stage 8 end-to-end OFFLINE contract: no real recipients, network, mail, DB or payments.
const assert=require('node:assert/strict');
const {coordinateCampaign}=require('./growth-campaign-coordinator');
const {stagingPreflight}=require('./growth-staging-preflight');
const now=Date.parse('2026-11-10T12:00:00Z');
const contacts=[
 {id:'press1',category:'media',contact:'press@example.invalid'},
 {id:'fighter1',category:'affiliate',contact:'fighter@example.invalid'},
 {id:'duplicate',category:'media',contact:'PRESS@example.invalid'},
 {id:'suppressed',category:'affiliate',contact:'stop@example.invalid',optedOut:true},
 {id:'real-address',category:'media',contact:'real@example.com'}
];
const records=[
 {id:'responded',sent:true,deliveryVerified:true,replied:true,ownerApproved:true,lastSentAt:'2026-11-01T12:00:00Z',followupCount:0},
 {id:'due',sent:true,deliveryVerified:true,ownerApproved:true,lastSentAt:'2026-11-01T12:00:00Z',followupCount:0},
 {id:'unverified',sent:true,deliveryVerified:false,ownerApproved:true,lastSentAt:'2026-11-01T12:00:00Z',followupCount:0}
];
const out=coordinateCampaign({campaignId:'campaign-001',prospects:contacts,existingRecords:records,nowMs:now});
assert.equal(out.queue.length,2);
assert.deepEqual(out.followups.map(x=>x.decision.action),['stop','draft_followup','hold']);
assert.equal(out.metrics.sent,3);
assert.equal(out.metrics.delivered,2);
assert.equal(out.metrics.replied,1);
assert.equal(out.outboundEnabled,false);
assert.equal(out.productionWrites,0);
assert.ok(out.queue.every(x=>x.status==='draft'&&!x.sent&&!x.approved));
const preflight=stagingPreflight({GROWTH_STAGING_MODE:'pending_isolation',GROWTH_OUTBOUND_ENABLED:'false'});
assert.equal(preflight.ready,false);
assert.equal(preflight.realDeliveryPermitted,false);
assert.ok(preflight.failures.includes('dedicated_database_attestation_required'));
console.log('STAGE8_END_TO_END_OFFLINE '+JSON.stringify({result:'passed',drafts:out.queue.length,followupDrafts:out.departments.followups.draftCount,report:out.metrics,preflightReady:preflight.ready,externalSends:0,productionWrites:0}));
