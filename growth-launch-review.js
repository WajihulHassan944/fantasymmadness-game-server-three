'use strict';
// Read-only, allowlisted owner review evidence. No tokens, recipient addresses or mutations.
const {createPreparationOperations}=require('./growth-preparation-operations');
const {decodeQr}=require('./growth-poster-studio');
const {schedulerStatus}=require('./growth-managed-scheduler');
async function launchReview({db,clock=()=>new Date()}){
 if(db.databaseName!=='fmgrowthtest')throw Error('isolated_review_database_required');
 const now=clock(),collection=n=>db.collection('preview198_'+n),col={drafts:collection('growth_drafts'),settings:collection('growth_settings'),contestVerifications:collection('growth_contest_verifications'),prospects:collection('growth_prospects'),recruitment:collection('affiliate_prospects'),preparationJobs:collection('growth_preparation_jobs')};
 const quality=createPreparationOperations({col,clock,isSuppressed:async email=>Boolean(await collection('growth_suppressions').findOne({email}))});
 const campaigns=[];
 for(const d of await col.drafts.find({kind:{$in:['marketing','pr']},status:'needs_owner_review'}).limit(50).toArray()){
  const blockers=await quality.quality(d,now),receipt=await collection('growth_preparation_receipts').findOne({draftId:d.id},{sort:{lastCheckedAt:-1}});
  const lead=d.prospectId?await col.prospects.findOne({id:d.prospectId}):null;
  const posters=[];if(d.kind==='marketing')for(const format of ['portrait','story']){
   const id=d.poster?.[format]?.id;if(!id)continue;const image=await collection('growth_posters').findOne({id});
   const b=image?.bytes,decoded=b?await decodeQr(Buffer.isBuffer(b)?b:Buffer.from(b.buffer||b)):{ok:false};
   const ok=decoded.ok&&decoded.text===d.poster.qrUrl;posters.push({id,format,qrDecodedMatches:ok,decodedUrl:decoded.ok?decoded.text:null,withdrawn:Boolean(image?.withdrawnAt)});
   if(!ok||image?.withdrawnAt)blockers.push('actual_poster_qr_requires_review');
  }
  if(d.kind==='marketing'&&posters.length!==2)blockers.push('both_original_poster_formats_required');
  campaigns.push({id:d.id,kind:d.kind,title:d.headline||d.subject,subject:d.subject,genre:d.genre,storedStatus:d.status,ownerApproved:d.ownerApproved===true,sendPermitted:d.sendPermitted===true,decision:blockers.length?'HOLD':'ELIGIBLE_FOR_OWNER_REVIEW',blockers:[...new Set(blockers)],receipt:receipt?{stage:receipt.stage,checkedAt:receipt.lastCheckedAt,blockers:receipt.blockers}:null,contest:d.contest?{id:d.contestId,fighterA:d.contest.fighterA,fighterB:d.contest.fighterB,eventName:d.contest.eventName,dateKey:d.contest.dateKey,timeTba:d.contest.timeTba,timing:d.contest.timing,contestUrl:d.contest.contestUrl}:null,posters,channels:d.channels||[],platforms:Object.fromEntries(Object.entries(d.platformCopy||{}).map(([k,v])=>[k,{ready:v.ready,blockers:v.blockers,caption:v.caption,trackingUrl:v.trackingUrl}])),recipientDomain:String(d.recipient||'').split('@')[1]||null,contactSource:d.contactSource||lead?.research?.contact?.source||null,consentBasis:d.consentBasis||null,sourceEvidence:lead?{id:lead.id,name:lead.name,verifiedResearch:lead.research?.ok===true,researchHold:lead.researchHold||null,researchedAt:lead.researchedAt||lead.research?.checkedAt||null,evidence:(Array.isArray(lead.research?.evidence)?lead.research.evidence:[]).map(e=>({title:e.title,text:e.text,url:e.url||e.sourceUrl,publishedAt:e.publishedAt}))}:null});
 }
 const meta=await db.collection('growth_connections').findOne({key:'meta'},{projection:{selected:1}});
 const maintenance=await col.settings.findOne({_id:'connection-maintenance'});
 const oauth=await db.collection('growth_social_accounts').find({confirmed:true},{projection:{_id:0,provider:1,identity:1,username:1,displayName:1,status:1,grantedScopes:1}}).toArray();
 return{checkedAt:now.toISOString(),readOnly:true,database:'fmgrowthtest',collectionPrefix:'preview198_',scheduler:await schedulerStatus(col.settings),campaigns,discoveryRetries:await col.settings.find({_id:{$regex:'^affiliate-discovery-retry:'}},{projection:{_id:0,sport:1,role:1,failures:1,error:1,nextRetryAt:1,lastSucceededAt:1}}).toArray(),affiliateHoldCount:await collection('growth_preparation_receipts').countDocuments({department:'affiliate',stage:'held_for_evidence'}),connections:{checkedAt:maintenance?.at||null,verificationFresh:Boolean(maintenance?.at&&+now-Date.parse(maintenance.at)>=0&&+now-Date.parse(maintenance.at)<35*60000),providerVerification:(maintenance?.result?.connections||[]).map(p=>({provider:p.provider,status:p.status,accessStatus:p.accessStatus,renewalStatus:p.renewalStatus,grantedScopes:p.grantedScopes})),metaVerification:maintenance?.result?.meta?{facebook:maintenance.result.meta.facebook,instagram:maintenance.result.meta.instagram}:null,metaPermissions:maintenance?.result?.metaPermissions?{verified:maintenance.result.metaPermissions.verified,granted:maintenance.result.metaPermissions.granted}:null,oauth,facebook:{pageId:meta?.selected?.pageId,name:meta?.selected?.pageName},instagram:{accountId:meta?.selected?.igUserId,username:meta?.selected?.igUsername}},publishingEnabled:false,outboundEnabled:false};
}
module.exports={launchReview};
