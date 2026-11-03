'use strict';
// Console sign-in primitives (no database, no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, createLoginLimiter, DEPARTMENTS } = require('./growth-backoffice');

test('password hash verifies only the right password and never stores it', () => {
  const stored = hashPassword('owner-password-123');
  assert.match(stored, /^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.ok(!stored.includes('owner-password-123'));
  assert.equal(verifyPassword('owner-password-123', stored), true);
  assert.equal(verifyPassword('owner-password-124', stored), false);
  assert.equal(verifyPassword('', stored), false);
  assert.equal(verifyPassword('owner-password-123', ''), false);
  assert.equal(verifyPassword('owner-password-123', 'plaintext'), false);
  assert.notEqual(hashPassword('same'), hashPassword('same'), 'salted');
});

test('sign-in limiter blocks after the limit and recovers after the window', () => {
  let now = 0;
  const l = createLoginLimiter({ max: 3, windowMs: 1000, clock: () => now });
  assert.ok(l.allow('ip') && l.allow('ip') && l.allow('ip'));
  assert.equal(l.allow('ip'), false);
  assert.equal(l.allow('other'), true);
  now = 1001; assert.equal(l.allow('ip'), true);
  l.reset('ip'); assert.equal(l.allow('ip'), true);
});

test('five departments per sport', () => {
  assert.deepEqual([...DEPARTMENTS], ['audience', 'marketing', 'public-relations', 'affiliate-recruitment', 'performance']);
});
