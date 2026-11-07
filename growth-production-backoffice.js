'use strict';
// Reuse the approved console's read models against production Growth collections.
// This adapter exposes no delivery, approval, credential or game mutation methods.
const {createBackoffice}=require('./growth-backoffice');
const {productionChannelStatus}=require('./growth-production-channel-status');
const {contentVersion}=require('./growth-production-review');
function createProductionBackoffice({runtime,config,status,clock=()=>new Date()}){
 const bo=createBackoffice({runtime,manualOnly:true}),col=runtime.collections;
 async function read(section,q={}){
  const s=await status();
  if(section==='status')return{ok:true,...s,database:{name:s.database,kind:'atlas',hostPinned:true},scheduler:{...s.scheduler,schedulerEnabled:s.scheduler.enabled,preparationPaused:!s.scheduler.enabled,schedule:'every 15 minutes',lastRunAt:s.scheduler.lastCompletedAt,runsLast24h:(await bo.schedulerStatus()).runsLast24h},preparation:await runtime.preparation.summary({details:true}),delivery:{provider:'none',realDelivery:false,blockers:['owner_delivery_approval_not_granted']}};
  if(section==='research'){
    const track = q.track === 'affiliate' ? 'affiliate' : 'pr';
    const focus = track === 'pr' ? 'partners' : 'fans';
    const rows = await col.prospects.find({ track }).sort({ score: -1 }).limit(600).toArray();
    const seen = new Set(); const shows = [];
    for (const p of rows.sort((a, b) => (a.focus === focus ? -1 : 1) - (b.focus === focus ? -1 : 1) || (b.score || 0) - (a.score || 0))) {
      if (seen.has(p.sourceUrl)) continue; seen.add(p.sourceUrl);
      const r = p.research || {};
      shows.push({ id: p.id, name: p.name, genre: p.genre, sourceUrl: p.sourceUrl, score: p.score ?? null, outcome: p.researchOutcome || null, researchedAt: p.researchedAt || null, optedOut: p.optedOut === true,
        show: r.show || null, active: r.active === true, recentEpisode: (r.recentEpisodes || [])[0] || null, evidence: (r.evidence || []).slice(0, 3), feed: r.source?.feed || null,
        contact: r.contact ? { email: r.contact.email, name: r.contact.name || null, source: r.contact.source, field: r.contact.field, basis: r.contact.basis } : (p.contactVerified ? { email: p.contact, manual: true, basis: p.consentNote || null } : null),
        contactProblems: r.contactProblems || [], angle: p.outreach?.angle || null, draftId: p.outreach ? `${track}-${p.id}` : null, error: r.error || null });
    }
    shows.sort((a, b) => (b.score || 0) - (a.score || 0));
    const pending = await col.prospects.countDocuments({ verified: true, optedOut: { $ne: true }, researchedAt: { $exists: false } });
    const count = (o) => shows.filter((x) => x.outcome === o).length;
    return{ ok: true, track, shows: q.genre ? shows.filter((x) => x.genre === q.genre) : shows,
      counts: { researched: shows.length, drafted: shows.filter((x) => x.draftId).length, publishedContacts: shows.filter((x) => x.contact && !x.contact.manual).length, noContact: count('no_verified_contact_route'), noAngle: count('no_evidence_based_angle'), failed: count('research_failed'), waitingForResearch: pending },
      bySport: Object.fromEntries(['boxing', 'mma-ufc', 'kickboxing', 'bare-knuckle', 'pro-wrestling'].map((g) => [g, shows.filter((x) => x.genre === g).length])) };
  }
  if(section==='drafts'){
   const drafts=await runtime.listDrafts({kind:q.kind,status:q.status,contestId:q.contestId,limit:Math.min(100,Number(q.limit)||30)});
   return{ok:true,drafts:await Promise.all(drafts.map(async d=>{
    let blockers;try{blockers=[...await runtime.preparation.quality(d,clock()),...(d.reviewSafety?.state==='hold'&&Array.isArray(d.reviewSafety.reasons)?d.reviewSafety.reasons:[])];}catch{blockers=['draft_assessment_unavailable'];}
    if(d.kind==='affiliate')blockers.push('current_recipient_suitability_requires_owner_verification');
    const ownerHold=await col.ownerCampaignHolds?.findOne({_id:d.id,active:true});
    return{...d,ownerHold:ownerHold?{active:true,reason:ownerHold.reason,at:ownerHold.at}:null,review:{state:blockers.length?'held':'eligible',version:contentVersion(d),blockers:[...new Set(blockers)],ownerApprovalRequired:true,liveDeliveryAuthorized:false,checkedAt:clock().toISOString()}};
   }))};
  }
  if(section==='marketing/coverage')return{ok:true,coverage:await bo.marketingCoverage()};
  if(section==='alerts')return{ok:true,alerts:await runtime.listAlerts({state:q.state==='all'?'':q.state||'open'})};
  if(section==='fighter-assets')return{ok:true,assets:await runtime.posters.library.list()};
  if(section==='analytics')return{ok:true,analytics:await bo.analytics()};
  if(section==='funnel')return{ok:true,funnel:await bo.funnel()};
  if(section==='attribution')return{ok:true,attribution:await bo.attribution()};
  if(section==='runs')return{ok:true,runs:await bo.runs(q)};
  if(section==='jobs')return{ok:true,jobs:await bo.jobs(q)};
  if(section==='reports')return{ok:true,reports:await bo.reports(q)};
  if(section==='audit')return{ok:true,entries:await bo.auditLog(q)};
  if(section==='suppressions')return{ok:true,suppressions:await bo.suppressions(q)};
  if(section==='workstreams')return{ok:true,...await bo.workstreams(q)};
  if(section==='social')return{ok:true,posts:await runtime.social.list({status:q.status}),paused:{paused:true,reason:'production_preparation_only'},provider:'none',channels:productionChannelStatus(s.connections),liveTestApproved:false};
  if(section==='posters')return{ok:true,posters:await col.posters.find({withdrawnAt:{$exists:false}},{projection:{bytes:0,_id:0}}).limit(100).toArray(),enabled:config.posters?.enabled===true};
  if(section==='recruitment'){
   const prospects=await runtime.recruitment.list(q),count=(filter={})=>col.recruitment.countDocuments(filter),d= s.operations.departments.affiliate;
   return{ok:true,prospects,counters:{discovered:await count(),researched:await count({researchedAt:{$exists:true}}),verifiedContacts:await count({'contact.verified':true}),drafted:await col.drafts.countDocuments({kind:'affiliate'}),awaitingApproval:d.awaitingOwnerReview,approved:d.approvedDrafts,sandboxCaptures:0,externalMessagesSent:0,responses:await count({status:'responded'}),onboarded:await count({status:{$in:['onboarding','active']}}),active:await col.affiliates.countDocuments({'identityVerification.verified':true,'identityVerification.environment':'production',status:'active'}),attributedPayingConversions:null},program:await runtime.recruitment.readiness(),lastResearch:await col.settings.findOne({_id:'affiliate-discovery-cursor'}),nextScheduledAt:s.scheduler.lastCompletedAt?new Date(Date.parse(s.scheduler.lastCompletedAt)+900000).toISOString():null,publishingEnabled:false,outboundEnabled:false};
  }
  if(section==='connections'){
   const original=s.connections||{},platforms={};for(const name of ['facebook','instagram']){const x=original.meta?.[name]||{};platforms[name]={verified:x.verified===true,name:x.verified?'Existing authorized '+name+' connection':'',id:'Not exposed in status view',reason:x.reason||x.state||'Verification unavailable'};}
   const channels={};for(const name of ['x','tiktok']){const x=(original.oauth||[]).find(x=>x.provider===name);channels[name]=productionChannelStatus(original)[name];}
   return{ok:true,connections:{meta:{readOnlyExisting:true,platforms:original.metaIdentity?.platforms||platforms,selected:original.metaIdentity?.selected||null,source:original.source||'existing_authorized_connection_service',health:{checkedAt:original.checkedAt},permissions:original.metaPermissions||{verified:false}},social:{provider:'none',approved:false,paused:{paused:true},channels},email:{provider:'none',realDelivery:false,sender:require('./growth-runtime-config').BUSINESS_SENDER},contestFeed:{url:config.contestSourceUrl,readOnly:true},liveRegistrationReport:{configured:false,latest:null},verifiedEventIngest:{configured:false,previewBlocked:true,path:'/api/growth/events'}}};
  }
  return null;
 }
 return{read,editDraft:bo.editDraft};
}
module.exports={createProductionBackoffice};
