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
  const fightIds=[];for(const d of rows){const v=await db.collection('preview198_growth_contest_verifications').findOne({_id:d.contestId,fingerprint:d.contestFingerprint,eligible:true,verifiedAt:{$gte:new Date(Date.now()-35*60000).toISOString()}});if(v&&!require('../shared/growth-contest-campaigns').checkCampaign(d,d.contest,{now:new Date()}).length){if(!fightIds.includes(d.contestId))fightIds.push(d.contestId);}}
  if(!fightIds.length)throw Error('fresh_published_eligible_fight_required');
  const journeys=[];let output;for(const fightId of fightIds){
  const response=await fetch(ORIGIN+'/api/growth/internal/affiliate-sandbox/acceptance',{method:'POST',headers:{Authorization:'Bearer '+config.secrets.cronSecret,'Content-Type':'application/json'},body:JSON.stringify({runId:'issue202-affiliate-final-20261105-'+fightId,fightId,confirmation:'RUN STAGING ACCEPTANCE',campaignAttribution:{utm_source:'fan_acquisition',utm_medium:'partner_outreach',utm_campaign:'combat_fans_aff_the_dozen_with_liam__7d7a',utm_content:'onboarding'}}),redirect:'error',signal:AbortSignal.timeout(240000)});
  if(!response.ok)throw Error('isolated_http_acceptance_failed_'+response.status);
  output=await response.json();
  for(const league of output.result.leagues){const r=await fetch(ORIGIN+league.qrUrl,{redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('served_qr_unavailable');const bytes=Buffer.from(await r.arrayBuffer());if(bytes.length>1024*1024)throw Error('served_qr_too_large');const qr=await decodeQr(bytes);if(!qr.ok||qr.text!==league.link)throw Error('served_qr_destination_mismatch');league.servedQrDecodedMatches=true;}
  journeys.push(output.result);}
  output.journeys=journeys;output.result=journeys[0];
  output.originalAffiliateAndPosterRecordsUnchanged=before===digest(await snapshot());
  if(!output.originalAffiliateAndPosterRecordsUnchanged)throw Error('original_records_changed_during_acceptance');
  const inventory=await require('../shared/growth-link-audit').inventory({db,resolve:false});const current=inventory.rows.filter(r=>r.sourceType==='fight_poster_qr'&&r.status!=='withdrawn');output.currentFightPosters={checked:current.length,passed:current.filter(r=>r.qrMetadataMatch).length,withdrawnExcluded:inventory.rows.filter(r=>r.status==='withdrawn').length,imagesExported:false};output.socialConnections={oauth:await db.collection('growth_social_accounts').find({},{projection:{_id:0,provider:1,status:1,confirmed:1,username:1,tokenExpiresAt:1}}).toArray(),meta:await require('../shared/growth-existing-meta-readonly').createExistingMetaReadOnly({db,env:process.env}).summary()};const settings=db.collection('preview198_growth_settings');const scheduler=await settings.findOne({_id:'managed-scheduler'});output.scheduler={enabled:scheduler?.enabled,generation:scheduler?.generation,workerDeploymentId:scheduler?.workerDeploymentId,lastCompletedAt:scheduler?.lastCompletedAt,cycles:await db.collection('preview198_managed_worker_cycles').find({finishedAt:{$exists:true}},{projection:{_id:1,finishedAt:1,errors:1,ordinal:1}}).sort({finishedAt:-1}).limit(3).toArray()};
  return {...output,imagesExported:false,liveSignupHandlerUsed:false,database:'fmgrowthtest',checkedAt:new Date().toISOString()};
 }finally{await client.close();}
}
module.exports={inspect};
