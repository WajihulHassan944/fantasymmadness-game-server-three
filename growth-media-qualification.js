'use strict';
// Qualify public media research without inventing email addresses or consent.
const {GENRES}=require('./growth-ten-agent-discovery');
const httpsUrl=x=>typeof x==='string'&&/^https:\/\//i.test(x);
function qualifyMediaProspects(records=[]){
 if(!Array.isArray(records))throw Error('Research records required');
 const seen=new Set(),accepted=[],rejected=[];
 for(const raw of records){
  const x=raw||{},url=String(x.sourceUrl||x.url||'').trim(),name=String(x.name||'').trim().slice(0,250);
  const key=url.toLowerCase().replace(/\/$/,'');
  if(!GENRES.includes(x.genre)||!name||!httpsUrl(url)||x.verified!==true||x.optedOut===true||seen.has(key)){
   rejected.push({name,reason:'unverified_invalid_suppressed_or_duplicate'});continue;
  }
  seen.add(key);
  const contactVerified=x.contactVerified===true&&typeof x.contact==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x.contact);
  accepted.push({id:String(x.id||'').slice(0,120),genre:x.genre,name,sourceUrl:url,category:'media',verified:true,
   contact:contactVerified?x.contact:null,contactVerified,consent:x.consent===true,
   outreachEligible:contactVerified&&x.consent===true&&x.ownerApproved===true,
   status:'research_qualified',sendPermitted:false});
 }
 return {accepted,rejected,contactsVerified:accepted.filter(x=>x.contactVerified).length,outreachActions:0};
}
module.exports={qualifyMediaProspects};
