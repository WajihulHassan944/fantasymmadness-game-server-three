'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {MongoClient}=require('mongodb');
const {createAffiliateProgram,verifySignature,onboardingLink,playerLink,codeFor}=require('./growth-affiliate-program');
const uri=process.env.GROWTH_TEST_MONGO_URI,skip=!/^mongodb:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(uri||'');
test('same-name affiliate links retain unique campaign and verified account identity',()=>{
 const first={id:'fixture-first',name:'SOURCE FIXTURE Same Name',status:'active',liveAffiliateId:'a'.repeat(24)},second={...first,id:'fixture-second',liveAffiliateId:'b'.repeat(24)};
 for(const a of [first,second])a.code=codeFor(a.id,a.name);
 assert.notEqual(first.code,second.code);assert.notEqual(onboardingLink(first),onboardingLink(second));
 for(const sport of ['boxing','mma-ufc','bare-knuckle','kickboxing','pro-wrestling'])for(const a of [first,second]){const u=new URL(playerLink(a,{id:'fixture-fight',sport}));assert.equal(u.searchParams.get('ref'),a.liveAffiliateId);assert.equal(u.searchParams.get('utm_campaign'),'combat_fans_'+a.code);assert.equal(u.searchParams.get('play'),sport==='pro-wrestling'?null:'1');}
 assert.equal(playerLink({...first,status:'invite_prepared'},{id:'fixture-fight',sport:'boxing'}),null);assert.equal(playerLink({...first,liveAffiliateId:'unverified'},{id:'fixture-fight',sport:'boxing'}),null);
});
test('signed attribution rejects stale, missing and altered authority without financial side effects',()=>{
 const secret=crypto.randomBytes(32).toString('hex'),timestamp=Date.now(),rawBody=JSON.stringify({eventId:'syn_fixture_attribution',type:'registration',playerRef:'fixture_player'}),signature=crypto.createHmac('sha256',secret).update(timestamp+'.'+rawBody).digest('hex');
 assert.equal(verifySignature({secret,timestamp,rawBody,signature}).ok,true);assert.equal(verifySignature({secret,timestamp,rawBody:rawBody+' ',signature}).ok,false);assert.equal(verifySignature({secret,timestamp,rawBody,signature,now:timestamp+6*60000}).ok,false);assert.equal(verifySignature({secret:'',timestamp,rawBody,signature}).ok,false);
});
test('isolated affiliate lifecycle holds unknown identities, deduplicates invitations and prevents account reuse',{skip},async()=>{
 const client=await new MongoClient(uri).connect(),db=client.db('fmgrowthtest'),prefix='aff202_'+crypto.randomBytes(6).toString('hex')+'_',col=Object.fromEntries(['prospects','recruitment','affiliates','attribution'].map(k=>[k,db.collection(prefix+k)])),audit=[];const program=createAffiliateProgram({col,audit:async(...a)=>audit.push(a)});
 try{await program.init();await col.recruitment.insertMany(['first','second'].map(id=>({id,name:'SOURCE FIXTURE Same Name'})));
  for(const id of ['first','second']){const draft={id:'fixture-invite-'+id,kind:'affiliate',prospectId:id,genre:'boxing',recipient:'fixture@fixture.invalid',ownerApproved:true};await program.fromApprovedInvite(draft,{admin:'fixture-owner'});await program.fromApprovedInvite(draft,{admin:'fixture-owner'});assert.equal(await col.affiliates.countDocuments({id}),1);assert.equal((await program.transition(id,'active',{admin:'fixture-owner',liveAffiliateId:'a'.repeat(24)})).ok,false);assert.equal((await program.transition(id,'invited',{admin:'fixture-owner',note:'LOCAL FIXTURE ONLY; not sent'})).ok,true);}
  assert.equal((await program.transition('first','active',{admin:'fixture-owner',liveAffiliateId:'unverified'})).reason,'live_affiliate_id_required');assert.equal((await program.transition('first','active',{admin:'fixture-owner',liveAffiliateId:'a'.repeat(24)})).ok,true);assert.equal((await program.transition('second','active',{admin:'fixture-owner',liveAffiliateId:'a'.repeat(24)})).reason,'live_affiliate_id_already_linked');assert.equal((await program.transition('second','active',{admin:'fixture-owner',liveAffiliateId:'b'.repeat(24)})).ok,true);
  const e={eventId:'syn_fixture_registration',type:'registration',playerRef:'fixture_player',liveAffiliateId:'a'.repeat(24)};assert.equal((await program.ingest(e)).ok,true);assert.equal((await program.ingest(e)).duplicate,true);assert.equal(await col.attribution.countDocuments({synthetic:true}),1);assert.equal(await col.attribution.countDocuments({synthetic:{$ne:true}}),0);assert.ok(audit.length>0);
 }finally{for(const c of Object.values(col))await c.drop().catch(()=>{});await client.close();}
});
