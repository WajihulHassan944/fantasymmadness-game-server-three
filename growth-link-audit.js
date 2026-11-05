'use strict';
// Read-only inventory. Never returns image bytes, contacts, OAuth records or secrets.
const crypto=require('node:crypto');
const {decode}=require('he');
const {decodeQr}=require('./growth-poster-studio');
const {onboardingLink,playerLink}=require('./growth-affiliate-program');
const SITE='https://www.fantasymmadness.com';
const signature=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
function links(text){return [...new Set((decode(String(text||'')).match(/https:\/\/[^\s<>"']+/g)||[]).map(x=>x.replace(/[),.;]+$/,'')))].filter(x=>{try{const u=new URL(x);return ['fantasymmadness.com','www.fantasymmadness.com'].includes(u.hostname)&&/^\/(?:auth|affiliate-create-account|league|fight|pro-wrestling|r)(?:\/|$)/.test(u.pathname);}catch{return false;}});}
async function inventory({db}){
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
 for(const a of affiliates){rows.push({sourceItem:a.id,sourceType:'affiliate_onboarding_link',title:a.name,status:a.status,decodedUrl:onboardingLink(a),expectedDestination:'affiliate signup',expectedAffiliateId:null,campaignRequired:true,termsVerified:false});for(const c of contests){const url=playerLink(a,c);if(url)rows.push({sourceItem:a.id+':'+c.id,sourceType:'personalized_fight_link',title:a.name,status:a.status,decodedUrl:url,expectedDestination:'affiliate fight entry',expectedAffiliateId:a.liveAffiliateId,expectedFightId:c.id,attributionRequired:true});}}
 for(const p of posts)for(const url of links(p.text))rows.push({sourceItem:p.id,sourceType:'social_link',status:p.status,decodedUrl:url,expectedDestination:p.affiliate?'affiliate fight entry':'fight entry',expectedAffiliateId:p.affiliate?.liveAffiliateId||null,expectedFightId:drafts.find(d=>d.id===p.draftId)?.contestId||null,attributionRequired:true});
 const after=signature(await col('growth_affiliates').find({}).sort({id:1}).toArray());
 return{checkedAt:new Date().toISOString(),database:'fmgrowthtest',collectionPrefix:'preview198_',readOnly:true,affiliateRecordsUnchanged:before===after,imagesExported:false,inventory:{drafts:drafts.length,affiliateDrafts:drafts.filter(d=>d.kind==='affiliate').length,posterImages:metadata.length,activeMappedAffiliates:affiliates.filter(a=>a.status==='active'&&a.liveAffiliateId).length,socialPosts:posts.length},rows};
}
module.exports={inventory,links,SITE};
