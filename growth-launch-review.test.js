'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{MongoClient}=require('mongodb'),crypto=require('node:crypto');
const {launchReview}=require('./growth-launch-review');
const uri=process.env.GROWTH_TEST_MONGO_URI,skip=!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri||'');
test('launch evidence is isolated, read-only, fails incomplete campaigns closed and never exposes credentials or recipient email',{skip},async()=>{
 await assert.rejects(()=>launchReview({db:{databaseName:'live'}}),/isolated_review/);
 const client=await new MongoClient(uri).connect(),raw=client.db('fmgrowthtest'),prefix='launch_review_'+crypto.randomBytes(6).toString('hex')+'_',db={databaseName:'fmgrowthtest',collection:n=>raw.collection(prefix+n)};
 try{const drafts=db.collection('preview198_growth_drafts');await drafts.insertOne({id:'incomplete-pr',kind:'pr',status:'needs_owner_review',subject:'Fixture incomplete pitch',recipient:'private-recipient@fixture.invalid',ownerApproved:false,sendPermitted:false,text:'Hi,'});await db.collection('growth_social_accounts').insertOne({provider:'x',confirmed:true,username:'fixture_account',credentials:{access_token:'PRIVATE_CREDENTIAL_MUST_NOT_APPEAR'},identity:'fixture-public-id',status:'connected'});const before=JSON.stringify(await drafts.find({}).toArray()),r=await launchReview({db});assert.equal(r.readOnly,true);assert.equal(r.campaigns[0].decision,'HOLD');assert.equal(r.campaigns[0].recipientDomain,'fixture.invalid');assert.equal(r.connections.verificationFresh,false);const out=JSON.stringify(r);assert.equal(out.includes('PRIVATE_CREDENTIAL'),false);assert.equal(out.includes('private-recipient@'),false);assert.equal(JSON.stringify(await drafts.find({}).toArray()),before);assert.equal(r.publishingEnabled,false);assert.equal(r.outboundEnabled,false);
 }finally{for(const c of await raw.listCollections({name:{$regex:'^'+prefix}}).toArray())await raw.collection(c.name).drop();await client.close();}
});
