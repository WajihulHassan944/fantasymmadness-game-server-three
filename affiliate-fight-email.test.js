const assert = require('node:assert/strict');
const { affiliateFightEmail } = require('./affiliate-fight-email');

const fight = { matchFighterA: 'Fighter A', matchFighterB: 'Fighter B', matchCategory: 'Bare-knuckle', pot: 125313, matchTokens: 6266 };
const alice = affiliateFightEmail({ affiliate: { _id: 'aaa', firstName: '<Kelly>' }, fight, fightId: '123', appUrl: 'https://www.fantasymmadness.com' });
const bob = affiliateFightEmail({ affiliate: { _id: 'bbb', firstName: 'Bob' }, fight, fightId: '123', appUrl: 'https://www.fantasymmadness.com' });
assert.match(alice, /ref=aaa/);
assert.doesNotMatch(alice, /ref=bbb/);
assert.match(bob, /ref=bbb/);
assert.match(alice, /affiliateId=aaa/);
assert.match(alice, /125,313 FM COINS/);
assert.match(alice, /6,266 FM coins/);
assert.match(alice, /&lt;Kelly&gt;/);
assert.doesNotMatch(alice, /<Kelly>/);
