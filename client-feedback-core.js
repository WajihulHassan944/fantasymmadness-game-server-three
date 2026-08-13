'use strict';

const crypto = require('crypto');

const FM_COIN_PRODUCTS = Object.freeze({
  'fm-1000': Object.freeze({ sku: 'fm-1000', coins: 1000, priceCents: 99, label: '1,000 FM' }),
  'fm-5000': Object.freeze({ sku: 'fm-5000', coins: 5000, priceCents: 399, label: '5,000 FM' }),
  'fm-15000': Object.freeze({ sku: 'fm-15000', coins: 15000, priceCents: 999, label: '15,000 FM' }),
});

const FM_PLUS_PLANS = Object.freeze({
  monthly: Object.freeze({ id: 'monthly', label: 'FM+ Monthly', priceCents: 499, recurring: true, durationDays: 30, bonusCoins: 1000 }),
  pass: Object.freeze({ id: 'pass', label: 'FM+ 30-Day Pass', priceCents: 499, recurring: false, durationDays: 30, bonusCoins: 1000 }),
});

function resolveFmPlusPlan(value) {
  const key = String(value || '').trim().toLowerCase();
  const plan = FM_PLUS_PLANS[key];
  if (!plan) {
    const error = new Error('Choose either the FM+ monthly plan or 30-day pass.');
    error.status = 400;
    throw error;
  }
  return plan;
}

function derivePredictionPickSide(predictions = []) {
  if (!Array.isArray(predictions) || predictions.length === 0) return '';
  let fighterA = 0;
  let fighterB = 0;
  predictions.forEach((round) => {
    const left = Number(round?.rwPrediction1 || 0);
    const right = Number(round?.rwPrediction2 || 0);
    if (left > right) fighterA += 1;
    if (right > left) fighterB += 1;
  });
  if (fighterA === fighterB) return '';
  return fighterA > fighterB ? 'a' : 'b';
}

function buildScoutingPayload(fight = {}, scoreRows = []) {
  const fighterA = String(fight.matchFighterA || fight.fighterAName || '').trim();
  const fighterB = String(fight.matchFighterB || fight.fighterBName || '').trim();
  const sport = String(fight.matchCategoryTwo || fight.matchCategory || fight.sport || '').trim();
  const eventName = String(fight.matchName || fight.eventName || '').trim();
  const scheduledRounds = Number(fight.maxRounds || fight.scheduledRounds || 0) || null;
  const date = extractCalendarDateKey(fight.matchDateKey || fight.matchDate || fight.date) || null;
  const picks = (Array.isArray(scoreRows) ? scoreRows : [])
    .map((row) => derivePredictionPickSide(row?.predictions))
    .filter(Boolean);
  const aCount = picks.filter((side) => side === 'a').length;
  const bCount = picks.filter((side) => side === 'b').length;
  const pickCount = aCount + bCount;
  const aPct = pickCount ? Math.round((aCount / pickCount) * 100) : null;

  return {
    fight: { sport, eventName, scheduledRounds, date },
    fighters: [{ name: fighterA }, { name: fighterB }],
    pickCount,
    pickSplit: pickCount ? { fighterA: aPct, fighterB: 100 - aPct } : null,
  };
}

function buildTemplateScoutingReport(payload = {}) {
  const fighterA = String(payload?.fighters?.[0]?.name || '').trim();
  const fighterB = String(payload?.fighters?.[1]?.name || '').trim();
  const sport = String(payload?.fight?.sport || 'combat sports').trim();
  if (!fighterA || !fighterB) return null;

  const rounds = payload?.fight?.scheduledRounds;
  const eventName = payload?.fight?.eventName;
  const summaryParts = [`${fighterA} faces ${fighterB} in this ${sport} matchup`];
  if (eventName) summaryParts.push(`at ${eventName}`);
  if (rounds) summaryParts.push(`scheduled for ${rounds} rounds`);
  const summary = `${summaryParts.join(', ')}. Use the registered fight card and official updates as the source of truth.`;

  let pickSplitNote = '';
  let underdogAngle = '';
  if (payload.pickSplit && payload.pickCount > 0) {
    const aPct = Number(payload.pickSplit.fighterA);
    const bPct = Number(payload.pickSplit.fighterB);
    pickSplitNote = `${aPct}% of ${payload.pickCount} submitted cards lean ${fighterA}; ${bPct}% lean ${fighterB}.`;
    if (aPct !== bPct) {
      const underdog = aPct < bPct ? fighterA : fighterB;
      const underdogPct = Math.min(aPct, bPct);
      underdogAngle = `${underdog} is the community contrarian side at ${underdogPct}%.`;
    }
  }

  return {
    summary,
    pickSplitNote,
    underdogAngle,
    source: 'validated-template',
    payloadVersion: 1,
    generatedAt: new Date().toISOString(),
  };
}

function validateScoutingReportNumbers(report = {}, payload = {}) {
  const text = [report.summary, report.pickSplitNote, report.underdogAngle].filter(Boolean).join(' ');
  if (/\b(injur(?:y|ed)|betting odds?|arrest(?:ed)?)\b/i.test(text)) return false;
  const allowed = new Set();
  const collect = (value) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'number' && Number.isFinite(value)) allowed.add(String(value));
    else if (Array.isArray(value)) value.forEach(collect);
    else if (typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(payload);
  const numericTokens = text.match(/\d+(?:\.\d+)?/g) || [];
  return numericTokens.every((token) => allowed.has(String(Number(token))) || allowed.has(token));
}

function extractCalendarDateKey(value) {
  if (!value) return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return value.toISOString().slice(0, 10);
  }

  const raw = String(value).trim();
  const exact = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (exact) return exact[0];

  const isoPrefix = raw.match(/^(\d{4}-\d{2}-\d{2})[T\s]/);
  if (isoPrefix) return isoPrefix[1];

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function normalizeCalendarDateInput(value) {
  const key = extractCalendarDateKey(value);
  if (!key) return { key: '', date: null };

  // Noon UTC leaves a full 12-hour buffer on both sides of the date boundary.
  // Clients still use `key` as the display source of truth.
  const date = new Date(`${key}T12:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? { key: '', date: null } : { key, date };
}

function normalizeCoinQuantity(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 20);
}

function resolveCoinCart(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    const error = new Error('At least one FM coin pack is required.');
    error.status = 400;
    throw error;
  }

  const items = rawItems.map((rawItem) => {
    const sku = String(rawItem?.sku || '').trim().toLowerCase();
    const product = FM_COIN_PRODUCTS[sku];
    if (!product) {
      const error = new Error(`Unknown FM coin pack: ${sku || 'missing sku'}.`);
      error.status = 400;
      throw error;
    }
    const quantity = normalizeCoinQuantity(rawItem?.quantity);
    return {
      sku: product.sku,
      label: product.label,
      coins: product.coins,
      quantity,
      unitPriceCents: product.priceCents,
      lineCoins: product.coins * quantity,
      lineTotalCents: product.priceCents * quantity,
    };
  });

  return {
    items,
    baseCoins: items.reduce((sum, item) => sum + item.lineCoins, 0),
    subtotalCents: items.reduce((sum, item) => sum + item.lineTotalCents, 0),
  };
}

function timingSafeSignatureMatch(rawBody, receivedSignature, secret) {
  if (!rawBody || !receivedSignature || !secret) return false;
  const normalizedReceived = String(receivedSignature).trim().replace(/^sha256=/i, '');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const receivedBuffer = Buffer.from(normalizedReceived, 'utf8');
  return expectedBuffer.length === receivedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

module.exports = {
  FM_COIN_PRODUCTS,
  FM_PLUS_PLANS,
  buildScoutingPayload,
  buildTemplateScoutingReport,
  derivePredictionPickSide,
  extractCalendarDateKey,
  normalizeCalendarDateInput,
  normalizeCoinQuantity,
  resolveFmPlusPlan,
  resolveCoinCart,
  timingSafeSignatureMatch,
  validateScoutingReportNumbers,
};
