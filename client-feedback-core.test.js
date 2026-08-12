'use strict';

const assert = require('assert');
const {
  extractCalendarDateKey,
  normalizeCalendarDateInput,
  resolveCoinCart,
  timingSafeSignatureMatch,
} = require('./client-feedback-core');
const crypto = require('crypto');

assert.strictEqual(extractCalendarDateKey('2026-08-15'), '2026-08-15');
assert.strictEqual(extractCalendarDateKey('2026-08-15T00:00:00.000Z'), '2026-08-15');
const normalizedDate = normalizeCalendarDateInput('2026-08-15');
assert.strictEqual(normalizedDate.key, '2026-08-15');
assert.strictEqual(normalizedDate.date.toISOString(), '2026-08-15T12:00:00.000Z');

const cart = resolveCoinCart([
  { sku: 'fm-1000', quantity: 2, priceCents: 1, coins: 999999 },
  { sku: 'fm-15000', quantity: 1 },
]);
assert.strictEqual(cart.baseCoins, 17000);
assert.strictEqual(cart.subtotalCents, 1197);

assert.throws(() => resolveCoinCart([{ sku: 'not-a-product', quantity: 1 }]), /Unknown FM coin pack/);

const rawBody = JSON.stringify({ type: 'payment.completed', reference: 'FMM-COIN-1' });
const secret = 'test-secret';
const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
assert.strictEqual(timingSafeSignatureMatch(rawBody, signature, secret), true);
assert.strictEqual(timingSafeSignatureMatch(rawBody, 'invalid', secret), false);

console.log('Client feedback core tests passed.');
