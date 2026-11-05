'use strict';
const {MongoClient}=require('mongodb');
const crypto=require('node:crypto');
const {validate}=require('./runtime.cjs');
const {decodeQr}=require('../shared/growth-poster-studio');
const ORIGIN='https://fantasymmadness-growth-git-585652-kelly-davis-projects-6c108d0b.vercel.app';
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function inspect(){
 const config=validate();if(process.env.GROWTH_AFFILIATE_SANDBOX_ENABLED!=='true')throw Error('isolated_acceptance_disabled');
 const client=await new MongoClient(config.secrets.mongoUri,{maxPoolSize:2,serverSelectionTimeoutMS:10000}).connect();
 try{
  const db=client.db('fmgrowthtest');
  const snapshot=async()=>({affiliates:await db.collection('preview198_growth_affiliates').find({}).sort({_id:1}).toArray(),posters:await db.collection('preview198_growth_posters').find({}).sort({_id:1}).toArray()});
  const before=digest(await snapshot());
  const rows=await db.collection('preview198_growth_drafts').find({kind:'marketing',status:{$in:['needs_owner_review','approved']}}).toArray();
  let fightId;for(const d of rows){const v=await db.collection('preview198_growth_contest_verifications').findOne({_id:d.contestId,fingerprint:d.contestFingerprint,eligible:true,verifiedAt:{$gte:new Date(Date.now()-35*60000).toISOString()}});if(v&&!require('../shared/growth-contest-campaigns').checkCampaign(d,d.contest,{now:new Date()}).length){fightId=d.contestId;break;}}
  if(!fightId)throw Error('fresh_published_eligible_fight_required');
  const response=await fetch(ORIGIN+'/api/growth/internal/affiliate-sandbox/acceptance',{method:'POST',headers:{Authorization:'Bearer '+config.secrets.cronSecret,'Content-Type':'application/json'},body:JSON.stringify({runId:'issue202-affiliate-final-20261105-v1',fightId,confirmation:'RUN STAGING ACCEPTANCE',campaignAttribution:{utm_source:'fan_acquisition',utm_medium:'partner_outreach',utm_campaign:'combat_fans_aff_the_dozen_with_liam__7d7a',utm_content:'onboarding'}}),redirect:'error',signal:AbortSignal.timeout(240000)});
  if(!response.ok)throw Error('isolated_http_acceptance_failed_'+response.status);
  const output=await response.json();
  for(const league of output.result.leagues){const r=await fetch(ORIGIN+league.qrUrl,{redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('served_qr_unavailable');const bytes=Buffer.from(await r.arrayBuffer());if(bytes.length>1024*1024)throw Error('served_qr_too_large');const qr=await decodeQr(bytes);if(!qr.ok||qr.text!==league.link)throw Error('served_qr_destination_mismatch');league.servedQrDecodedMatches=true;}
  output.originalAffiliateAndPosterRecordsUnchanged=before===digest(await snapshot());
  if(!output.originalAffiliateAndPosterRecordsUnchanged)throw Error('original_records_changed_during_acceptance');
  return {...output,imagesExported:false,liveSignupHandlerUsed:false,database:'fmgrowthtest',checkedAt:new Date().toISOString()};
 }finally{await client.close();}
}
module.exports={inspect};
