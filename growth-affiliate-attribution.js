'use strict';
// Offline synthetic affiliate-to-paid-entry attribution. No emails, real payments, or production writes.
const { createHash } = require('node:crypto');
function slug(name) {
 const value=String(name||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
 if(!value) throw new Error('Affiliate name required');
 return value.slice(0,48).replace(/-$/,'');
}
function createRecruit({ id, name, consent, approved }) {
 if(!id || !name) throw new Error('Affiliate identity required');
 return { id:String(id),name:String(name),slug:slug(name),status:approved===true && consent===true?'approved':'pending',outreachSent:false };
}
function makeLink(affiliate, fightId) {
 if(affiliate?.status!=='approved' || !/^[a-zA-Z0-9_-]{1,80}$/.test(String(fightId))) throw new Error('Unapproved affiliate or invalid fight');
 return '/affiliate/'+encodeURIComponent(affiliate.slug)+'?fight='+encodeURIComponent(fightId);
}
function verifyPaidEntry(event, { affiliates, entries }) {
 if(!event || event.type!=='paid_entry' || event.verified!==true || event.paymentStatus!=='settled') return {credited:false,reason:'unverified_payment'};
 if(!event.entryId || !event.playerId || !event.fightId || !event.affiliateId) return {credited:false,reason:'missing_fields'};
 const affiliate=affiliates.get(String(event.affiliateId));
 if(!affiliate || affiliate.status!=='approved') return {credited:false,reason:'unapproved_affiliate'};
 if(entries.has(String(event.entryId))) return {credited:false,reason:'duplicate_entry'};
 if(event.referralAffiliateId!==event.affiliateId) return {credited:false,reason:'referral_mismatch'};
 const amount=Number(event.amountCents);
 if(!Number.isSafeInteger(amount) || amount<0) return {credited:false,reason:'invalid_amount'};
 const record={entryId:String(event.entryId),affiliateId:affiliate.id,playerId:String(event.playerId),fightId:String(event.fightId),amountCents:amount,source:'verified_test_event'};
 entries.set(record.entryId,record);
 return {credited:true,record};
}
function report(entries) {
 const totals=new Map();
 for(const entry of entries.values()){
  const row=totals.get(entry.affiliateId)||{paidEntries:0,revenueCents:0};
  row.paidEntries++;row.revenueCents+=entry.amountCents;totals.set(entry.affiliateId,row);
 }
 return Object.fromEntries(totals);
}
module.exports={slug,createRecruit,makeLink,verifyPaidEntry,report};
