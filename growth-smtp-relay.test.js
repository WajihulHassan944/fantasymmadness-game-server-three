'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createSmtpRelayService}=require('./growth-smtp-relay-service');
const {createSmtpRelayProvider,TEST_ID}=require('./growth-smtp-relay-provider');
test('mail service denies unsigned callers, never exports credentials, and requires a durable claim before SMTP send',async()=>{
 let sent=0,claimed=false;const handler=createSmtpRelayService({env:{SMTP_PASS:'private-fixture-password'},verifyToken:async token=>{if(token!=='signed-fixture')throw Error('invalid')},claimDelivery:async()=>{if(claimed)return false;claimed=true;return true},transportFactory:opts=>{assert.equal(opts.auth.user,'contact@fantasymmadnesscom.com');return{verify:async()=>{},close(){},sendMail:async msg=>{sent++;assert.equal(msg.envelope.from,'contact@fantasymmadnesscom.com');return{accepted:[msg.to],response:'250 2.0.0 OK fixture-provider-id - gsmtp',messageId:msg.messageId};}};}});
 const server=http.createServer(handler).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 try{
 const denied=await fetch(base+'/api/mail/verify');assert.equal(denied.status,401);assert.equal(sent,0);
 const calls=[];const provider=createSmtpRelayProvider({getToken:async()=> 'signed-fixture',fetchImpl:async(url,opts)=>{calls.push(url);return fetch(base+new URL(url).pathname.replace('/api/growth-mail-relay','/api/mail'),opts);}});
 const ready=await provider.readiness();assert.equal(ready.ready,true);assert.equal(ready.credentialTransferred,false);assert.doesNotMatch(JSON.stringify(ready),/private-fixture-password/);
 const draft={id:'approved-queue-id',status:'approved',ownerApproved:true,sendPermitted:true,recipient:'owner@example.invalid',subject:'Approved subject',text:'Approved\nhttps://example.invalid/unsubscribe',listUnsubscribe:'https://example.invalid/unsubscribe'};
 assert.equal((await provider.send(draft,{canSend:async()=>false})).ok,false);assert.equal(sent,0);
 const first=await provider.send(draft,{canSend:async()=>true,deliveryClaim:'claim-fixture'});assert.equal(first.ok,true);assert.equal(first.receipt.delivered,false);assert.match(first.receipt.providerAcceptanceResponse,/fixture-provider-id/);assert.equal(sent,1);
 const duplicate=await provider.send(draft,{canSend:async()=>true,deliveryClaim:'claim-fixture'});assert.equal(duplicate.ok,false);assert.equal(duplicate.uncertain,true);assert.equal(sent,1);
 assert.ok(calls.every(u=>u.startsWith('https://fantasymmadness-game-server-three-khx99a42p.vercel.app/api/mail/')));
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('mail client targets only the approved backend Preview and retains signed workload headers',async()=>{
 const {createSmtpRelayProvider}=require('./growth-smtp-relay-provider');const calls=[];
 const provider=createSmtpRelayProvider({getToken:async()=>'fixture-workload',fetchImpl:async(url,options)=>{calls.push({url,options});return{ok:true,json:async()=>({ok:true,ready:true,sender:'contact@fantasymmadnesscom.com'}),headers:new Headers()};}});
 assert.equal((await provider.readiness()).ready,true);
 assert.equal(calls[0].url,'https://fantasymmadness-game-server-three-khx99a42p.vercel.app/api/mail/verify');
 assert.equal(calls[0].options.headers['x-vercel-trusted-oidc-idp-token'],'fixture-workload');
 assert.equal(calls[0].options.headers['x-fmm-mail-workload'],'fixture-workload');
 assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.method,'GET');
});
