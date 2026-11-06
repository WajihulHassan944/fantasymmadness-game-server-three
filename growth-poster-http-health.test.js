'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {MongoClient}=require('mongodb'),{renderPoster,qrLink,RENDER_VERSION}=require('./growth-poster-studio'),{createPosterHttpHealth}=require('./growth-poster-http-health');
const uri=process.env.GROWTH_TEST_MONGO_URI,skip=!/^mongodb:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(uri||'');
test('served staging poster checks validate actual JPEG integrity, dimensions, QR, cache and safe aggregate output',{skip,timeout:60000},async()=>{
 const client=await new MongoClient(uri).connect(),base=client.db('fmgrowthtest'),prefix='http_poster_'+crypto.randomBytes(5).toString('hex')+'_',db={databaseName:'fmgrowthtest',collection:n=>base.collection(prefix+n)},contest={id:'fixture-http-poster',sport:'boxing',fighterA:'Fixture A',fighterB:'Fixture B',dateKey:'2026-11-08',contestUrl:'https://www.fantasymmadness.com/fight/fixture-http-poster'},qrUrl=qrLink(contest),images=new Map(),origin='https://growth-preview.example.test';
 let now=new Date(),calls=0,corrupt=false;const poster={renderVersion:RENDER_VERSION,status:'ready',needsArtwork:false,qrUrl};
 try{
  for(const format of ['portrait','story']){const id='a'.repeat(20)+'-'+format,r=await renderPoster({contest,format,qrUrl});poster[format]={id};images.set(origin+'/api/growth/posters/'+id+'.jpg',r.buffer);await db.collection('preview198_growth_posters').insertOne({id,sha256:crypto.createHash('sha256').update(r.buffer).digest('hex')});}
  await db.collection('preview198_growth_drafts').insertOne({id:'fixture-draft',kind:'marketing',status:'needs_owner_review',contestFingerprint:'fixture',poster});
  const m=createPosterHttpHealth({db,origin,clock:()=>now,fetchImpl:async url=>{calls++;return{ok:true,headers:new Headers({'content-type':'image/jpeg'}),arrayBuffer:async()=>corrupt?Buffer.alloc(30000):images.get(url)};}});
  const first=await m.check();assert.equal(first.checked,2);assert.equal(first.passed,2);assert.equal(first.imagesExported,false);assert.equal(JSON.stringify(first).includes('aaaa'),false);assert.equal(JSON.stringify(first).includes(qrUrl),false);
  assert.deepEqual(await m.check(),first);assert.equal(calls,2,'bounded cache prevents repeated expensive anonymous work');
  now=new Date(+now+301000);corrupt=true;const bad=await m.check();assert.equal(bad.failed,2);assert.deepEqual(bad.technicalErrors,['served_poster_integrity_failed']);
  corrupt=false;now=new Date(+now+301000);await db.collection('preview198_growth_drafts').updateOne({id:'fixture-draft'},{$set:{'poster.qrUrl':qrUrl+'&ref=wrong'}});assert.equal((await m.check()).failed,2);
  assert.throws(()=>createPosterHttpHealth({db:{databaseName:'production'},origin}),/isolated/);
 }finally{for(const c of await base.listCollections({name:{$regex:'^'+prefix}}).toArray())await base.collection(c.name).drop();await client.close();}
});
