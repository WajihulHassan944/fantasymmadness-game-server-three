const assert = require('node:assert/strict');
const { assessPublishedFight, affiliateKitUrl } = require('./publish-integrity');

const fight = {
  matchFighterA: 'Wang Cong', matchFighterB: 'Natalia Silva',
  fighterAImage: 'https://example.com/wang.webp', fighterBImage: 'https://example.com/silva.webp',
  fighterAId: 'fighter-a', fighterBId: 'fighter-b',
};
assert.equal(assessPublishedFight(fight).ready, true);
assert.deepEqual(assessPublishedFight(null).problems, ['Fight was not found in the registry.']);
assert.deepEqual(assessPublishedFight({ ...fight, fighterBImage: '', fighterBId: null }).problems,
  ['Fighter B has no picture.', 'Fighter B is not in the fighter library.']);
assert.equal(affiliateKitUrl('507f1f77bcf86cd799439011'),
  'https://www.fantasymmadness.com/affiliate/fight-launch?fightId=507f1f77bcf86cd799439011');
assert.equal(affiliateKitUrl('missing'), '');
