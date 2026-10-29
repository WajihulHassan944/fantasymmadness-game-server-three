'use strict';
const assert=require('node:assert/strict');
const {prepareFromResearch}=require('./growth-research-to-campaign');
const now=Date.UTC(2026,10,1,12);
const data={now,opportunities:[
 {id:'fight-1',sport:'boxing',title:'Verified synthetic fight announcement',sourceUrl:'https://example.invalid/news',verified:true},
 {id:'fight-1',sport:'boxing',title:'Duplicate',sourceUrl:'https://example.invalid/news',verified:true},
 {id:'unverified',sport:'mma',title:'Rumor',sourceUrl:'https://example.invalid/rumor',verified:false},
 {id:'bad-link',sport:'wrestling',title:'Invalid source',sourceUrl:'http://example.invalid',verified:true}
],audiences:[
 {id:'aff-1',kind:'affiliate',name:'Synthetic Fighter',sourceUrl:'https://example.invalid/fighter',verified:true},
 {id:'press-1',kind:'media',name:'Synthetic Newsroom',sourceUrl:'https://example.invalid/press',verified:true},
 {id:'press-2',kind:'media',name:'Unverified Newsroom',sourceUrl:'https://example.invalid/press2',verified:false}
]};
const result=prepareFromResearch(data);
assert.equal(result.mode,'ISOLATED_DRAFT_ONLY');
assert.equal(result.jobs.length,3);
assert.equal(result.completed.length,3);
assert.ok(result.completed.every(j=>j.state==='completed'));
assert.equal(result.drafts.length,3);
assert.equal(result.skipped.length,4);
assert.ok(result.drafts.every(d=>d.status==='needs_review'&&d.approvalRequired===true));
assert.ok(result.drafts.every(d=>d.published!==true&&d.sent!==true));
assert.equal(result.externalActions,0);
assert.equal(result.drafts.filter(d=>d.kind==='media').length,1);
assert.equal(result.drafts.filter(d=>d.kind==='affiliate').length,1);
assert.equal(result.drafts.filter(d=>d.channels).length,1);
console.log('PASS research-to-campaign pipeline: 3 prepared drafts, 4 rejected/duplicate inputs, owner review required, zero external actions');
