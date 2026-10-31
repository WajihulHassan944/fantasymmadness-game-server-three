'use strict';
// Offline stage-7 orchestration. No network, Gmail, payment, scheduler or database I/O.
const {buildQueue}=require('./growth-prospect-queue');
const {nextFollowup,campaignMetrics}=require('./growth-followup-reporting');
function coordinateCampaign({campaignId,prospects,existingRecords=[],nowMs}={}){
 if(!campaignId||!Array.isArray(prospects)||!Array.isArray(existingRecords)||!Number.isFinite(nowMs))throw Error('invalid_campaign_input');
 const queue=buildQueue(prospects,{campaignId,mode:'DRAFT_ONLY'});
 const followups=existingRecords.map(r=>({id:r.id,decision:nextFollowup(r,nowMs)}));
 const metrics=campaignMetrics(existingRecords);
 return {campaignId,mode:'DRAFT_ONLY',outboundEnabled:false,productionWrites:0,
  departments:{
   marketing:{state:'draft_preparation',draftCount:queue.length},
   pr:{state:'draft_preparation',draftCount:queue.filter(x=>x.category==='media').length},
   affiliates:{state:'draft_preparation',draftCount:queue.filter(x=>x.category==='affiliate').length},
   followups:{state:'decision_only',draftCount:followups.filter(x=>x.decision.action==='draft_followup').length},
   reporting:{state:'offline_snapshot'}
  },
  queue,followups,metrics};
}
module.exports={coordinateCampaign};
