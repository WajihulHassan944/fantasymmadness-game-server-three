'use strict';
// Stage 10: create individually personalized drafts; never send or infer contact facts.
const {renderBusinessEmail}=require('./growth-business-email-templates');
function preparePersonalizedDrafts(records,{logoUrl='',unsubscribeUrl=''}={}){
 if(!Array.isArray(records))throw Error('records_required');
 const seen=new Set(),out=[];
 for(const r of records){
  if(!r||r.optedOut||r.suppressed||!r.id||!r.type||!r.recipientName||!r.relevanceNote||!r.relevanceSource)continue;
  const key=String(r.id).toLowerCase();
  if(seen.has(key))continue;
  seen.add(key);
  const email=renderBusinessEmail({type:r.type,recipientName:r.recipientName,personalization:r.relevanceNote,logoUrl,unsubscribeUrl});
  out.push({id:r.id,recipientName:r.recipientName,relevanceSource:r.relevanceSource,...email,status:'draft',approved:false,sent:false});
 }
 return {mode:'DRAFT_ONLY',outboundEnabled:false,drafts:out};
}
module.exports={preparePersonalizedDrafts};
