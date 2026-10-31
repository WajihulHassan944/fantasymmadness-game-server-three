'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {qualifyMediaProspects}=require('./growth-media-qualification');
test('qualifies sourced media without inventing contact information',()=>{
 const r=qualifyMediaProspects([
  {id:'1',genre:'boxing',name:'Boxing Show',sourceUrl:'https://example.org/show',verified:true},
  {id:'2',genre:'boxing',name:'Duplicate',sourceUrl:'https://example.org/show/',verified:true},
  {id:'3',genre:'mma-ufc',name:'Suppressed',sourceUrl:'https://example.org/suppressed',verified:true,optedOut:true},
  {id:'4',genre:'kickboxing',name:'Media',sourceUrl:'https://example.org/media',verified:true,contact:'editor@example.org',contactVerified:true,consent:true,ownerApproved:true}
 ]);
 assert.equal(r.accepted.length,2);assert.equal(r.rejected.length,2);
 assert.equal(r.contactsVerified,1);assert.equal(r.outreachActions,0);
 assert.equal(r.accepted[0].contact,null);assert.equal(r.accepted[0].sendPermitted,false);
 assert.equal(r.accepted[1].outreachEligible,true);assert.equal(r.accepted[1].sendPermitted,false);
});
test('rejects invalid source URLs and unverified claims',()=>{
 const r=qualifyMediaProspects([{genre:'boxing',name:'Unverified',sourceUrl:'https://example.org',verified:false},{genre:'boxing',name:'Bad',sourceUrl:'http://example.org',verified:true}]);
 assert.equal(r.accepted.length,0);
});
