'use strict';
const crypto=require('node:crypto');
const {publicGet}=require('./growth-affiliate-recruitment');
const {readable}=require('./growth-text-quality');
const norm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
async function reviewRecipientSources({db,clock=()=>new Date(),get=publicGet}){
 if(db.databaseName!=='fmgrowthtest')throw Error('isolated_recipient_review_required');
 const drafts=db.collection('preview198_growth_drafts'),leads=db.collection('preview198_affiliate_prospects'),prospects=db.collection('preview198_growth_prospects'),audit=db.collection('preview198_growth_audit_log'),now=clock();
 const tasks=(await drafts.find({status:{$in:['needs_owner_review','approved']},kind:{$in:['affiliate','pr']}}).toArray()).map(d=>async()=>{
  const independent=d.recruitmentSource==='independent_public_partner',lead=await(independent?leads:prospects).findOne({id:d.prospectId});
  const row={id:d.id,kind:d.kind,name:lead?.name||null,checkedAt:now.toISOString(),sourceUrl:null,contactMatch:false,identityMatched:false,recentActivityConfirmed:false,structuredStatus:'unknown',decision:'HOLD',errors:[]};
  if(independent&&/^Q\d+$/.test(lead?.sourceId||'')){
   row.sourceUrl='https://www.wikidata.org/wiki/Special:EntityData/'+lead.sourceId+'.json';
   try{const response=await get(row.sourceUrl),data=JSON.parse(response.text),entity=data.entities?.[lead.sourceId];if(!entity)throw Error('entity_mismatch');const death=entity.claims?.P570?.find(c=>c.mainsnak?.datavalue?.value?.time)?.mainsnak.datavalue.value.time;const dissolution=entity.claims?.P576?.find(c=>c.mainsnak?.datavalue?.value?.time)?.mainsnak.datavalue.value.time;row.sourceHash=crypto.createHash('sha256').update(response.text).digest('hex');row.structuredStatus=death?'source_reports_deceased':dissolution?'source_reports_dissolved':'no_current_status_proof';row.reportedDate=death||dissolution||null;
    if(death||dissolution){const reason=death?'source_reports_recipient_deceased':'source_reports_business_dissolved';await leads.updateOne({id:lead.id},{$set:{deceased:Boolean(death),outreachHold:{reason,sourceUrl:row.sourceUrl,checkedAt:now.toISOString()}}});await drafts.updateOne({id:d.id},{$addToSet:{approvalBlockers:reason},$set:{ownerApproved:false,sendPermitted:false,reviewSafety:{state:'hold',reasons:[reason],checkedAt:now.toISOString(),authority:'public_structured_source_review'}}});}
   }catch{row.errors.push('structured_source_verification_unavailable');}
  }else if(d.kind==='pr'){
   const contact=lead?.research?.contact;row.sourceUrl=contact?.source||d.contactSource||null;
   if(!row.sourceUrl||!/^https:\/\//.test(row.sourceUrl))row.errors.push('primary_contact_source_missing');
   else try{const response=await get(row.sourceUrl),text=readable(response.text),title=readable(response.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'').replace(/<!\[CDATA\[|\]\]>/g,'');row.sourceHash=crypto.createHash('sha256').update(response.text).digest('hex');row.contactMatch=Boolean(contact?.email&&contact.email.toLowerCase()===String(d.recipient||'').toLowerCase()&&text.toLowerCase().includes(contact.email.toLowerCase()));const a=norm(title),b=norm(lead?.name);row.identityMatched=Boolean(a.length>8&&b.length>8&&(a.includes(b)||b.includes(a)));const dates=[...response.text.matchAll(/<(?:pubDate|updated|published)[^>]*>([^<]+)<\//gi)].map(m=>Date.parse(m[1])).filter(t=>Number.isFinite(t)&&t<=+now+86400000);const latest=Math.max(...dates);row.latestPublishedAt=Number.isFinite(latest)?new Date(latest).toISOString():null;row.recentActivityConfirmed=Number.isFinite(latest)&&+now-latest<120*86400000;if(row.contactMatch&&row.identityMatched&&row.recentActivityConfirmed)row.decision='PRIMARY_CONTACT_VERIFIED_OWNER_REVIEW_REQUIRED';
   }catch{row.errors.push('primary_contact_source_unavailable');}
   const reason='current_primary_contact_evidence_required';const update=row.decision==='HOLD'?{$addToSet:{approvalBlockers:reason},$set:{ownerApproved:false,sendPermitted:false,recipientSourceReview:row}}:{$pull:{approvalBlockers:reason},$set:{recipientSourceReview:row}};await drafts.updateOne({id:d.id},update);
  }
  await audit.updateOne({action:'recipient_source_review',draftId:d.id},{$set:{checkedAt:now.toISOString(),review:row},$setOnInsert:{action:'recipient_source_review',draftId:d.id}},{upsert:true});return row;
 });
 let index=0;const rows=[];await Promise.all(Array.from({length:Math.min(3,tasks.length)},async()=>{while(index<tasks.length){const task=tasks[index++];rows.push(await task());}}));
 return{checkedAt:now.toISOString(),database:'fmgrowthtest',rows,realDeliveries:0,publishingEnabled:false,outboundEnabled:false,credentialsChanged:false};
}
module.exports={reviewRecipientSources};
