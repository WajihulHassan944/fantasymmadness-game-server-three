'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createGmailProvider,SEND,META}=require('./growth-gmail-provider');
const draft={id:'exact-owner-delivery',status:'approved',ownerApproved:true,sendPermitted:true,recipient:'owner@example.invalid',subject:'Verification',text:'Verification\nhttps://example.invalid/unsubscribe',listUnsubscribe:'https://example.invalid/unsubscribe'};
function fixture({sender='CONTACT@fantasymmadnesscom.com',scope=SEND+' '+META,sendStatus=200,throwSend=false}={}){const calls=[];return{calls,provider:createGmailProvider({clientId:'fixture',clientSecret:'fixture',refreshToken:'fixture',fetchImpl:async(url,opts={})=>{calls.push({url,opts});if(url.endsWith('/token'))return{ok:true,json:async()=>({access_token:'fixture',expires_in:3600,scope})};if(url.endsWith('/profile'))return{ok:true,json:async()=>({emailAddress:sender})};if(throwSend)throw Error('secret-bearing provider failure');return{ok:sendStatus===200,status:sendStatus,json:async()=>sendStatus===200?{id:'gmail-real-provider-id',threadId:'thread'}:{}};}})};}
test('Gmail rejects missing credentials, changed mailbox, missing consent, missing approval and header injection before sending',async()=>{
 assert.equal((await createGmailProvider().readiness()).ready,false);
 for(const opts of [{sender:'other@example.invalid'},{scope:META}]){const f=fixture(opts);assert.equal((await f.provider.send(draft)).ok,false);assert.equal(f.calls.some(c=>c.url.endsWith('/send')),false);}
 for(const change of [{ownerApproved:false},{sendPermitted:false},{recipient:'victim@example.invalid\r\nBcc: other@example.invalid'},{subject:'Hello\r\nBcc: other@example.invalid'},{listUnsubscribe:''}]){const f=fixture();assert.equal((await f.provider.send({...draft,...change})).ok,false);assert.equal(f.calls.length,0);}
});
test('Gmail acceptance is not misreported as delivery; unknown POST outcomes cannot be retried automatically',async()=>{
 const f=fixture(),r=await f.provider.send(draft);assert.equal(r.ok,true);assert.equal(r.receipt.status,'accepted');assert.equal(r.receipt.delivered,false);
 const request=f.calls.find(c=>c.url.endsWith('/send'));const raw=Buffer.from(JSON.parse(request.opts.body).raw,'base64url').toString();assert.match(raw,/From: FANTASY MMADNESS <contact@fantasymmadnesscom.com>/);assert.match(raw,/List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
 for(const opts of [{throwSend:true},{sendStatus:503}]){const r=await fixture(opts).provider.send(draft);assert.equal(r.uncertain,true);assert.doesNotMatch(JSON.stringify(r),/secret-bearing/);}
 const rate=await fixture({sendStatus:429}).provider.send(draft);assert.equal(rate.retryable,true);assert.equal(rate.uncertain,false);
});
