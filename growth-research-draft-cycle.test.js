'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {runResearchDraftCycle}=require('./growth-research-draft-cycle');
test('public podcast research feeds PR drafts through 25 isolated workstreams',async()=>{
 const stored=[];
 const result=await runResearchDraftCycle({
  fetchImpl:async()=>({ok:true,json:async()=>({results:[{collectionName:'Combat Podcast',collectionViewUrl:'https://podcasts.apple.com/us/podcast/combat/id123'}]})}),
  persist:async x=>stored.push(x),limitPerWorker:2
 });
 assert.equal(result.discovery.workersConfigured,10);
 assert.equal(result.execution.completed,25);
 assert.equal(stored.length,25);
 assert.equal(result.messagesSent,0);
 assert.equal(result.publishedPosts,0);
 const pr=stored.find(x=>x.workstreamId==='boxing:public-relations');
 assert(pr.data.drafts.length>=0);
 assert(stored.every(x=>x.mode==='isolated'));
});
test('missing persistence cannot start research',async()=>{
 await assert.rejects(()=>runResearchDraftCycle({fetchImpl:async()=>{throw Error('should not run')}}),/persistence/);
});
