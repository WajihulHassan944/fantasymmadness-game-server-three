'use strict';
// Read-only reconciliation contract: never treat public analytics events as payment evidence.
// An adapter must supply server-verified settled transaction and valid paid contest entry.
function reconcilePaidReferral({affiliate, referral, entry, payment, existingCredit}) {
 if(!affiliate || affiliate.status!=='approved')return {ok:false,reason:'affiliate_not_approved'};
 if(!referral || referral.affiliateId!==affiliate.id || !referral.playerId || !referral.fightId)return {ok:false,reason:'referral_invalid'};
 if(!entry || !entry.id || entry.playerId!==referral.playerId || entry.fightId!==referral.fightId || entry.status!=='accepted' || entry.paid!==true)return {ok:false,reason:'entry_not_valid'};
 if(!payment || payment.source!=='server_verified' || payment.status!=='settled' || !payment.transactionId || payment.entryId!==entry.id || payment.playerId!==entry.playerId)return {ok:false,reason:'payment_not_verified'};
 if(!Number.isSafeInteger(payment.amountCents) || payment.amountCents<=0)return {ok:false,reason:'payment_amount_invalid'};
 if(existingCredit)return {ok:false,reason:'already_credited'};
 return {ok:true,credit:{id:'paid-entry:'+entry.id,affiliateId:affiliate.id,entryId:entry.id,transactionId:payment.transactionId,amountCents:payment.amountCents}};
}
module.exports={reconcilePaidReferral};
