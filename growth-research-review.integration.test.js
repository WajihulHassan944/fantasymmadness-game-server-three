'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runResearchDraftCycle}=require('./growth-research-draft-cycle');
test('public podcast research enters review pipeline without inferred contact or sends',async()=>{
 const stored=[];
 const r=await runResearchDraftCycle({
  fetchImpl:async()=>({ok:true,json:async()=>({results:[{collectionName:'Public Fight Podcast',collectionViewUrl:'https://podcasts.apple.com/us/podcast/fight/id123'}]})}),
  persist:async x=>stored.push(x),limitPerWorker:2
 });
 assert.equal(r.execution.completed,25);
 assert.equal(r.reviewQueue.drafts.length,0,'public listing is not consent or contact verification');
 assert.equal(r.reviewQueue.outboundMessages,0);
 assert.equal(r.messagesSent,0);
 assert.equal(r.qualification.contactsVerified,0);
 assert.equal(stored.length,25);
});
