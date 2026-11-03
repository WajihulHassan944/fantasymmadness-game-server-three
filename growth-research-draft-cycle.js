'use strict';
// Read-only discovery-to-draft pipeline. Does not send, post or alter production.
const {runDiscovery}=require('./growth-ten-agent-discovery');
const {createPodcastDiscovery}=require('./growth-public-podcast-discovery');
const {createDraftAdapters}=require('./growth-workstream-draft-adapters');
const {executeWorkstreams}=require('./growth-workstream-executor');
const {qualifyMediaProspects}=require('./growth-media-qualification');
const {prepareOutreachReview}=require('./growth-outreach-review-queue');
async function runResearchDraftCycle({fetchImpl=globalThis.fetch,persist,limitPerWorker=10,capacity=5,signal}={}){
 if(typeof persist!=='function')throw Error('Isolated persistence adapter required');
 const discover=createPodcastDiscovery({fetchImpl});
 const discovery=await runDiscovery({discover,limitPerWorker,signal});
 const prospects=discovery.results.filter(x=>x.focus==='partners').map((x,i)=>({
  id:'podcast-'+i,genre:x.genre,category:'media',name:x.name,sourceUrl:x.url,
  verified:true,contact:null,contactVerified:false,source:x.source
 }));
 const qualification=qualifyMediaProspects(prospects);
 const reviewQueue=prepareOutreachReview(qualification.accepted);
 const adapters=createDraftAdapters({prospects:qualification.accepted,research:[],events:[]});
 const execution=await executeWorkstreams({adapters,persist,capacity,signal});
 return {discovery:{workersConfigured:discovery.workersConfigured,uniqueProspects:discovery.uniqueProspects,errors:discovery.errors},
  execution,reviewQueue:{drafts:reviewQueue.drafts,blocked:reviewQueue.blocked,outboundMessages:reviewQueue.outboundMessages},qualification:{accepted:qualification.accepted.length,rejected:qualification.rejected.length,contactsVerified:qualification.contactsVerified},contactAddressesFound:0,messagesSent:0,publishedPosts:0,paidActions:0,mode:'ISOLATED_RESEARCH_AND_DRAFT'};
}
module.exports={runResearchDraftCycle};
