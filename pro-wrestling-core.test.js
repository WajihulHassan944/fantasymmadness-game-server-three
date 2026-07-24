'use strict';

const assert = require('assert');
const {
  DEFAULT_WRESTLING_SCORING_RULE,
  calculateProWrestlingScore,
  getWrestlingTimeRangeBySeconds,
  normalizeWrestlingTimeRange,
  rankWrestlingPredictions,
  calculatePayoutDistribution,
  canTransitionWrestlingStatus,
  isWrestlingPredictionLocked,
  validateWrestlingPredictionPayload,
} = require('./pro-wrestling-core');

const exactPrediction = {
  competitorA: { HP: 10, BP: 8, K: 5, PM: 3, FM: 1 },
  competitorB: { HP: 7, BP: 6, K: 4, PM: 2, FM: 1 },
  winnerPrediction: 'A',
};
const actualResult = {
  competitorA: { HP: 10, BP: 8, K: 5, PM: 3, FM: 1 },
  competitorB: { HP: 7, BP: 6, K: 4, PM: 2, FM: 1 },
  officialWinner: 'A',
};

const exactScore = calculateProWrestlingScore(exactPrediction, actualResult, DEFAULT_WRESTLING_SCORING_RULE);
assert.strictEqual(exactScore.exactPredictionCount, 10);
assert.strictEqual(exactScore.winnerBonus, 1000);
assert.strictEqual(exactScore.totalScore, 2340);
assert.strictEqual(exactScore.normalizedError, 0);


assert.strictEqual(getWrestlingTimeRangeBySeconds(299).key, 'UNDER_5');
assert.strictEqual(getWrestlingTimeRangeBySeconds(300).key, '5_TO_9_59');
assert.strictEqual(getWrestlingTimeRangeBySeconds(899).key, '10_TO_14_59');
assert.strictEqual(getWrestlingTimeRangeBySeconds(900).key, '15_TO_19_59');
assert.strictEqual(getWrestlingTimeRangeBySeconds(1800).key, '30_PLUS');
assert.strictEqual(normalizeWrestlingTimeRange('10_to_14_59'), '10_TO_14_59');

const outcomePrediction = {
  ...exactPrediction,
  finishTypePrediction: 'PINFALL',
  matchTimeRangePrediction: '10_TO_14_59',
};
const outcomeResult = {
  ...actualResult,
  finishType: 'PINFALL',
  officialMatchTimeRange: '10_TO_14_59',
};
const outcomeScore = calculateProWrestlingScore(outcomePrediction, outcomeResult, DEFAULT_WRESTLING_SCORING_RULE);
assert.strictEqual(outcomeScore.finishTypeBonus, 250);
assert.strictEqual(outcomeScore.timeRangeBonus, 250);
assert.strictEqual(outcomeScore.totalScore, exactScore.totalScore + 500);
assert.strictEqual(outcomeScore.finishTypeCorrect, true);
assert.strictEqual(outcomeScore.timeRangeCorrect, true);

const zeroActual = calculateProWrestlingScore({
  competitorA: { HP: 0, BP: 0, K: 0, PM: 0, FM: 0 },
  competitorB: { HP: 2, BP: 0, K: 0, PM: 0, FM: 0 },
  winnerPrediction: 'B',
}, {
  competitorA: { HP: 0, BP: 0, K: 0, PM: 0, FM: 0 },
  competitorB: { HP: 0, BP: 0, K: 0, PM: 0, FM: 0 },
  officialWinner: 'B',
});
assert(Number.isFinite(zeroActual.totalScore));
assert.strictEqual(zeroActual.competitorB.categories.HP.tier, 'OUTSIDE_50_PERCENT');

const ranked = rankWrestlingPredictions([
  { id: 'late', totalScore: 100, normalizedError: 1, exactPredictionCount: 2, finisherError: 1, submittedAt: '2026-01-02T00:00:00Z' },
  { id: 'best-error', totalScore: 100, normalizedError: 0.5, exactPredictionCount: 1, finisherError: 2, submittedAt: '2026-01-03T00:00:00Z' },
  { id: 'highest', totalScore: 200, normalizedError: 5, exactPredictionCount: 0, finisherError: 4, submittedAt: '2026-01-04T00:00:00Z' },
]);
assert.deepStrictEqual(ranked.map((item) => item.id), ['highest', 'best-error', 'late']);
assert.deepStrictEqual(ranked.map((item) => item.rank), [1, 2, 3]);

const payout = calculatePayoutDistribution(1000, 100, { topPercentage: 10, minimumWinners: 3 });
assert.strictEqual(payout.winnerCount, 10);
assert.strictEqual(payout.payouts.reduce((sum, item) => sum + item.amount, 0), 1000);
assert.strictEqual(payout.payouts[0].rank, 1);
assert(payout.payouts[0].amount > payout.payouts[1].amount);

assert.strictEqual(canTransitionWrestlingStatus('DRAFT', 'OPEN'), true);
assert.strictEqual(canTransitionWrestlingStatus('FINALIZED', 'OPEN'), false);
assert.strictEqual(isWrestlingPredictionLocked({ status: 'OPEN', lockAt: '2020-01-01T00:00:00Z' }), true);
assert.strictEqual(isWrestlingPredictionLocked({ status: 'OPEN', lockAt: '2999-01-01T00:00:00Z' }), false);

assert.deepStrictEqual(validateWrestlingPredictionPayload(exactPrediction, { requireOutcomeFields: false }), []);
assert.deepStrictEqual(validateWrestlingPredictionPayload(outcomePrediction, { requireOutcomeFields: true }), []);
assert(validateWrestlingPredictionPayload(exactPrediction, { requireOutcomeFields: true }).length >= 2);
assert(validateWrestlingPredictionPayload({ competitorA: {}, competitorB: {}, winnerPrediction: 'X' }).length > 0);

console.log('Pro Wrestling core tests passed.');
