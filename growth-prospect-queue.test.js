'use strict';
// Offline queue: fictional contacts only. Never imports mail, database or network clients.
const assert=require('node:assert/strict');
const {buildQueue}=require('./growth-prospect-queue');
const prospects=[
 {id:'fictional-media',name:'Example Sports Desk',category:'media',contact:'press@example.invalid',source:'https://example.invalid/media',approved:false,optedOut:false},
 {id:'fictional-affiliate',name:'Example Fighter',category:'affiliate',contact:'fighter@example.invalid',source:'https://example.invalid/fighter',approved:false,optedOut:false},
 {id:'fictional-duplicate',name:'Duplicate',category:'media',contact:'PRESS@example.invalid',source:'https://example.invalid/duplicate',approved:false,optedOut:false},
 {id:'fictional-optout',name:'Opted Out',category:'media',contact:'optout@example.invalid',source:'https://example.invalid/optout',approved:true,optedOut:true}
];
const queue=buildQueue(prospects,{campaignId:'campaign-001',mode:'DRAFT_ONLY'});
assert.equal(queue.length,2);
assert.ok(queue.every(x=>x.status==='draft'&&x.sent===false&&x.approved===false));
assert.ok(queue.every(x=>x.contact.endsWith('.invalid')));
assert.ok(!queue.some(x=>x.contact==='optout@example.invalid'));
console.log('GROWTH_PROSPECT_QUEUE_DRY_RUN '+JSON.stringify({mode:'DRAFT_ONLY',prospectsConsidered:prospects.length,draftsQueued:queue.length,externalSends:0,productionWrites:0}));
