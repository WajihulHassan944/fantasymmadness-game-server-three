'use strict';

const WRESTLING_STAT_KEYS = Object.freeze(['HP', 'BP', 'K', 'PM', 'FM']);
const WRESTLING_WINNER_VALUES = Object.freeze(['A', 'B', 'DRAW']);

const DEFAULT_WRESTLING_SCORING_RULE = Object.freeze({
  ruleId: 'WRESTLING_V1',
  name: 'Pro Wrestling V1',
  baseCategoryScore: 100,
  winnerBonus: 1000,
  multipliers: {
    exact: 1,
    within20Percent: 0.75,
    within50Percent: 0.4,
    outside50Percent: 0.1,
  },
  categories: {
    HP: { label: 'Head Punches', weight: 1 },
    BP: { label: 'Body Punches', weight: 1 },
    K: { label: 'Kicks', weight: 1.2 },
    PM: { label: 'Power Moves', weight: 1.5 },
    FM: { label: 'Finishers', weight: 2 },
  },
});

const DEFAULT_WRESTLING_PAYOUT_RULE = Object.freeze({
  ruleId: 'WRESTLING_TOP_10_V1',
  name: 'Top 10 Percent V1',
  topPercentage: 10,
  minimumWinners: 3,
  platformFeePercentage: 0,
  firstPlacePercentage: 40,
  secondPlacePercentage: 25,
  thirdPlacePercentage: 15,
  remainingWinnersPercentage: 20,
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegativeInteger(value, fallback = 0) {
  return Math.max(0, Math.round(finiteNumber(value, fallback)));
}

function roundScore(value) {
  return Math.round((finiteNumber(value, 0) + Number.EPSILON) * 100) / 100;
}

function normalizeWrestlingStats(value) {
  const source = value && typeof value === 'object' ? value : {};
  return WRESTLING_STAT_KEYS.reduce((stats, key) => {
    const candidate = source[key] !== undefined ? source[key] : source[key.toLowerCase()];
    stats[key] = nonNegativeInteger(candidate, 0);
    return stats;
  }, {});
}

function normalizeScoringRule(rule) {
  const incoming = rule && typeof rule === 'object' ? rule : {};
  const base = clone(DEFAULT_WRESTLING_SCORING_RULE);
  const categories = incoming.categories && typeof incoming.categories === 'object'
    ? incoming.categories
    : {};
  const multipliers = incoming.multipliers && typeof incoming.multipliers === 'object'
    ? incoming.multipliers
    : {};

  base.ruleId = String(incoming.ruleId || base.ruleId);
  base.name = String(incoming.name || base.name);
  base.baseCategoryScore = Math.max(0, finiteNumber(incoming.baseCategoryScore, base.baseCategoryScore));
  base.winnerBonus = Math.max(0, finiteNumber(incoming.winnerBonus, base.winnerBonus));
  base.multipliers = {
    exact: Math.max(0, finiteNumber(multipliers.exact, base.multipliers.exact)),
    within20Percent: Math.max(0, finiteNumber(multipliers.within20Percent, base.multipliers.within20Percent)),
    within50Percent: Math.max(0, finiteNumber(multipliers.within50Percent, base.multipliers.within50Percent)),
    outside50Percent: Math.max(0, finiteNumber(multipliers.outside50Percent, base.multipliers.outside50Percent)),
  };

  WRESTLING_STAT_KEYS.forEach((key) => {
    const incomingCategory = categories[key] || {};
    base.categories[key] = {
      label: String(incomingCategory.label || base.categories[key].label),
      weight: Math.max(0, finiteNumber(incomingCategory.weight, base.categories[key].weight)),
    };
  });

  return base;
}

function normalizePayoutRule(rule) {
  const incoming = rule && typeof rule === 'object' ? rule : {};
  const base = clone(DEFAULT_WRESTLING_PAYOUT_RULE);
  base.ruleId = String(incoming.ruleId || base.ruleId);
  base.name = String(incoming.name || base.name);
  base.topPercentage = Math.min(100, Math.max(0, finiteNumber(incoming.topPercentage, base.topPercentage)));
  base.minimumWinners = Math.max(1, nonNegativeInteger(incoming.minimumWinners, base.minimumWinners));
  base.platformFeePercentage = Math.min(100, Math.max(0, finiteNumber(incoming.platformFeePercentage, base.platformFeePercentage)));
  base.firstPlacePercentage = Math.max(0, finiteNumber(incoming.firstPlacePercentage, base.firstPlacePercentage));
  base.secondPlacePercentage = Math.max(0, finiteNumber(incoming.secondPlacePercentage, base.secondPlacePercentage));
  base.thirdPlacePercentage = Math.max(0, finiteNumber(incoming.thirdPlacePercentage, base.thirdPlacePercentage));
  base.remainingWinnersPercentage = Math.max(0, finiteNumber(incoming.remainingWinnersPercentage, base.remainingWinnersPercentage));
  return base;
}

function categoryAccuracy(predictedValue, actualValue, scoringRule) {
  const predicted = nonNegativeInteger(predictedValue, 0);
  const actual = nonNegativeInteger(actualValue, 0);
  const difference = Math.abs(predicted - actual);
  const normalizedError = actual === 0 ? (difference === 0 ? 0 : difference) : difference / actual;
  const multipliers = scoringRule.multipliers;

  if (difference === 0) {
    return { multiplier: multipliers.exact, tier: 'EXACT', difference, normalizedError };
  }
  if (actual > 0 && normalizedError <= 0.2) {
    return { multiplier: multipliers.within20Percent, tier: 'WITHIN_20_PERCENT', difference, normalizedError };
  }
  if (actual > 0 && normalizedError <= 0.5) {
    return { multiplier: multipliers.within50Percent, tier: 'WITHIN_50_PERCENT', difference, normalizedError };
  }
  return { multiplier: multipliers.outside50Percent, tier: 'OUTSIDE_50_PERCENT', difference, normalizedError };
}

function scoreCompetitor(prediction, actual, scoringRule) {
  const normalizedPrediction = normalizeWrestlingStats(prediction);
  const normalizedActual = normalizeWrestlingStats(actual);
  let score = 0;
  let normalizedError = 0;
  let exactPredictionCount = 0;
  const categories = {};

  WRESTLING_STAT_KEYS.forEach((key) => {
    const categoryRule = scoringRule.categories[key];
    const accuracy = categoryAccuracy(normalizedPrediction[key], normalizedActual[key], scoringRule);
    const categoryScore = roundScore(scoringRule.baseCategoryScore * categoryRule.weight * accuracy.multiplier);
    if (accuracy.tier === 'EXACT') exactPredictionCount += 1;
    score += categoryScore;
    normalizedError += accuracy.normalizedError;
    categories[key] = {
      code: key,
      label: categoryRule.label,
      predicted: normalizedPrediction[key],
      actual: normalizedActual[key],
      difference: accuracy.difference,
      normalizedError: roundScore(accuracy.normalizedError),
      tier: accuracy.tier,
      multiplier: accuracy.multiplier,
      weight: categoryRule.weight,
      points: categoryScore,
    };
  });

  return {
    score: roundScore(score),
    normalizedError: roundScore(normalizedError),
    exactPredictionCount,
    finisherError: Math.abs(normalizedPrediction.FM - normalizedActual.FM),
    categories,
  };
}

function calculateProWrestlingScore(prediction, actualResult, rule) {
  const scoringRule = normalizeScoringRule(rule);
  const actual = actualResult && typeof actualResult === 'object' ? actualResult : {};
  const sideA = scoreCompetitor(prediction && prediction.competitorA, actual.competitorA, scoringRule);
  const sideB = scoreCompetitor(prediction && prediction.competitorB, actual.competitorB, scoringRule);
  const predictedWinner = String((prediction && prediction.winnerPrediction) || '').toUpperCase();
  const officialWinner = String(actual.officialWinner || '').toUpperCase();
  const winnerCorrect = Boolean(officialWinner && WRESTLING_WINNER_VALUES.includes(officialWinner) && predictedWinner === officialWinner);
  const winnerBonus = winnerCorrect ? scoringRule.winnerBonus : 0;
  const totalScore = roundScore(sideA.score + sideB.score + winnerBonus);

  return {
    totalScore,
    normalizedError: roundScore(sideA.normalizedError + sideB.normalizedError),
    exactPredictionCount: sideA.exactPredictionCount + sideB.exactPredictionCount,
    finisherError: sideA.finisherError + sideB.finisherError,
    winnerBonus,
    winnerCorrect,
    predictedWinner: predictedWinner || null,
    officialWinner: officialWinner || null,
    competitorA: sideA,
    competitorB: sideB,
    scoringRuleVersion: scoringRule.ruleId,
  };
}

function rankWrestlingPredictions(items) {
  const sorted = (Array.isArray(items) ? items : []).slice().sort((left, right) => {
    const scoreDifference = finiteNumber(right.totalScore) - finiteNumber(left.totalScore);
    if (scoreDifference !== 0) return scoreDifference;

    const errorDifference = finiteNumber(left.normalizedError, Number.MAX_SAFE_INTEGER)
      - finiteNumber(right.normalizedError, Number.MAX_SAFE_INTEGER);
    if (errorDifference !== 0) return errorDifference;

    const exactDifference = finiteNumber(right.exactPredictionCount) - finiteNumber(left.exactPredictionCount);
    if (exactDifference !== 0) return exactDifference;

    const finisherDifference = finiteNumber(left.finisherError, Number.MAX_SAFE_INTEGER)
      - finiteNumber(right.finisherError, Number.MAX_SAFE_INTEGER);
    if (finisherDifference !== 0) return finisherDifference;

    const leftTime = new Date(left.submittedAt || 0).getTime();
    const rightTime = new Date(right.submittedAt || 0).getTime();
    if (leftTime !== rightTime) return leftTime - rightTime;

    return String(left.id || left._id || '').localeCompare(String(right.id || right._id || ''));
  });

  return sorted.map((item, index) => ({ ...item, rank: index + 1 }));
}

function determineWinnerCount(participantCount, payoutRule) {
  const participants = Math.max(0, nonNegativeInteger(participantCount, 0));
  if (!participants) return 0;
  const rule = normalizePayoutRule(payoutRule);
  const percentageWinnerCount = Math.ceil(participants * (rule.topPercentage / 100));
  return Math.min(participants, Math.max(rule.minimumWinners, percentageWinnerCount));
}

function percentageSchedule(winnerCount, payoutRule) {
  const rule = normalizePayoutRule(payoutRule);
  if (winnerCount <= 0) return [];
  if (winnerCount === 1) return [100];
  if (winnerCount === 2) return [60, 40];
  if (winnerCount === 3) return [50, 30, 20];

  const schedule = [rule.firstPlacePercentage, rule.secondPlacePercentage, rule.thirdPlacePercentage];
  const remainingSlots = winnerCount - 3;
  const remainingEach = remainingSlots > 0 ? rule.remainingWinnersPercentage / remainingSlots : 0;
  for (let index = 0; index < remainingSlots; index += 1) schedule.push(remainingEach);

  const total = schedule.reduce((sum, percentage) => sum + percentage, 0);
  if (total <= 0) return new Array(winnerCount).fill(100 / winnerCount);
  return schedule.map((percentage) => (percentage / total) * 100);
}

function calculatePayoutDistribution(totalPot, participantCount, payoutRule) {
  const rule = normalizePayoutRule(payoutRule);
  const grossPot = Math.max(0, nonNegativeInteger(totalPot, 0));
  const platformFeeTokens = Math.floor(grossPot * (rule.platformFeePercentage / 100));
  const distributablePot = Math.max(0, grossPot - platformFeeTokens);
  const winnerCount = determineWinnerCount(participantCount, rule);
  const percentages = percentageSchedule(winnerCount, rule);

  const payouts = percentages.map((percentage, index) => ({
    rank: index + 1,
    percentage: roundScore(percentage),
    amount: Math.floor(distributablePot * (percentage / 100)),
  }));

  const allocated = payouts.reduce((sum, payout) => sum + payout.amount, 0);
  const remainder = distributablePot - allocated;
  if (payouts.length && remainder > 0) payouts[0].amount += remainder;

  return {
    grossPot,
    platformFeeTokens,
    distributablePot,
    winnerCount,
    payouts,
    payoutRuleVersion: rule.ruleId,
  };
}

const WRESTLING_STATUS_TRANSITIONS = Object.freeze({
  DRAFT: ['OPEN', 'CANCELLED'],
  OPEN: ['LOCKED', 'LIVE', 'CANCELLED', 'NO_CONTEST'],
  LOCKED: ['LIVE', 'SCORING', 'CANCELLED', 'NO_CONTEST'],
  LIVE: ['SCORING', 'CANCELLED', 'NO_CONTEST'],
  SCORING: ['LIVE', 'FINALIZED', 'CANCELLED', 'NO_CONTEST'],
  FINALIZED: [],
  CANCELLED: [],
  NO_CONTEST: [],
});

function canTransitionWrestlingStatus(fromStatus, toStatus) {
  const from = String(fromStatus || '').toUpperCase();
  const to = String(toStatus || '').toUpperCase();
  return Boolean(WRESTLING_STATUS_TRANSITIONS[from] && WRESTLING_STATUS_TRANSITIONS[from].includes(to));
}

function isWrestlingPredictionLocked(match, now = new Date()) {
  if (!match) return true;
  const status = String(match.status || '').toUpperCase();
  if (['LOCKED', 'LIVE', 'SCORING', 'FINALIZED', 'CANCELLED', 'NO_CONTEST'].includes(status)) return true;
  const lockAt = match.lockAt ? new Date(match.lockAt) : null;
  return Boolean(lockAt && !Number.isNaN(lockAt.getTime()) && lockAt.getTime() <= new Date(now).getTime());
}

function validateWrestlingPredictionPayload(payload) {
  const errors = [];
  const source = payload && typeof payload === 'object' ? payload : {};
  ['competitorA', 'competitorB'].forEach((side) => {
    const sideValue = source[side];
    if (!sideValue || typeof sideValue !== 'object') {
      errors.push(`${side} is required`);
      return;
    }
    WRESTLING_STAT_KEYS.forEach((key) => {
      const raw = sideValue[key] !== undefined ? sideValue[key] : sideValue[key.toLowerCase()];
      const number = Number(raw);
      if (!Number.isFinite(number) || number < 0 || !Number.isInteger(number)) {
        errors.push(`${side}.${key} must be a non-negative integer`);
      }
    });
  });

  const winner = String(source.winnerPrediction || '').toUpperCase();
  if (!WRESTLING_WINNER_VALUES.includes(winner)) {
    errors.push('winnerPrediction must be A, B, or DRAW');
  }

  return errors;
}

module.exports = {
  WRESTLING_STAT_KEYS,
  WRESTLING_WINNER_VALUES,
  DEFAULT_WRESTLING_SCORING_RULE,
  DEFAULT_WRESTLING_PAYOUT_RULE,
  normalizeWrestlingStats,
  normalizeScoringRule,
  normalizePayoutRule,
  calculateProWrestlingScore,
  rankWrestlingPredictions,
  determineWinnerCount,
  calculatePayoutDistribution,
  canTransitionWrestlingStatus,
  isWrestlingPredictionLocked,
  validateWrestlingPredictionPayload,
};
