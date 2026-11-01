'use strict';
// Persistent at-most-once attempt claims for synthetic sandbox messages.
// Claims are created before SMTP invocation. A failed attempt is not retried
// automatically, since SMTP may have accepted it before returning an error.
function createSandboxDeliveryClaims(collection,{testMode=false}={}){
 if(testMode!==true||!collection||typeof collection.updateOne!=='function'||typeof collection.createIndex!=='function')throw Error('Isolated claims collection required');
 return {
  async init(){await collection.createIndex({draftId:1},{unique:true});},
  async claim(draftId){
   if(typeof draftId!=='string'||!/^[-\w]{1,120}$/.test(draftId))throw Error('Invalid draft ID');
   const result=await collection.updateOne({draftId},{$setOnInsert:{draftId,status:'attempted',mode:'sandbox_only',createdAt:new Date().toISOString()}},{upsert:true});
   return result?.upsertedCount===1;
  },
  async record(draftId,receipt){
   if(!receipt?.sandbox||receipt?.realDelivery!==false||typeof receipt?.providerMessageId!=='string'||!receipt.providerMessageId.trim())throw Error('Verified sandbox receipt required');
   await collection.updateOne({draftId,status:'attempted'},{$set:{status:'sandbox_delivered',providerMessageId:receipt.providerMessageId.trim()}},{upsert:false});
  }
 };
}
module.exports={createSandboxDeliveryClaims};
