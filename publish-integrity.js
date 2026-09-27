const isValidFightId = (value) => /^[a-f\d]{24}$/i.test(String(value || ''));

const assessPublishedFight = (fight) => {
  if (!fight) return { ready: false, problems: ['Fight was not found in the registry.'] };
  const problems = [];
  for (const side of ['A', 'B']) {
    if (!String(fight[`matchFighter${side}`] || '').trim()) problems.push(`Fighter ${side} has no name.`);
    if (!String(fight[`fighter${side}Image`] || '').trim()) problems.push(`Fighter ${side} has no picture.`);
    if (!fight[`fighter${side}Id`]) problems.push(`Fighter ${side} is not in the fighter library.`);
  }
  return { ready: problems.length === 0, problems };
};

const affiliateKitUrl = (fightId) => isValidFightId(fightId)
  ? `https://www.fantasymmadness.com/affiliate/fight-launch?fightId=${encodeURIComponent(String(fightId))}`
  : '';

module.exports = { assessPublishedFight, affiliateKitUrl, isValidFightId };
