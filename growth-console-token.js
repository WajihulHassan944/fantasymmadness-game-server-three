'use strict';
// Growth Engine console sign-in tokens.
// They are signed with a key DERIVED from JWT_SECRET_ADMIN (HMAC with a fixed label) and
// carry a fixed audience/issuer. So even if this staging project shares its
// JWT_SECRET_ADMIN value with the live backend, a console token is never a valid live
// admin token, and a live admin token is never accepted by the console.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const CONSOLE_AUDIENCE = 'fmm-growth-console';
const CONSOLE_ISSUER = 'fmm-growth-engine';
const CONSOLE_ROLE = 'growth_owner';

const consoleKey = (adminJwtSecret) => {
  const secret = String(adminJwtSecret || '');
  if (!secret) throw new Error('JWT_SECRET_ADMIN is not configured');
  return crypto.createHmac('sha256', secret).update('fmm-growth-console-token/v1').digest();
};

const signConsoleToken = (adminJwtSecret, { email = 'owner@growth-console', pwv }, { expiresIn = '12h' } = {}) =>
  jwt.sign({ email, role: CONSOLE_ROLE, pwv }, consoleKey(adminJwtSecret), { algorithm: 'HS256', expiresIn, audience: CONSOLE_AUDIENCE, issuer: CONSOLE_ISSUER });

// Fingerprint of the current console password hash: rotating the password ends every session.
const consolePasswordVersion = (passwordHash) => crypto.createHash('sha256').update(String(passwordHash || '')).digest('hex').slice(0, 16);

// Throws on any invalid token; returns the payload otherwise.
const verifyConsoleToken = (adminJwtSecret, token) => {
  const payload = jwt.verify(String(token || ''), consoleKey(adminJwtSecret), { algorithms: ['HS256'], audience: CONSOLE_AUDIENCE, issuer: CONSOLE_ISSUER });
  if (payload?.role !== CONSOLE_ROLE) throw new Error('not a console token');
  return payload;
};

module.exports = { signConsoleToken, verifyConsoleToken, consolePasswordVersion, CONSOLE_AUDIENCE, CONSOLE_ISSUER, CONSOLE_ROLE };
