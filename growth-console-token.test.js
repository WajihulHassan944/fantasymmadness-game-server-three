'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { signConsoleToken, verifyConsoleToken, consolePasswordVersion } = require('./growth-console-token');

const SECRET = 'x'.repeat(48);
const pwv = consolePasswordVersion('scrypt$hash');

test('console token round-trips with the dedicated key', () => {
  const t = signConsoleToken(SECRET, { pwv });
  const p = verifyConsoleToken(SECRET, t);
  assert.equal(p.role, 'growth_owner');
  assert.equal(p.pwv, pwv);
  assert.equal(p.aud, 'fmm-growth-console');
});

test('a console token is NOT a valid live admin token (live verifies with the raw JWT_SECRET_ADMIN)', () => {
  const t = signConsoleToken(SECRET, { pwv });
  assert.throws(() => jwt.verify(t, SECRET));
});

test('a live-style admin token (raw JWT_SECRET_ADMIN) is refused by the console', () => {
  assert.throws(() => verifyConsoleToken(SECRET, jwt.sign({ email: 'admin@fmm', role: 'growth_owner', pwv }, SECRET)));
  assert.throws(() => verifyConsoleToken(SECRET, jwt.sign({ email: 'admin@fmm' }, SECRET)));
});

test('wrong audience, wrong role, alg=none and other secrets are refused', () => {
  const crypto = require('crypto');
  const key = crypto.createHmac('sha256', SECRET).update('fmm-growth-console-token/v1').digest();
  assert.throws(() => verifyConsoleToken(SECRET, jwt.sign({ role: 'growth_owner', pwv }, key, { audience: 'other', issuer: 'fmm-growth-engine' })));
  assert.throws(() => verifyConsoleToken(SECRET, jwt.sign({ role: 'admin', pwv }, key, { audience: 'fmm-growth-console', issuer: 'fmm-growth-engine' })));
  const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ role: 'growth_owner', pwv, aud: 'fmm-growth-console', iss: 'fmm-growth-engine' })).toString('base64url')}.`;
  assert.throws(() => verifyConsoleToken(SECRET, none));
  assert.throws(() => verifyConsoleToken('y'.repeat(48), signConsoleToken(SECRET, { pwv })));
});

test('password version changes when the password hash changes; missing secret fails closed', () => {
  assert.notEqual(consolePasswordVersion('a'), consolePasswordVersion('b'));
  assert.throws(() => signConsoleToken('', { pwv }));
});
