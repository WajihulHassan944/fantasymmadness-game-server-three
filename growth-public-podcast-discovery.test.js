'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createPodcastDiscovery}=require('./growth-public-podcast-discovery');
const {runDiscovery}=require('./growth-ten-agent-discovery');
test('real provider adapter maps five genres into read-only discoveries',async()=>{
 const urls=[];
 const discover=createPodcastDiscovery({fetchImpl:async(url,options)=>{
  urls.push(String(url));assert.equal(options.method,'GET');
  return {ok:true,json:async()=>({results:[{collectionName:'Verified podcast listing',collectionViewUrl:'https://podcasts.apple.com/us/podcast/example/id123'}]})};
 }});
 const result=await runDiscovery({discover,limitPerWorker:2});
 assert.equal(urls.length,10);
 assert.equal(result.workersConfigured,10);
 assert.equal(result.uniqueProspects,1);
 assert.equal(result.errors.length,0);
 assert.equal(result.outboundEnabled,false);
 assert(urls.some(x=>x.includes('kickboxing')));
});
test('invalid category and failed provider response are rejected',async()=>{
 const discover=createPodcastDiscovery({fetchImpl:async()=>({ok:false,status:429})});
 await assert.rejects(()=>discover({genre:'boxing',focus:'fans'}),/429/);
 await assert.rejects(()=>discover({genre:'other',focus:'fans'}),/Unsupported/);
});
