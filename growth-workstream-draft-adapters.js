'use strict';
// Safe draft-only adapters for the five Growth Engine departments.
// No network calls, payments, public posts, or outbound email.
const {renderBusinessEmail}=require('./growth-business-email-templates');
const {campaignMetrics}=require('./growth-followup-reporting');
const {GENRES}=require('./growth-ten-agent-discovery');
function createDraftAdapters({research=[],prospects=[],events=[]}={}){
 const valid=new Set(GENRES);
 const byGenre=(rows,genre)=>rows.filter(x=>x&&x.genre===genre&&x.verified===true);
 return {
  audience:async({genre})=>({genre,verifiedProspects:byGenre(prospects,genre).length,status:'research_only'}),
  marketing:async({genre})=>({genre,drafts:byGenre(research,genre).filter(x=>/^https:\/\//.test(x.sourceUrl||'')).map(x=>({title:String(x.title||'').slice(0,180),sourceUrl:x.sourceUrl,status:'needs_review',published:false})),status:'draft_only'}),
  'public-relations':async({genre})=>({genre,drafts:byGenre(prospects,genre).filter(x=>x.category==='media').map(x=>({prospectId:x.id,template:renderBusinessEmail({type:'media',recipientName:x.name||'Partner'}),status:'needs_review',sent:false})),status:'draft_only'}),
  'affiliate-recruitment':async({genre})=>({genre,drafts:byGenre(prospects,genre).filter(x=>x.category==='affiliate'&&!x.optedOut).map(x=>({prospectId:x.id,template:renderBusinessEmail({type:'affiliate',recipientName:x.name||'Partner'}),status:'needs_review',sent:false})),status:'draft_only'}),
  performance:async({genre})=>({genre,metrics:campaignMetrics(events.filter(x=>x?.genre===genre)),status:'unverified_summary'})
 };
}
module.exports={createDraftAdapters};
