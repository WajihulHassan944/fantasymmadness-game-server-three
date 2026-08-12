'use strict';

const crypto = require('crypto');

const FM_COIN_PRODUCTS = Object.freeze({
  'fm-1000': Object.freeze({ sku: 'fm-1000', coins: 1000, priceCents: 99, label: '1,000 FM' }),
  'fm-5000': Object.freeze({ sku: 'fm-5000', coins: 5000, priceCents: 399, label: '5,000 FM' }),
  'fm-15000': Object.freeze({ sku: 'fm-15000', coins: 15000, priceCents: 999, label: '15,000 FM' }),
});

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
  extractCalendarDateKey,
  normalizeCalendarDateInput,
  normalizeCoinQuantity,
  resolveCoinCart,
  timingSafeSignatureMatch,
};
