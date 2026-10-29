'use strict';
// Offline research-to-campaign orchestration. Inputs must be independently verified
// public research records; no invented fighter details, sends or publishing.
const {makeJob,claimDue,settle}=require('./growth-unattended-controller');
const SPORT=new Set(['boxing','mma','bare-knuckle','kickboxing','wrestling']);
const safe=s=>String(s||'').replace(/[\r\n\x00-\x1f]/g,' ').trim().slice(0,160);
function prepareFromResearch({opportunities=[],audiences=[],now=Date.now()}={}){
 const jobs=[],drafts=[],seen=new Set(),skipped=[];
 for(const o of opportunities){
  const id=safe(o.id),sport=safe(o.sport),title=safe(o.title),source=safe(o.sourceUrl);
  if(!id||!SPORT.has(sport)||!title||!/^https:\/\//.test(source)||o.verified!==true){skipped.push({id,reason:'unverified_or_incomplete_research'});continue;}
  if(seen.has(id)){skipped.push({id,reason:'duplicate'});continue;}seen.add(id);
  jobs.push(makeJob({id:'campaign-'+id,type:'prepare_campaign',dueAt:new Date(now).toISOString(),payload:{researchId:id}}));
  drafts.push({id:'campaign-'+id,sport,headline:title,sourceUrl:source,channels:['instagram','facebook','x'],status:'needs_review',published:false,approvalRequired:true});
 }
 for(const a of audiences){
  const id=safe(a.id),name=safe(a.name),kind=safe(a.kind),url=safe(a.sourceUrl);
  if(!id||!name||!['affiliate','media'].includes(kind)||!/^https:\/\//.test(url)||a.verified!==true){skipped.push({id,reason:'unverified_or_incomplete_prospect'});continue;}
  const key='outreach-'+id;if(seen.has(key)){skipped.push({id,reason:'duplicate'});continue;}seen.add(key);
  jobs.push(makeJob({id:key,type:kind==='media'?'prepare_pr':'prepare_campaign',dueAt:new Date(now).toISOString(),payload:{prospectId:id}}));
  drafts.push({id:key,kind,recipient:name,sourceUrl:url,subject:kind==='media'?'Combat sports fan engagement partnership':'FANTASY MMADNESS affiliate invitation',status:'needs_review',sent:false,approvalRequired:true});
 }
 const claimed=claimDue(jobs,now);
 const completed=claimed.map(j=>settle(j,{success:true,now}));
 return {mode:'ISOLATED_DRAFT_ONLY',jobs,completed,drafts,skipped,externalActions:0};
}
module.exports={prepareFromResearch};
