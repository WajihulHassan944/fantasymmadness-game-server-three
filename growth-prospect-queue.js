'use strict';
function buildQueue(prospects,{campaignId,mode}={}){
 if(mode!=='DRAFT_ONLY')throw Error('draft_only_required');
 if(!campaignId||!Array.isArray(prospects))throw Error('invalid_input');
 const seen=new Set(),out=[];
 for(const p of prospects){
  if(!p||p.optedOut||typeof p.contact!=='string'||!p.contact.toLowerCase().endsWith('.invalid'))continue;
  const key=p.contact.trim().toLowerCase();
  if(seen.has(key))continue;
  seen.add(key);
  out.push({campaignId,id:p.id,category:p.category,contact:key,status:'draft',approved:false,sent:false});
 }
 return out;
}
module.exports={buildQueue};
