'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createGmailSmtpProvider}=require('./growth-gmail-smtp-provider');
const d={id:'approved-fixture',status:'approved',ownerApproved:true,sendPermitted:true,recipient:'recipient@example.invalid',subject:'Exact approved subject',text:'Approved text\nhttps://example.invalid/unsubscribe',listUnsubscribe:'https://example.invalid/unsubscribe'};
function fixture(overrides={}){let sent=0,verified=0,options;return{get sent(){return sent},get options(){return options},provider:createGmailSmtpProvider({user:'CONTACT@fantasymmadnesscom.com',password:'private-fixture',transportFactory:opts=>{options=opts;return{verify:async()=>{verified++;if(overrides.authError)throw Object.assign(Error('private-secret'),{code:'EAUTH',responseCode:535});},close(){},sendMail:async msg=>{sent++;if(overrides.sendError)throw overrides.sendError;assert.equal(msg.envelope.from,'contact@fantasymmadnesscom.com');return{accepted:[d.recipient],response:'250 2.0.0 OK provider-queue-id - gsmtp',messageId:msg.messageId};}};}})};}
test('existing SMTP identity must match contact mailbox, auth is verified, errors never disclose credentials',async()=>{
 assert.equal((await createGmailSmtpProvider().readiness()).ready,false);
 const wrong=createGmailSmtpProvider({user:'other@example.invalid',password:'secret',transportFactory:()=>{throw Error('must not authenticate a different mailbox')}});assert.equal((await wrong.readiness()).ready,false);
 const bad=fixture({authError:true});const r=await bad.provider.send(d);assert.equal(r.ok,false);assert.equal(bad.sent,0);assert.doesNotMatch(JSON.stringify(r),/private-secret|private-fixture/);
});
test('SMTP sends only exact approved messages and reports server acceptance separately from delivery',async()=>{
 const f=fixture();assert.equal((await f.provider.send({...d,sendPermitted:false})).ok,false);assert.equal((await f.provider.send({...d,subject:'Subject\r\nBcc: other@example.invalid'})).ok,false);assert.equal((await f.provider.send(d,{canSend:async()=>false})).ok,false);assert.equal(f.sent,0);
 const r=await f.provider.send(d);assert.equal(f.sent,1);assert.equal(f.options.secure,true);assert.equal(f.options.tls.rejectUnauthorized,true);assert.equal(r.receipt.status,'accepted');assert.equal(r.receipt.delivered,false);assert.match(r.receipt.providerAcceptanceResponse,/provider-queue-id/);assert.equal(r.receipt.providerMessageId,undefined);
 const unknown=await fixture({sendError:Error('private-secret')}).provider.send(d);assert.equal(unknown.uncertain,true);assert.doesNotMatch(JSON.stringify(unknown),/private-secret/);
 const rejected=await fixture({sendError:Object.assign(Error('private-secret'),{responseCode:451})}).provider.send(d);assert.equal(rejected.retryable,true);assert.equal(rejected.uncertain,false);
});
