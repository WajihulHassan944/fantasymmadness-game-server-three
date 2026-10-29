'use strict';
// Pure, offline follow-up decision helper. Does not schedule jobs or send messages.
function nextFollowup(record,nowMs){
 if(!record||!Number.isFinite(nowMs))throw Error('invalid_input');
 if(record.optedOut||record.replied||record.bounced||record.blocked)return {action:'stop',reason:'suppressed_or_responded'};
 if(record.deliveryVerified!==true)return {action:'hold',reason:'delivery_unverified'};
 if(record.ownerApproved!==true)return {action:'hold',reason:'approval_required'};
 const attempts=Number(record.followupCount||0);
 if(!Number.isInteger(attempts)||attempts<0)return {action:'hold',reason:'invalid_attempt_count'};
 if(attempts>=2)return {action:'stop',reason:'followup_limit'};
 const last=Date.parse(record.lastSentAt||'');
 if(!Number.isFinite(last))return {action:'hold',reason:'missing_last_send'};
 const days=attempts===0?4:7;
 const dueAt=new Date(last+days*86400000).toISOString();
 return nowMs>=Date.parse(dueAt)?{action:'draft_followup',dueAt,sendPermitted:false}:{action:'wait',dueAt,sendPermitted:false};
}
function campaignMetrics(records){
 const items=Array.isArray(records)?records:[];
 const count=k=>items.filter(x=>x&&x[k]===true).length;
 return {drafted:items.length,sent:count('sent'),delivered:count('deliveryVerified'),replied:count('replied'),bounced:count('bounced'),optedOut:count('optedOut'),verifiedPaidEntries:items.reduce((n,x)=>n+(Number.isSafeInteger(x?.verifiedPaidEntries)&&x.verifiedPaidEntries>0?x.verifiedPaidEntries:0),0)};
}
module.exports={nextFollowup,campaignMetrics};
