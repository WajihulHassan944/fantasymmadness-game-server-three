'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {MongoClient}=require('mongodb'),sharp=require('sharp');
const {createGrowthRuntime}=require('./growth-runtime'),{resolveGrowthRuntimeConfig}=require('./growth-runtime-config'),{createDeliveryProvider}=require('./growth-delivery-provider'),{contestFeed}=require('./growth-contest-feed.fixture'),{decodeQr}=require('./growth-poster-studio'),{defaults}=require('./growth-autonomy');
const uri=process.env.GROWTH_TEST_MONGO_URI,skip=!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri||'');
async function fixture({posters=true}={}){
 const client=await new MongoClient(uri).connect(),physical=client.db('fmgrowthtest'),prefix='safety198_'+crypto.randomUUID().replaceAll('-','')+'_';
 const db={databaseName:'fmgrowthtest',collection:n=>physical.collection(prefix+n)},PUBLIC='https://growth-safety198.test';
 const image=await sharp({create:{width:900,height:1100,channels:3,background:'#201331'}}).jpeg().toBuffer(),feed=contestFeed();let rt;
 const fetchImpl=async(url,options)=>{const u=String(url);
  const f=feed(u);if(f)return{...f,json:async()=>{const b=await f.json();b.items=b.items.filter(x=>x._id==='bx0000000001');for(const r of b.items)Object.assign(r,{matchFighterA:'Elif Nur Turhan',matchFighterB:'Alycia Baumgardner',fightPosterImage:'https://res.cloudinary.com/demo/image/upload/v1/safety198.jpg'});return b;}};
  if(u.startsWith(PUBLIC)){const id=new URL(u).pathname.split('/').pop().replace(/\.jpg$/,'');const p=await rt.posters.getImage(id);return{ok:!!p,status:p?200:404,headers:new Headers({'content-type':'image/jpeg'}),arrayBuffer:async()=>p?.buffer};}
  if(u.startsWith('https://res.cloudinary.com/demo/image/upload/'))return{ok:true,status:200,headers:new Headers({'content-type':'image/jpeg'}),arrayBuffer:async()=>image};
  if(u.startsWith('https://www.fantasymmadness.com/fight/'))return{ok:true,status:200,url:u};
  if(u.includes('/images/brand/'))return{ok:false,status:404,headers:new Headers()};
  throw Error('No external network permitted by fixture');
 };
 const secret=crypto.randomBytes(32).toString('hex'),resolved=resolveGrowthRuntimeConfig({GROWTH_STAGING_MODE:'isolated',GROWTH_TEST_MONGO_URI:uri,GROWTH_OUTBOUND_ENABLED:'false',JWT_SECRET_ADMIN:secret,GROWTH_UNSUBSCRIBE_SECRET:secret,GROWTH_DELIVERY_PROVIDER:'sandbox-capture',GROWTH_SOCIAL_PROVIDER:'sandbox',GROWTH_POSTERS:posters?'on':'off',GROWTH_POSTERS_PER_RUN:'20',GROWTH_PUBLIC_ORIGIN:PUBLIC,GROWTH_ART_CLOUDINARY_CLOUDS:'demo',GROWTH_DISCOVERY_ENABLED:'false',GROWTH_RESEARCH_PER_RUN:'0',GROWTH_FIGHT_URL_DISCOVERY:'off'});
 assert.equal(resolved.ok,true,JSON.stringify(resolved.errors));
 const provider=createDeliveryProvider({config:resolved.config,secrets:resolved.secrets,captureCollection:db.collection('growth_sandbox_mail')});
 rt=createGrowthRuntime({db,config:resolved.config,secrets:resolved.secrets,provider,fetchImpl});await rt.init();
 return{rt,close:async()=>{for(const c of await physical.listCollections({name:{$regex:'^'+prefix}}).toArray())await physical.collection(c.name).drop();await client.close();}};
}
test('same-name affiliates get distinct decoded poster QR identities, never a generic or owner fallback',{skip,timeout:120000},async()=>{
 const f=await fixture();const{rt}=f;
 try{
  await rt.refreshMarketing(new Date());const [d]=await rt.listDrafts({kind:'marketing'});assert.equal(d.contest.fighterA,'Elif Nur Turhan');
  const approved=await rt.approveDraft(d.id,{admin:'owner@fixture.invalid'});assert.equal(approved.ok,true,JSON.stringify(approved));const basePoster=approved.draft.poster;
  const affs=[{id:'affiliate-a',name:'Same Name',code:'aff_a',status:'active',liveAffiliateId:'611111111111111111111111'},{id:'affiliate-b',name:'Same Name',code:'aff_b',status:'active',liveAffiliateId:'622222222222222222222222'}];await rt.collections.affiliates.insertMany(affs);
  for(const a of affs){const r=await rt.social.schedule(d.id,{channels:['facebook'],scheduledAt:new Date().toISOString(),affiliateId:a.id,admin:'owner@fixture.invalid'});assert.equal(r.ok,true,JSON.stringify(r));}
  const posts=await rt.collections.social.find({}).toArray();assert.equal(posts.length,2);assert.notEqual(posts[0].imageUrl,posts[1].imageUrl);
  for(const p of posts){const metadata=p.affiliatePoster;assert.equal(new URL(metadata.qrUrl).searchParams.get('ref'),p.affiliate.liveAffiliateId);assert.ok(p.text.includes(metadata.qrUrl));assert.equal(new URL(metadata.qrUrl).searchParams.get('utm_term'),'facebook');const bytes=await rt.posters.getImage(metadata.portrait.id);const decoded=await decodeQr(bytes.buffer);assert.equal(decoded.ok,true);assert.equal(decoded.text,metadata.qrUrl);}
  assert.equal((await rt.collections.drafts.findOne({id:d.id})).poster.qrUrl,basePoster.qrUrl,'personalized generation must not replace the approved generic poster');
  assert.equal((await rt.social.schedule(d.id,{channels:['facebook'],scheduledAt:new Date().toISOString(),affiliateId:'unresolved-affiliate',admin:'owner@fixture.invalid'})).ok,false);
  await rt.collections.affiliates.updateOne({id:affs[1].id},{$set:{liveAffiliateId:'633333333333333333333333'}});
  const dispatched=await rt.social.dispatch(new Date());assert.equal(dispatched.published,1);assert.equal(dispatched.held,1);assert.equal((await rt.collections.social.findOne({'affiliate.id':affs[1].id})).status,'held');
 }finally{await f.close();}
});
test('unattended follow-ups retain evidence, stop after two and hold when the original conversation has replied',{skip,timeout:30000},async()=>{
 const f=await fixture({posters:false});const{rt}=f;const now=new Date(),root='conversation-fixture';
 try{
  await rt.autonomy.save({...defaults(),enabled:true,allowPublishedBusinessContacts:true},{actor:'owner@fixture.invalid',expectedVersion:0});
  await rt.collections.drafts.insertOne({id:root,kind:'pr',genre:'boxing',recipient:'business@fixture.example',subject:'A sourced fixture pitch',text:'Fixture verified sport discussion.',html:'<body>Fixture only</body>',status:'delivered',ownerApproved:true,sendPermitted:true,sandbox:true,realDelivery:false,providerMessageId:'fixture-capture-0',deliveredAt:new Date(now.getTime()-4*86400000).toISOString(),contactSource:'https://fixture.example/feed',relevanceSource:'https://fixture.example/episode',consentBasis:'Fixture published business contact',followupCount:0});
  await rt.collections.deliveries.insertOne({draftId:root,status:'delivered',providerMessageId:'fixture-capture-0',realDelivery:false});
  // Virtual future dates test follow-up policy only, not uptime evidence.
  for(const days of [0,4,8,12])await rt.tick({now:new Date(now.getTime()+days*86400000)});
  const rows=await rt.collections.drafts.find({followupRoot:root}).toArray();assert.equal(rows.length,2);assert.deepEqual(rows.map(x=>x.followupCount).sort(),[1,2]);assert.ok(rows.every(x=>x.contactSource&&x.consentBasis&&x.relevanceSource));
  await rt.collections.drafts.updateOne({id:root},{$set:{replied:true}});
  await rt.collections.drafts.insertOne({id:'queued-after-reply',followupRoot:root,kind:'pr',recipient:'business@fixture.example',subject:'Fixture',text:'Fixture',status:'approved',ownerApproved:true,sendPermitted:true});
  const before=await rt.collections.sandboxMail.countDocuments();const dispatched=await rt.dispatch(new Date());assert.ok(dispatched.held>0);assert.equal(await rt.collections.sandboxMail.countDocuments(),before);assert.equal((await rt.collections.drafts.findOne({id:'queued-after-reply'})).status,'held');
 }finally{await f.close();}
});
