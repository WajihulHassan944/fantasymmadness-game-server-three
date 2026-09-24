'use strict';
const assert = require('node:assert/strict');
const { ownerReferralShare } = require('./owner-referral-share');

// Two affiliates split the same owner's 15 FM take according to the paid
// entries each brought. Neither can receive a share of the prize reserve.
const alice = ownerReferralShare({ platformCut: 15, referredFees: 30, collectedFees: 100, splitPct: 50 });
const bob = ownerReferralShare({ platformCut: 15, referredFees: 20, collectedFees: 100, splitPct: 50 });
assert.equal(alice, 2);
assert.equal(bob, 1);
assert.ok(alice + bob <= 7);
assert.equal(ownerReferralShare({ platformCut: 15, referredFees: 0, collectedFees: 100, splitPct: 50 }), 0);
assert.equal(ownerReferralShare({ platformCut: 15, referredFees: 30, collectedFees: 0, splitPct: 50 }), 0);
assert.equal(ownerReferralShare({ platformCut: 15, referredFees: 200, collectedFees: 100, splitPct: 50 }), 7);
