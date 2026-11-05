'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{MongoClient}=require('mongodb');
const {createGrowthRuntime}=require('./growth-runtime'),{resolveGrowthRuntimeConfig}=require('./growth-runtime-config'),{createDeliveryProvider}=require('./growth-delivery-provider'),{contestFeed}=require('./growth-contest-feed.fixture');
const uri=process.env.GROWTH_TEST_MONGO_URI,skip=!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri||'');
test('staging refinement regenerates only untouched unapproved drafts and retains source research, attribution and owner work',{skip,timeout:30000},async()=>{
 const client=await new MongoClient(uri).connect(),raw=client.db('fmgrowthtest'),prefix='refinetest_'+crypto.randomBytes(5).toString('hex')+'_',db={databaseName:'fmgrowthtest',collection:n=>raw.collection(prefix+n)};
 const resolved=resolveGrowthRuntimeConfig({GROWTH_STAGING_MODE:'isolated',GROWTH_TEST_MONGO_URI:uri,JWT_SECRET_ADMIN:crypto.randomBytes(40).toString('hex'),GROWTH_UNSUBSCRIBE_SECRET:crypto.randomBytes(40).toString('hex'),GROWTH_DELIVERY_PROVIDER:'sandbox-capture',GROWTH_SOCIAL_PROVIDER:'sandbox',GROWTH_POSTERS:'off',GROWTH_RESEARCH_PER_RUN:'0',GROWTH_FIGHT_URL_DISCOVERY:'off'});assert.equal(resolved.ok,true,JSON.stringify(resolved.errors));
 const feed=contestFeed(),fetchImpl=async u=>feed(u)||{ok:false,status:404,text:async()=>'',json:async()=>({})},provider=createDeliveryProvider({config:resolved.config,secrets:resolved.secrets,captureCollection:db.collection('growth_sandbox_mail')}),rt=createGrowthRuntime({db,config:resolved.config,secrets:resolved.secrets,provider,fetchImpl});
 try{
  await rt.init();await rt.refreshMarketing();const drafts=rt.collections.drafts;const [a,b,c]=await rt.listDrafts({kind:'marketing'});assert.ok(c);
  await drafts.updateOne({id:a.id},{$unset:{copyVersion:'',platformCopy:''},$set:{text:'Legacy fixture caption'}});
  await drafts.updateOne({id:b.id},{$set:{status:'approved',ownerApproved:true}});
  await drafts.updateOne({id:c.id},{$set:{editedBy:'owner@fixture.invalid',editCount:1,text:'Owner original words'}});
  const approved=await drafts.findOne({id:b.id}),owner=await drafts.findOne({id:c.id});
  const research={ok:true,show:{title:"SOURCE FIXTURE Cami's Kickboxing &amp; Fitness Podcast",author:'Camilla'},contact:{email:'info@fixture.example',name:'Camilla',source:'https://fixture.example/rss'},recentEpisodes:[{title:'SOURCE FIXTURE Kickboxing episode',date:new Date().toISOString()}],evidence:[{kind:'sport',text:'Verified kickboxing episode metadata',examples:['SOURCE FIXTURE Kickboxing episode']}]};
  await rt.collections.prospects.insertOne({id:'email-prospect',name:'SOURCE FIXTURE Cami',genre:'kickboxing',research});
  await drafts.insertOne({id:'email-fixture',kind:'affiliate',genre:'kickboxing',prospectId:'email-prospect',recipient:'info@fixture.example',subject:'Old &amp; subject',text:'Hi Camilla,\n\nI listened to your episode',html:'<p>old</p>',status:'needs_owner_review',autoResearched:true,campaign:'fixture-original-attribution',contactSource:'https://fixture.example/rss'});
  const beforeResearch=await rt.collections.prospects.findOne({id:'email-prospect'});
  const marketing=await rt.refreshMarketing();assert.ok(marketing.refinement.regenerated>=1);const emails=await rt.refineEmailDrafts();assert.equal(emails.regenerated,1);
  assert.deepEqual(await drafts.findOne({id:b.id}),approved);assert.deepEqual(await drafts.findOne({id:c.id}),owner);
  const fixed=await drafts.findOne({id:'email-fixture'});assert.match(fixed.text,/^Hi,/);assert.ok(!fixed.text.includes('I listened'));assert.ok(!fixed.subject.includes('&amp;'));assert.equal(fixed.campaign,'fixture-original-attribution');assert.equal(fixed.contactSource,'https://fixture.example/rss');assert.equal(fixed.status,'needs_owner_review');assert.equal(fixed.contentHistory.length,1);assert.deepEqual(await rt.collections.prospects.findOne({id:'email-prospect'}),beforeResearch);
  const twice=await rt.refineEmailDrafts();assert.equal(twice.regenerated,0);assert.equal((await drafts.findOne({id:'email-fixture'})).contentHistory.length,1);
  assert.equal((await rt.approveDraft('email-fixture',{admin:'owner@fixture.invalid'})).reason,'affiliate_program_verification_required');
 }finally{for(const c of await raw.listCollections({name:{$regex:'^'+prefix}}).toArray())await raw.collection(c.name).drop();await client.close();}
});
