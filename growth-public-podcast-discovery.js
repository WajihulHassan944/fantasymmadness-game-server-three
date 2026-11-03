'use strict';
// Read-only, authorized public Apple Podcasts discovery adapter.
// No scraping, contact extraction, outreach, publishing or production writes.
const {GENRES}=require('./growth-ten-agent-discovery');
const TERMS=Object.freeze({'boxing':'boxing podcast','mma-ufc':'MMA UFC podcast','kickboxing':'kickboxing podcast','bare-knuckle':'bare knuckle boxing podcast','pro-wrestling':'professional wrestling podcast'});
function createPodcastDiscovery({fetchImpl=globalThis.fetch,timeoutMs=10000}={}){
 if(typeof fetchImpl!=='function')throw Error('fetch adapter required');
 return async function discover({genre,focus,limit=10,signal}={}){
  if(!GENRES.includes(genre)||!['fans','partners'].includes(focus))throw Error('Unsupported discovery category');
  if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid discovery limit');
  const url='https://itunes.apple.com/search?'+new URLSearchParams({term:TERMS[genre],media:'podcast',entity:'podcast',country:'US',limit:String(limit)});
  const response=await fetchImpl(url,{method:'GET',signal:signal||AbortSignal.timeout(timeoutMs),headers:{Accept:'application/json','User-Agent':'FANTASYMMADNESS-Research/1.0'}});
  if(!response.ok)throw Error('Podcast provider HTTP '+response.status);
  const data=await response.json();
  if(!Array.isArray(data?.results))throw Error('Invalid provider response');
  return data.results.slice(0,limit).map(x=>({
   name:String(x.collectionName||'').slice(0,250),
   url:String(x.collectionViewUrl||''),
   source:'Apple Podcasts public search',
   audienceSize:null
  })).filter(x=>x.name&&/^https:\/\//.test(x.url));
 };
}
module.exports={createPodcastDiscovery};
