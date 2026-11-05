'use strict';
// Read-only inventory. Never returns image bytes, contacts, OAuth records or secrets.
const crypto=require('node:crypto');
const {decode}=require('he');
const {decodeQr}=require('./growth-poster-studio');
const {onboardingLink,playerLink}=require('./growth-affiliate-program');
const SITE='https://www.fantasymmadness.com';
const signature=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
function links(text){return [...new Set((decode(String(text||'')).match(/https:\/\/[^\s<>"']+/g)||[]).map(x=>x.replace(/[),.;]+$/,'')))].filter(x=>{try{const u=new URL(x);return ['fantasymmadness.com','www.fantasymmadness.com'].includes(u.hostname)&&/^\/(?:auth|affiliate-create-account|league|fight|pro-wrestling|r)(?:\/|$)/.test(u.pathname);}catch{return false;}});}
async function resolveDestination(row,{fetchImpl=globalThis.fetch}={}){
 const chain=[];let url=row.decodedUrl;
 if(!url)return{decision:'FAIL',reason:row.decodeError||'qr_could_not_be_decoded',observedDestination:null,redirects:chain};
 if(row.syntheticAffiliate)return{decision:'HOLD',reason:'synthetic_affiliate_not_a_real_league',observedDestination:null,redirects:chain,affiliateIdMatch:'fixture_only'};
 try{
  for(let hop=0;hop<=5;hop++){
   const u=new URL(url);if(!['fantasymmadness.com','www.fantasymmadness.com'].includes(u.hostname)||u.protocol!=='https:'||u.username||u.password||u.port||!/^\/(?:auth|affiliate-create-account|league|fight|pro-wrestling)(?:\/|$)/.test(u.pathname))throw Error('untrusted_destination');
   const r=await fetchImpl(u.toString(),{method:'GET',redirect:'manual',headers:{'User-Agent':'FANTASY-MMADNESS-Isolated-Link-Audit/1.0','Accept':'text/html'},signal:AbortSignal.timeout(12000)});const location=r.headers.get('location');chain.push({url:u.toString(),status:r.status,...(location?{location}: {})});await r.body?.cancel?.();
   if([301,302,303,307,308].includes(r.status)){if(!location)throw Error('redirect_location_missing');url=new URL(location,u).toString();continue;}
   const original=new URL(row.decodedUrl),campaignKeys=['utm_source','utm_medium','utm_campaign','utm_content','utm_term'];
   const tracking=campaignKeys.filter(k=>original.searchParams.has(k)).every(k=>u.searchParams.get(k)===original.searchParams.get(k));
   const affiliate=row.expectedAffiliateId?['ref','affiliateId','referrer'].some(k=>u.searchParams.get(k)===row.expectedAffiliateId):null;
   const fight=row.expectedFightId?u.pathname.includes(row.expectedFightId)||u.searchParams.get('fightId')===row.expectedFightId||u.searchParams.get('fight')===row.expectedFightId:null;
   const signup=!row.expectedDestination?.includes('signup')||u.pathname==='/auth'&&u.searchParams.get('role')==='affiliate'&&u.searchParams.get('mode')==='signup';
   const issues=[!r.ok?'destination_http_'+r.status:null,!tracking?'campaign_parameters_lost':null,affiliate===false?'affiliate_identity_mismatch':null,fight===false?'fight_identity_mismatch':null,!signup?'incorrect_signup_destination':null,row.expectedUrl&&row.expectedUrl!==row.decodedUrl?'qr_differs_from_expected_link':null,row.qrMetadataMatch===false?'qr_metadata_mismatch':null].filter(Boolean);
   const holds=[...(row.approvalBlockers||[]),row.termsVerified===false?'affiliate_terms_not_verified':null,row.status==='withdrawn'?'withdrawn_artwork_not_eligible':null].filter(Boolean);
   return{observedDestination:u.toString(),redirects:chain,affiliateIdMatch:affiliate===null?'not_applicable':affiliate,fightIdMatch:fight===null?'not_applicable':fight,attributionResult:tracking?'campaign_parameters_preserved':'campaign_parameters_lost',linkDecision:issues.length?'FAIL':'PASS',decision:issues.length?'FAIL':holds.length?'HOLD':'PASS',reasons:[...issues,...holds]};
  }throw Error('redirect_limit');
 }catch(e){return{decision:e.message==='untrusted_destination'?'FAIL':'HOLD',reason:['untrusted_destination','redirect_limit','redirect_location_missing'].includes(e.message)?e.message:'destination_check_unavailable',observedDestination:chain.at(-1)?.url||null,redirects:chain};}
}
async function inventory({db,resolve=false,fetchImpl=globalThis.fetch}){
 if(db.databaseName!=='fmgrowthtest')throw Error('isolated_database_required');
 const col=n=>db.collection('preview198_'+n);
 const affiliates=await col('growth_affiliates').find({}).sort({id:1}).toArray(),before=signature(affiliates);
 const drafts=await col('growth_drafts').find({},{projection:{id:1,kind:1,status:1,subject:1,prospectId:1,recruitmentSource:1,contest:1,contestId:1,poster:1,text:1,html:1,signupUrl:1,approvalBlockers:1,personalization:1}}).toArray();
 const prospects=await col('growth_prospects').find({},{projection:{id:1,name:1,genre:1,research:1}}).toArray(),recruits=await col('affiliate_prospects').find({},{projection:{id:1,name:1,sport:1,evidence:1,contact:1}}).toArray();
 const posts=await col('growth_social_posts').find({},{projection:{id:1,draftId:1,affiliate:1,affiliatePoster:1,text:1,status:1}}).toArray();
 const rows=[];
 for(const d of drafts){const p=prospects.find(p=>p.id===d.prospectId)||recruits.find(p=>p.id===d.prospectId),urls=links([d.text,d.html,d.signupUrl].join('\n'));
  for(const url of urls)rows.push({sourceItem:d.id,sourceType:'email_'+d.kind,status:d.status,title:d.subject||p?.name||d.id,decodedUrl:url,expectedDestination:d.kind==='affiliate'?'affiliate signup; no existing league asserted':'fight information',expectedAffiliateId:null,expectedFightId:d.contestId||null,campaignRequired:d.kind==='affiliate',termsVerified:false,approvalBlockers:d.approvalBlockers||[],recipientRelevance:p?{name:p.name||p.research?.show?.title,sport:p.genre||p.sport,verifiedResearch:p.research?.ok===true||Boolean(p.evidence?.length),sourceUrls:[...(p.research?.evidence||[]),...(p.evidence||[])].map(e=>e.sourceUrl||e.source).filter(x=>/^https:\/\//.test(x||'')).slice(0,8)}:null});
 }
 const metadata=await col('growth_posters').find({},{projection:{bytes:0,art:0,layout:0}}).sort({id:1}).toArray();
 for(const p of metadata){const d=drafts.find(d=>d.id===p.draftId),post=posts.find(x=>[x.affiliatePoster?.portrait?.id,x.affiliatePoster?.story?.id].includes(p.id)),a=post?.affiliate;
  const stored=await col('growth_posters').findOne({id:p.id},{projection:{bytes:1}});let decoded={ok:false,reason:'image_missing'};if(stored?.bytes){const b=stored.bytes;decoded=await decodeQr(Buffer.isBuffer(b)?b:Buffer.from(b.buffer||b));}
  rows.push({sourceItem:p.id,sourceType:a?'personalized_poster_qr':'fight_poster_qr',status:p.withdrawnAt?'withdrawn':'generated',format:p.format,decodedUrl:decoded.ok?decoded.text:null,decodeError:decoded.ok?null:decoded.reason,expectedUrl:post?.affiliatePoster?.qrUrl||d?.poster?.qrUrl||p.qrUrl,expectedDestination:'fight entry',expectedFightId:p.contestId,expectedAffiliateId:a?.liveAffiliateId||null,qrMetadataMatch:decoded.ok&&decoded.text===p.qrUrl,attributionRequired:true});
 }
 const contests=drafts.filter(d=>d.kind==='marketing'&&d.contest).map(d=>d.contest);
 for(const a of affiliates){rows.push({sourceItem:a.id,sourceType:'affiliate_onboarding_link',title:a.name,status:a.status,syntheticAffiliate:a.synthetic===true,decodedUrl:onboardingLink(a),expectedDestination:'affiliate signup',expectedAffiliateId:null,campaignRequired:true,termsVerified:false});for(const c of contests){const url=playerLink(a,c);if(url)rows.push({sourceItem:a.id+':'+c.id,sourceType:'personalized_fight_link',title:a.name,status:a.status,syntheticAffiliate:a.synthetic===true,decodedUrl:url,expectedDestination:'affiliate fight entry',expectedAffiliateId:a.liveAffiliateId,expectedFightId:c.id,attributionRequired:true});}}
 for(const p of posts)for(const url of links(p.text))rows.push({sourceItem:p.id,sourceType:'social_link',status:p.status,decodedUrl:url,expectedDestination:p.affiliate?'affiliate fight entry':'fight entry',expectedAffiliateId:p.affiliate?.liveAffiliateId||null,expectedFightId:drafts.find(d=>d.id===p.draftId)?.contestId||null,attributionRequired:true});
 const legacyTarget=[];
 for(const name of ['growth_drafts','growth_sandbox_mail','preview198_growth_sandbox_mail'])for(const d of await db.collection(name).find({$or:[{subject:{$regex:'dozen|liam tuffs',$options:'i'}},{text:{$regex:'dozen|liam tuffs',$options:'i'}},{html:{$regex:'dozen|liam tuffs',$options:'i'}}]},{projection:{id:1,draftId:1,subject:1,text:1,html:1,status:1,kind:1,prospectId:1,genre:1,personalization:1}}).limit(20).toArray()){
  for(const url of links([d.text,d.html].join('\n')))legacyTarget.push({sourceItem:d.id||d.draftId||String(d._id),sourceType:'legacy_recruitment_link',namespace:name,title:d.subject||'The Dozen / Liam Tuffs match',status:d.status||'historical',decodedUrl:url,expectedDestination:'affiliate signup; no league exists without verified account mapping',expectedAffiliateId:null,campaignRequired:true,termsVerified:false,proposalLanguage:/would like to set up|proposal|could|potential/i.test(d.text||''),existingLeagueVerified:false,recipientRelevance:{sport:d.genre||null,verifiedResearch:Boolean(d.personalization?.evidence?.length),affiliateSuitabilityVerified:false},approvalBlockers:['legacy_namespace_not_modified','recipient_affiliate_suitability_requires_evidence']});
 }
 rows.push(...legacyTarget);
 if(resolve){const requests=new Map(),cachedFetch=(url,options)=>{if(!requests.has(url))requests.set(url,(async()=>{const r=await fetchImpl(url,options);await r.body?.cancel?.();return{ok:r.ok,status:r.status,headers:r.headers};})());return requests.get(url);};for(let i=0;i<rows.length;i+=3)await Promise.all(rows.slice(i,i+3).map(async r=>{r.resolution=await resolveDestination(r,{fetchImpl:cachedFetch});}));}
 const after=signature(await col('growth_affiliates').find({}).sort({id:1}).toArray());
 return{checkedAt:new Date().toISOString(),database:'fmgrowthtest',collectionPrefix:'preview198_',readOnly:true,affiliateRecordsUnchanged:before===after,imagesExported:false,inventory:{drafts:drafts.length,affiliateDrafts:drafts.filter(d=>d.kind==='affiliate').length,posterImages:metadata.length,currentPosterImages:metadata.filter(p=>!p.withdrawnAt).length,activeMappedAffiliates:affiliates.filter(a=>a.status==='active'&&a.liveAffiliateId&&!a.synthetic).length,syntheticMappedAffiliates:affiliates.filter(a=>a.synthetic).length,socialPosts:posts.length,liamTuffsLegacyLinks:legacyTarget.length},rows};
}
module.exports={inventory,links,resolveDestination,SITE};
