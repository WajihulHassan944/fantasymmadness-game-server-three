'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {prepareOutreachReview}=require('./growth-outreach-review-queue');
test('only verified consented contacts enter the owner review queue',()=>{
 const result=prepareOutreachReview([
  {id:'media1',genre:'boxing',category:'media',verified:true,contactVerified:true,contact:'editor@example.org',consent:true,name:'Editor'},
  {id:'affiliate1',genre:'mma-ufc',category:'affiliate',verified:true,contactVerified:true,contact:'fighter@example.org',consent:true,name:'Fighter'},
  {id:'missing',genre:'boxing',category:'media',verified:true,contactVerified:false,consent:true},
  {id:'declined',genre:'boxing',category:'media',verified:true,contactVerified:true,contact:'no@example.org',consent:false},
  {id:'media1',genre:'boxing',category:'media',verified:true,contactVerified:true,contact:'duplicate@example.org',consent:true}
 ]);
 assert.equal(result.drafts.length,2);assert.equal(result.blocked.length,3);
 assert(result.drafts.every(x=>x.status==='needs_owner_review'&&!x.ownerApproved&&!x.sendPermitted&&!x.sent));
 assert.equal(result.outboundMessages,0);
});
test('suppressed or unsupported contacts cannot enter queue',()=>{
 const result=prepareOutreachReview([{id:'1',genre:'boxing',category:'media',verified:true,contactVerified:true,contact:'x@example.org',consent:true,optedOut:true}]);
 assert.equal(result.drafts.length,0);
});
