'use strict';
// This immutable grant is the owner's exact chat approval on 2026-11-09.
// It authorizes one post per named account, never other campaigns or recurrence.
const crypto = require('node:crypto');
const ID = 'owner-approved-brand-20261109';
const TEXT = "FIGHT FANS, IT'S TIME!\n\nThink you know who's going to win the next big fight?\n\nPut your fight knowledge to the test with FANTASY MMADNESS!\n\nBOXING • MMA • BARE-KNUCKLE • KICKBOXING • PRO WRESTLING\n\nMake your predictions. Compete against other fans. Climb the leaderboard!\n\nJOIN THE ACTION NOW!\n\nFANTASYMMADNESS.COM\n\n#FantasyMMadness #Boxing #MMA #UFC #BKFC #CombatSports";
const IMAGE = 'https://www.fantasymmadness.com/images/brand/fantasy-mmadness-main-logo-v23.jpg';
const IMAGE_SHA256 = 'fdf24ab39ebc8d11bf37ba2f7437bd8a4ea0451a22a4324148bf834a5328ed19';
const DESTINATIONS = Object.freeze({facebook:'128043637053328',instagram:'17841447949460050'});
const grant = Object.freeze({id:ID,text:TEXT,imageUrl:IMAGE,imageSha256:IMAGE_SHA256,website:'https://www.fantasymmadness.com',destinations:DESTINATIONS,usesPerAccount:1});
const hash = crypto.createHash('sha256').update(JSON.stringify(grant)).digest('hex');
function createApprovedBrandPublication({settings,audit,meta,canSend,fetchImpl=globalThis.fetch,clock=()=>new Date()}) {
 const key = channel => ID+':'+channel;
 async function status(){return Object.fromEntries(await Promise.all(Object.keys(DESTINATIONS).map(async channel=>{const r=await settings.findOne({_id:key(channel)});return[channel,r?{state:r.state,receipt:r.receipt||null,reason:r.reason||null,approvedPayloadHash:r.approvedPayloadHash}:null];})));}
 async function publish(authorizationId){
  if(authorizationId!==ID)return{ok:false,reason:'exact_brand_authorization_required'};
  if(!await canSend())return{ok:false,reason:'distribution_paused'};
  const readiness=await meta.readiness();
  for(const [channel,destinationId] of Object.entries(DESTINATIONS)){
   if(await settings.findOne({_id:key(channel)}))continue;
   if(!readiness[channel]?.ready||readiness[channel].destinationId!==destinationId)continue;
   // Verify the exact approved artwork before claiming a send. No replacement image.
   const image=await fetchImpl(IMAGE,{redirect:'error',signal:AbortSignal.timeout(20000)});
   if(!image.ok||!String(image.headers.get('content-type')).startsWith('image/'))return{ok:false,reason:'approved_brand_artwork_unavailable'};
   const bytes=Buffer.from(await image.arrayBuffer());
   if(bytes.length>5*1024*1024||crypto.createHash('sha256').update(bytes).digest('hex')!==IMAGE_SHA256)return{ok:false,reason:'approved_brand_artwork_changed'};
   if(!await canSend())return{ok:false,reason:'distribution_paused'};
   await audit.insertOne({action:'exact_brand_publication_authorized',authorizationId:ID,channel,destinationId,grant,approvedPayloadHash:hash,source:'explicit_owner_chat_approval',at:clock().toISOString()});
   let claim;try{claim=await settings.updateOne({_id:key(channel)},{$setOnInsert:{state:'attempting',approvedPayloadHash:hash,channel,destinationId,grant,attemptedAt:clock().toISOString(),source:'explicit_owner_chat_approval'}},{upsert:true});}catch(e){if(e.code===11000)continue;throw e;}
   if(claim.upsertedCount!==1)continue;
   let result;
   try{result=await meta.publish({id:key(channel),channel,destinationId,text:TEXT,imageUrl:IMAGE},{canSend});}catch{result={ok:false,uncertain:true,reason:'provider_outcome_unknown'};}
   const state=result.ok?'published':result.uncertain?'needs_check':'failed';
   await settings.updateOne({_id:key(channel),state:'attempting'},{$set:{state,receipt:result.receipt||null,reason:result.reason||null,completedAt:clock().toISOString()}});
   await audit.insertOne({action:'exact_brand_publication_result',authorizationId:ID,channel,state,receipt:result.receipt||null,reason:result.reason||null,at:clock().toISOString()});
  }
  return{ok:true,publications:await status()};
 }
 return{publish,status};
}
module.exports={createApprovedBrandPublication,ID,grant,hash};
