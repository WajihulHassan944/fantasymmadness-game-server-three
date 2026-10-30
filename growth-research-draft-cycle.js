'use strict';
// Read-only discovery-to-draft pipeline. Does not send, post or alter production.
const {runDiscovery}=require('./growth-ten-agent-discovery');
const {createPodcastDiscovery}=require('./growth-public-podcast-discovery');
const {createDraftAdapters}=require('./growth-workstream-draft-adapters');
const {executeWorkstreams}=require('./growth-workstream-executor');
async function runResearchDraftCycle({fetchImpl=globalThis.fetch,persist,limitPerWorker=10,capacity=5,signal}={}){
 if(typeof persist!=='function')throw Error('Isolated persistence adapter required');
 const discover=createPodcastDiscovery({fetchImpl});
 const discovery=await runDiscovery({discover,limitPerWorker,signal});
 const prospects=discovery.results.filter(x=>x.focus==='partners').map((x,i)=>({
  id:'podcast-'+i,genre:x.genre,category:'media',name:x.name,sourceUrl:x.url,
  verified:true,contact:null,contactVerified:false,source:x.source
 }));
 const adapters=createDraftAdapters({prospects,research:[],events:[]});
 const execution=await executeWorkstreams({adapters,persist,capacity,signal});
 return {discovery:{workersConfigured:discovery.workersConfigured,uniqueProspects:discovery.uniqueProspects,errors:discovery.errors},
  execution,contactAddressesFound:0,messagesSent:0,publishedPosts:0,paidActions:0,mode:'ISOLATED_RESEARCH_AND_DRAFT'};
}
module.exports={runResearchDraftCycle};
