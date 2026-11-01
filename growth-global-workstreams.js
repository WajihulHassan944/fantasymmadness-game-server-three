'use strict';
// Expandable scheduling catalog. Definitions only: no live calls, emails, or writes.
const {GENRES}=require('./growth-ten-agent-discovery');
const FUNCTIONS=Object.freeze(['audience','marketing','public-relations','affiliate-recruitment','performance']);
function planWorkstreams({functions=FUNCTIONS,genres=GENRES}={}){
 const unique=new Set(),out=[];
 for(const genre of genres)for(const functionName of functions){
  const id=`${genre}:${functionName}`;
  if(unique.has(id))continue;
  unique.add(id);out.push(Object.freeze({id,genre,functionName,enabled:true,requiresAuthorizedAdapter:true}));
 }
 return out;
}
function distribute({workers,capacity=10}={}){
 if(!Array.isArray(workers)||!Number.isInteger(capacity)||capacity<1)throw Error('Invalid worker capacity');
 return Array.from({length:Math.ceil(workers.length/capacity)},(_,i)=>workers.slice(i*capacity,(i+1)*capacity));
}
module.exports={FUNCTIONS,planWorkstreams,distribute};
