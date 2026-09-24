'use strict';

// Existing affiliate split applies to platform proceeds attributable to a
// promoter's paid entries. Prize money stays reserved for players.
function ownerReferralShare({ platformCut, referredFees, collectedFees, splitPct }) {
  const proceeds = Math.max(0, Math.floor(Number(platformCut) || 0));
  const fees = Math.max(0, Number(referredFees) || 0);
  const total = Math.max(0, Number(collectedFees) || 0);
  const pct = Math.min(100, Math.max(0, Number(splitPct) || 0));
  if (!total || !fees || !proceeds) return 0;
  return Math.floor((proceeds * pct * Math.min(fees, total)) / (100 * total));
}
module.exports = { ownerReferralShare };
