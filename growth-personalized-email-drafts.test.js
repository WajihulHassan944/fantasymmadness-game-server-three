'use strict';
const assert=require('node:assert/strict');
const {preparePersonalizedDrafts}=require('./growth-personalized-email-drafts');
const out=preparePersonalizedDrafts([
 {id:'media1',type:'media',recipientName:'Example Newsroom',relevanceNote:'Your coverage of professional boxing could make this relevant.',relevanceSource:'https://example.invalid/coverage'},
 {id:'fighter1',type:'affiliate',recipientName:'Example Fighter',relevanceNote:'Your audience follows MMA events and fighter leagues.',relevanceSource:'https://example.invalid/fighter'},
 {id:'media1',type:'media',recipientName:'Duplicate',relevanceNote:'duplicate',relevanceSource:'https://example.invalid/duplicate'},
 {id:'optout',type:'promoter',recipientName:'Opted out',relevanceNote:'x',relevanceSource:'https://example.invalid',optedOut:true},
 {id:'missing',type:'media',recipientName:'No evidence',relevanceNote:'x'}
]);
assert.equal(out.drafts.length,2);
assert.ok(out.drafts.every(x=>x.status==='draft'&&!x.sent&&!x.approved&&!x.sendPermitted));
assert.notEqual(out.drafts[0].html,out.drafts[1].html);
assert.ok(out.drafts[0].html.includes('Example Newsroom'));
assert.ok(out.drafts[1].html.includes('Example Fighter'));
assert.ok(out.drafts.every(x=>x.html.includes('BOXING • MMA • BARE-KNUCKLE • KICKBOXING • PRO WRESTLING')));
console.log('STAGE10_PERSONALIZED_EMAIL_DRY_RUN '+JSON.stringify({drafts:out.drafts.length,externalSends:0}));
