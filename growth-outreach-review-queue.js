'use strict';
// Explicit owner-review queue for media and affiliate outreach.
// No delivery or approval inferred from contact verification.
const {renderBusinessEmail}=require('./growth-business-email-templates');
const {GENRES}=require('./growth-ten-agent-discovery');
function prepareOutreachReview(prospects=[]){
 if(!Array.isArray(prospects))throw Error('Prospect list required');
 const seen=new Set(),drafts=[],blocked=[];
 for(const p of prospects){
  const id=String(p?.id||'').trim();
  if(!id||seen.has(id)||!GENRES.includes(p.genre)||!['media','affiliate'].includes(p.category)||p.verified!==true||p.optedOut===true){
   blocked.push({id,reason:'invalid_duplicate_unverified_or_suppressed'});continue;
  }
  seen.add(id);
  if(p.contactVerified!==true||typeof p.contact!=='string'||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.contact)){
   blocked.push({id,reason:'verified_contact_required'});continue;
  }
  if(p.consent!==true){blocked.push({id,reason:'consent_required'});continue;}
  const template=renderBusinessEmail({type:p.category==='media'?'media':'affiliate',recipientName:p.name||'Partner'});
  drafts.push({id:'review-'+id,prospectId:id,genre:p.genre,category:p.category,recipient:p.contact,
   subject:template.subject,html:template.html,text:template.text,status:'needs_owner_review',
   ownerApproved:false,sendPermitted:false,sent:false});
 }
 return {drafts,blocked,outboundMessages:0};
}
module.exports={prepareOutreachReview};
