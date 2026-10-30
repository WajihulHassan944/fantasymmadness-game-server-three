'use strict';
const assert=require('node:assert/strict');
const {renderBusinessEmail}=require('./growth-business-email-templates');
for(const type of ['media','promoter','affiliate','influencer','investor']){
 const x=renderBusinessEmail({type,recipientName:'Example <Partner>',personalization:'Relevant to your fight-night audience.'});
 assert.ok(x.html.includes('FANTASY'));
 assert.ok(x.html.includes('contact@fantasymmadnesscom.com'));
 assert.ok(x.html.includes('max-width:600px'));
 assert.ok(x.html.includes('Kelly Davis'));
 assert.ok(x.html.includes('Example &lt;Partner&gt;'));
 assert.ok(!x.html.includes('Example <Partner>'));
 assert.ok(x.text.includes('Relevant to your fight-night audience.'));
 assert.equal(x.sendPermitted,false);
 assert.ok(x.subject.length>12);
}
assert.throws(()=>renderBusinessEmail({type:'unknown'}),/unsupported/);
const unsafe=renderBusinessEmail({type:'media',logoUrl:'javascript:alert(1)',unsubscribeUrl:'javascript:alert(1)'});
assert.ok(!unsafe.html.includes('javascript:'));
console.log('STAGE9_BRANDED_EMAIL_DRY_RUN '+JSON.stringify({templates:5,externalSends:0,productionWrites:0}));
