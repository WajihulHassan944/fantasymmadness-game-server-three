'use strict';
const assert=require('node:assert/strict');
const {coordinateCampaign}=require('./growth-campaign-coordinator');
const prospects=[
 {id:'media1',category:'media',contact:'press@example.invalid',optedOut:false},
 {id:'affiliate1',category:'affiliate',contact:'fighter@example.invalid',optedOut:false},
 {id:'dupe',category:'media',contact:'PRESS@example.invalid',optedOut:false},
 {id:'optout',category:'affiliate',contact:'stop@example.invalid',optedOut:true}
];
const existingRecords=[
 {id:'delivered',lastSentAt:'2026-11-01T12:00:00Z',deliveryVerified:true,ownerApproved:true,followupCount:0,sent:true,verifiedPaidEntries:1},
 {id:'replied',lastSentAt:'2026-11-01T12:00:00Z',deliveryVerified:true,ownerApproved:true,followupCount:0,replied:true,sent:true},
 {id:'unapproved',lastSentAt:'2026-11-01T12:00:00Z',deliveryVerified:true,ownerApproved:false,followupCount:0}
];
const out=coordinateCampaign({campaignId:'campaign-001',prospects,existingRecords,nowMs:Date.parse('2026-11-10T12:00:00Z')});
assert.equal(out.mode,'DRAFT_ONLY');
assert.equal(out.outboundEnabled,false);
assert.equal(out.productionWrites,0);
assert.equal(out.queue.length,2);
assert.equal(out.departments.marketing.draftCount,2);
assert.equal(out.departments.pr.draftCount,1);
assert.equal(out.departments.affiliates.draftCount,1);
assert.equal(out.departments.followups.draftCount,1);
assert.deepEqual(out.followups.map(x=>x.decision.action),['draft_followup','stop','hold']);
assert.equal(out.metrics.verifiedPaidEntries,1);
assert.ok(out.queue.every(x=>x.sent===false&&x.approved===false));
assert.throws(()=>coordinateCampaign({campaignId:'x',prospects:[{contact:'real@example.com'}],existingRecords:[],nowMs:0}),/invalid|draft|/); // real contacts cannot enter queue
const real=coordinateCampaign({campaignId:'x',prospects:[{id:'real',contact:'real@example.com'}],existingRecords:[],nowMs:0});
assert.equal(real.queue.length,0);
console.log('GROWTH_STAGE7_COORDINATOR_DRY_RUN '+JSON.stringify({departments:out.departments,queue:out.queue.length,externalSends:0,productionWrites:0}));
