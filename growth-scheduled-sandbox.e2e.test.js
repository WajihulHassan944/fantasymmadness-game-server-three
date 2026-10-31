'use strict';
// End-to-end scheduled campaign dry run: dedicated CI loopback MongoDB + memory SMTP.
// No external mail, production database, payment credentials or public endpoints.
const assert=require('node:assert/strict');
const {MongoClient}=require('mongodb');
const {randomUUID}=require('node:crypto');
const nodemailer=require('nodemailer');
const {createStore}=require('./growth-unattended-store');
const {renderBusinessEmail}=require('./growth-business-email-templates');
(async()=>{
 const uri=process.env.GROWTH_TEST_MONGO_URI;
 if(!uri||!/^mongodb:\/\/(?:127\.0\.0\.1|localhost):27017(?:\/|\?|$)/.test(uri))throw Error('Refusing non-loopback MongoDB URI');
 const client=new MongoClient(uri,{serverSelectionTimeoutMS:5000});
 const dbName='growth_campaign_delivery_'+randomUUID().replace(/-/g,'');
 const now=Date.parse('2026-11-01T12:00:00Z');
 try{
  await client.connect();
  const store=createStore(client.db(dbName).collection('synthetic_jobs'),{testMode:true});
  await store.init();
  const input={id:'synthetic-campaign-1',type:'prepare_campaign',dueAt:new Date(now).toISOString()};
  await store.enqueue(input);
  await store.enqueue(input);
  const [claimed,duplicate]=await Promise.all([store.claim(now),store.claim(now)]);
  assert.ok(claimed);assert.equal(duplicate,null);
  const {html,text,subject}=renderBusinessEmail({type:'affiliate',recipientName:'Synthetic Tester',personalization:'CI-only simulated campaign.'});
  const transport=nodemailer.createTransport({streamTransport:true,buffer:true});
  const delivered=await transport.sendMail({from:'contact@fantasymmadnesscom.com',to:'sandbox@example.invalid',subject,text,html});
  const raw=delivered.message.toString('utf8');
  assert.match(raw,/sandbox@example.invalid/i);
  assert.match(raw,/FANTASY MMADNESS/i);
  await store.finish(claimed,{success:true,now});
  const restarted=createStore(client.db(dbName).collection('synthetic_jobs'),{testMode:true});
  assert.equal(await restarted.claim(now+60000),null);
  assert.deepEqual(await restarted.summary(),{completed:1});
  transport.close();
  console.log('PASS campaign-to-sandbox end-to-end: Mongo scheduled claim, one local message, restart dedupe, external sends 0');
 }finally{try{await client.db(dbName).dropDatabase()}finally{await client.close()}}
})().catch(e=>{console.error(e);process.exitCode=1});
