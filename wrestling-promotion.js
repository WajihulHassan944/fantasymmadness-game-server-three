'use strict';

function wrestlingPromotionFight(match) {
  if (!match) return null;
  return {
    _id: match._id, gameMode: 'PRO_WRESTLING', sourceType: 'PRO_WRESTLING',
    matchName: match.eventName, matchTitle: match.matchTitle,
    matchFighterA: match.competitorA?.displayName || '', matchFighterB: match.competitorB?.displayName || '',
    fighterAImage: match.competitorA?.image || '', fighterBImage: match.competitorB?.image || '',
    matchCategory: 'Pro Wrestling', matchCategoryTwo: 'Pro Wrestling',
    matchStatus: match.status, status: match.status, publicVisible: match.publicVisible,
    matchDate: match.matchDate, matchDateKey: match.eventDate || '', eventDate: match.eventDate || '',
    matchTime: match.matchTime, timeTba: Boolean(match.timeTba), lockAt: match.lockAt,
    matchTokens: match.entryFeeTokens || 0, pot: match.currentPot ?? match.basePot ?? 0,
    fightPosterImage: match.fightPosterImage || match.bannerImage || '', promotionBackground: match.bannerImage || '',
    matchDescription: match.description || '',
  };
}

function isWrestlingPromotionOpen(fight, now = new Date()) {
  return fight?.status === 'OPEN' && fight.publicVisible !== false && (!fight.lockAt || new Date(fight.lockAt) > now);
}
module.exports = { wrestlingPromotionFight, isWrestlingPromotionOpen };
