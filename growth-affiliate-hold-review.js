'use strict';
// Per-source disposition. Exclusion is not approval; test evidence cannot grant
// commercial eligibility or substitute for an owner's promoter agreement.
const crypto=require('node:crypto');
const {publicGet}=require('./growth-affiliate-recruitment');
const manifest=require('./docs/evidence/growth-affiliate-links-20261105.json');
const digest=s=>crypto.createHash('sha256').update(String(s)).digest('hex');
const cleanHtml=s=>require('he').decode(String(s).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ');
async function publishedTerms({fetchImpl=globalThis.fetch,clock=()=>new Date()}={}){
 const url='https://www.fantasymmadness.com/terms';try{const r=await fetchImpl(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error('terms_unavailable');const html=await r.text();if(Buffer.byteLength(html)>1024*1024)throw Error('terms_too_large');const text=cleanHtml(html),policy=/Leagues, promoters and affiliates/i.test(text)&&/rate stated in your promoter agreement/i.test(text)&&/verified identity/i.test(text);return{sourceUrl:url,sourceHash:digest(html),checkedAt:clock().toISOString(),platformPolicyVerified:policy,commissionBasis:'individual_promoter_agreement',commercialAgreementVerified:false,reason:policy?'approved_promoter_agreement_or_owner_review_required':'affiliate_policy_evidence_missing'};}catch{return{sourceUrl:url,checkedAt:clock().toISOString(),platformPolicyVerified:false,commercialAgreementVerified:false,reason:'published_terms_verification_unavailable'};}}
async function reviewHolds({db,replacementRun=null,fetchImpl=globalThis.fetch,clock=()=>new Date(),verifyContacts=true}){
 if(db.databaseName!=='fmgrowthtest')throw Error('isolated_database_required');const reviews=db.collection('preview198_affiliate_acceptance_hold_reviews'),terms=await publishedTerms({fetchImpl,clock}),ownerTerms=await db.collection('preview198_growth_settings').findOne({_id:'affiliate-terms-review',status:'approved',scope:'staging_recruitment_review',approvedByKind:'owner_session'}),cases=[];
 for(const source of manifest.rows.filter(x=>x.resolution?.decision==='HOLD')){
  let result={sourceItem:source.sourceItem,sourceType:source.sourceType,checkedAt:clock().toISOString(),approvedForPublishing:false,approvedForDelivery:false};
  if(source.status==='withdrawn'){
   const row=await db.collection('preview198_growth_posters').findOne({id:source.sourceItem,withdrawnAt:{$exists:true}},{projection:{withdrawnAt:1}}),refs=await db.collection('preview198_growth_drafts').countDocuments({status:{$in:['needs_owner_review','approved']},$or:[{'poster.portrait.id':source.sourceItem},{'poster.story.id':source.sourceItem}]});result={...result,resolved:Boolean(row)&&refs===0,disposition:row&&refs===0?'EXCLUDED_WITHDRAWN':'HOLD_WITHDRAWAL_NOT_CONFIRMED',activeReferences:refs};
  }else if(source.syntheticAffiliate){
   const passed=replacementRun?.status==='passed'&&replacementRun.attributionPersisted&&replacementRun.uniqueIdentityLinks&&replacementRun.qrDecodedMatches&&replacementRun.replaySameEntry&&replacementRun.crossAffiliateRefused;result={...result,resolved:Boolean(passed),disposition:passed?'REPLACED_BY_APPROVED_STAGING_SIGNUP_TEST':'HOLD_APPROVED_STAGING_EVIDENCE_REQUIRED',originalFixtureUnchanged:true,replacementRunId:passed?replacementRun.runId:null,replacementAccountIds:passed?replacementRun.accounts.map(a=>a.id):[],replacementLeagueIds:passed?replacementRun.leagues.map(l=>l.id):[],commercialAffiliateVerified:false};
  }else if(source.sourceType==='email_affiliate'){
   const draft=await db.collection('preview198_growth_drafts').findOne({id:source.sourceItem},{projection:{id:1,prospectId:1,recruitmentSource:1,recipient:1,approvalBlockers:1,status:1,ownerApproved:1}});
   if(!draft){result={...result,resolved:false,disposition:'HOLD_SOURCE_DRAFT_MISSING'};}
   else if(draft.recruitmentSource!=='independent_public_partner'){
    const p=await db.collection('preview198_growth_prospects').findOne({id:draft.prospectId},{projection:{research:1}}),eligible=p?.research?.affiliateSuitability?.verified===true&&(p.research.affiliateSuitability.evidence||[]).some(e=>/^https:\/\//.test(e.sourceUrl||''));result={...result,resolved:!eligible&&(draft.approvalBlockers||[]).includes('independent_affiliate_suitability_requires_evidence'),disposition:eligible?'HOLD_OWNER_REVIEW_REQUIRED':'EXCLUDED_UNVERIFIED_AFFILIATE_SUITABILITY',researchPreserved:true,sourceDraftUnchanged:true,reason:'Media episode relevance does not establish a qualified affiliate partner. Retained for owner research; excluded from affiliate approval.'};
   }else{
    const lead=await db.collection('preview198_affiliate_prospects').findOne({id:draft.prospectId}),role=(lead?.evidence||[]).find(e=>e.kind==='role'&&/^https:\/\//.test(e.sourceUrl||'')),contact=lead?.contact;let contactVerified=Boolean(contact?.verified&&contact.email?.toLowerCase()===String(draft.recipient||'').toLowerCase()&&/^https:\/\//.test(contact.source||'')),fresh=false,sourceReason=null;
    if(contactVerified&&verifyContacts){try{const page=await publicGet(contact.source,{fetchImpl});fresh=cleanHtml(page.text).toLowerCase().includes(contact.email.toLowerCase())||page.text.toLowerCase().includes('mailto:'+contact.email.toLowerCase());if(!fresh)sourceReason='published_contact_not_reconfirmed';}catch(e){sourceReason=/robots|disallow/.test(e.message)?'publisher_research_restricted':'contact_source_temporarily_unavailable';}}
    const relevant=Boolean(role&&contactVerified),termsApproved=Boolean(ownerTerms?.sourceHash&&ownerTerms.version);result={...result,resolved:relevant&&termsApproved&&(!verifyContacts||fresh),disposition:!relevant?'HOLD_RECIPIENT_QUALIFICATION':verifyContacts&&!fresh?'HOLD_CONTACT_REVERIFICATION':termsApproved?'VERIFIED_FOR_OWNER_DRAFT_REVIEW':'HOLD_OWNER_TERMS_AGREEMENT',recipientRelevant:relevant,roleSource:role?.sourceUrl||null,contactSource:contact?.source||null,publishedContactMatched:fresh,sourceReason,termsPolicyVerified:terms.platformPolicyVerified,promoterAgreementReviewedByOwner:termsApproved,termsSource:ownerTerms?.sourceUrl||terms.sourceUrl,commercialActivationApproved:false};
   }
  }else result={...result,resolved:false,disposition:'HOLD_MANUAL_SOURCE_REVIEW'};
  await reviews.updateOne({_id:source.sourceItem},{$set:result},{upsert:true});cases.push(result);
 }
 return{checkedAt:clock().toISOString(),total:cases.length,resolved:cases.filter(c=>c.resolved).length,remaining:cases.filter(c=>!c.resolved).length,terms,cases,realAffiliateRecordsChanged:false,publishingEnabled:false,outboundEnabled:false};
}
module.exports={reviewHolds,publishedTerms};

async function approveRecruitmentTerms({db,input,authority,fetchImpl=globalThis.fetch,clock=()=>new Date()}){
 if(db.databaseName!=='fmgrowthtest')throw Error('isolated_database_required');
 const fail=reason=>{throw Object.assign(Error(reason),{status:409,reason});};
 if(authority?.kind!=='owner_session'||authority.confirmed!==true)throw Object.assign(Error('owner_terms_review_required'),{status:403,reason:'owner_terms_review_required'});
 if(input?.confirmation!=='APPROVE STAGING RECRUITMENT TERMS')fail('explicit_owner_terms_confirmation_required');
 if(!/^[a-zA-Z0-9 ._-]{3,100}$/.test(String(input.version||'')))fail('terms_version_required');
 let url;try{url=new URL(input.sourceUrl);}catch{fail('terms_source_url_required');}
 if(url.protocol!=='https:'||url.username||url.password||url.toString().length>2048||[...url.searchParams.keys()].some(k=>/token|secret|signature|password/i.test(k)))fail('public_terms_source_required');
 const page=await publicGet(url.toString(),{fetchImpl}),text=cleanHtml(page.text);if(!/affiliate|promoter/i.test(text)||!/revenue|commission|payout/i.test(text)||text.length<200)fail('affiliate_terms_evidence_incomplete');
 const row={_id:'affiliate-terms-review',status:'approved',scope:'staging_recruitment_review',sourceUrl:page.url,sourceHash:digest(page.text),version:input.version,approvedAt:clock().toISOString(),approvedByKind:'owner_session',approvedBy:String(authority.actor).slice(0,120),commercialActivationApproved:false,notificationDeliveryApproved:false};
 await db.collection('preview198_growth_settings').updateOne({_id:row._id},{$set:Object.fromEntries(Object.entries(row).filter(([key])=>key!=='_id'))},{upsert:true});
 await db.collection('preview198_growth_audit_log').insertOne({action:'owner_staging_recruitment_terms_review',at:clock().toISOString(),version:row.version,sourceHash:row.sourceHash,sourceUrl:row.sourceUrl,by:row.approvedBy});
 return{version:row.version,scope:row.scope,sourceUrl:row.sourceUrl,sourceHash:row.sourceHash,commercialActivationApproved:false,outboundEnabled:false};
}
module.exports.approveRecruitmentTerms=approveRecruitmentTerms;
