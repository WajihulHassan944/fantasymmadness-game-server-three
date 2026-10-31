'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createDraftAdapters}=require('./growth-workstream-draft-adapters');
const {executeWorkstreams}=require('./growth-workstream-executor');
test('all 25 workstreams produce draft-only outputs without sending',async()=>{
 const adapters=createDraftAdapters({research:[{genre:'boxing',verified:true,title:'Verified event',sourceUrl:'https://example.org/event'}],prospects:[{genre:'boxing',verified:true,id:'p1',name:'Media',category:'media'},{genre:'boxing',verified:true,id:'p2',name:'Affiliate',category:'affiliate'}]});
 const saved=[];
 const r=await executeWorkstreams({adapters,persist:async x=>saved.push(x)});
 assert.equal(r.completed,25);assert.equal(saved.length,25);assert.equal(r.outboundActions,0);
 const pr=saved.find(x=>x.workstreamId==='boxing:public-relations').data;
 assert.equal(pr.drafts.length,1);assert.equal(pr.drafts[0].sent,false);assert.equal(pr.drafts[0].template.sendPermitted,false);
 const affiliate=saved.find(x=>x.workstreamId==='boxing:affiliate-recruitment').data;
 assert.equal(affiliate.drafts.length,1);assert.equal(affiliate.drafts[0].sent,false);
 const marketing=saved.find(x=>x.workstreamId==='boxing:marketing').data;
 assert.equal(marketing.drafts[0].published,false);
});
test('unverified prospects and research cannot generate drafts',async()=>{
 const a=createDraftAdapters({research:[{genre:'mma-ufc',title:'Rumor',sourceUrl:'https://example.org'}],prospects:[{genre:'mma-ufc',category:'media',name:'Unknown'}]});
 assert.equal((await a.marketing({genre:'mma-ufc'})).drafts.length,0);
 assert.equal((await a['public-relations']({genre:'mma-ufc'})).drafts.length,0);
});
