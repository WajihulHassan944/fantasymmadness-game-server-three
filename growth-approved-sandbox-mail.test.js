'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createSandboxMailSender}=require('./growth-approved-sandbox-mail');
test('approved sandbox message returns a verifiable receipt',async()=>{
 const messages=[];
 const send=createSandboxMailSender({transport:{sendMail:async x=>{messages.push(x);return {messageId:'sandbox-123'}}}});
 const draft={id:'d1',recipient:'tester@localhost',subject:'Test',text:'Sandbox only',status:'approved',ownerApproved:true,sendPermitted:true};
 const r=await send({draft,approval:{draftId:'d1',ownerApproved:true}});
 assert.equal(r.ok,true);assert.equal(r.receipt.sandbox,true);assert.equal(r.receipt.realDelivery,false);assert.equal(messages.length,1);
});
test('rejects external recipients and unapproved drafts without sending',async()=>{
 let sent=0;
 const send=createSandboxMailSender({transport:{sendMail:async()=>{sent++;return {messageId:'x'}}}});
 const base={id:'d1',recipient:'tester@localhost',subject:'Test',text:'Sandbox only',status:'approved',ownerApproved:true,sendPermitted:true};
 assert.equal((await send({draft:{...base,recipient:'real@example.org'},approval:{draftId:'d1',ownerApproved:true}})).ok,false);
 assert.equal((await send({draft:{...base,ownerApproved:false},approval:{draftId:'d1',ownerApproved:true}})).ok,false);
 assert.equal(sent,0);
 assert.throws(()=>createSandboxMailSender({transport:{sendMail:async()=>{}},from:'real@example.org'}),/Loopback/);
});
