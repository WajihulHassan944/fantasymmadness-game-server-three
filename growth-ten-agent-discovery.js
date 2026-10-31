'use strict';
/**
 * Ten specialized, read-only discovery workers for the five FANTASY MMADNESS genres.
 * No scraping, outbound messaging, ad spend, or production mutations.
 * Supply an authorized source adapter: discover({genre,focus,limit}) -> public records.
 */
const GENRES=Object.freeze(['boxing','mma-ufc','kickboxing','bare-knuckle','pro-wrestling']);
const FOCUSES=Object.freeze(['fans','partners']);
const WORKERS=Object.freeze(GENRES.flatMap((genre,index)=>FOCUSES.map((focus,side)=>Object.freeze({id:`discovery-${index*2+side+1}`,genre,focus}))));
const clean=s=>String(s||'').trim().slice(0,250);
function normalize(item,worker){
 if(!item||typeof item!=='object')return null;
 const url=clean(item.url);
 if(!/^https:\/\//i.test(url))return null;
 const name=clean(item.name);
 if(!name)return null;
 const audience=Number.isFinite(item.audienceSize)&&item.audienceSize>=0?Math.floor(item.audienceSize):null;
 return {name,url,genre:worker.genre,focus:worker.focus,source:clean(item.source)||'authorized-source',audienceSize:audience,observedAt:new Date().toISOString()};
}
async function runDiscovery({discover,limitPerWorker=25,onResult=()=>{},signal}={}){
 if(typeof discover!=='function')throw Error('Authorized discovery adapter required');
 if(!Number.isInteger(limitPerWorker)||limitPerWorker<1||limitPerWorker>100)throw Error('Invalid worker limit');
 const results=[],errors=[],seen=new Set();
 for(const worker of WORKERS){
  if(signal?.aborted)break;
  try{
   const found=await discover({...worker,limit:limitPerWorker,signal});
   if(!Array.isArray(found))throw Error('Adapter must return an array');
   let accepted=0;
   for(const raw of found.slice(0,limitPerWorker)){
    const record=normalize(raw,worker);if(!record)continue;
    const key=record.url.toLowerCase().replace(/\/$/,'');
    if(seen.has(key))continue;
    seen.add(key);results.push(record);accepted++;
    await onResult(record);
   }
  }catch(error){errors.push({worker:worker.id,message:clean(error?.message)||'Discovery error'});}
 }
 return {workersConfigured:WORKERS.length,workersAttempted:WORKERS.length-(signal?.aborted?1:0),uniqueProspects:results.length,results,errors,outboundEnabled:false};
}
module.exports={GENRES,FOCUSES,WORKERS,runDiscovery,normalize};
