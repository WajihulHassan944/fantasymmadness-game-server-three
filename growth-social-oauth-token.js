'use strict';
// Preview-only administrator sessions. A distinct key label, issuer and audience
// prevent production Growth or website tokens from authenticating to this Preview.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const CONSOLE_AUDIENCE = 'fmm-growth-social-oauth-preview';
const CONSOLE_ISSUER = 'fmm-growth-social-oauth-preview';
const CONSOLE_ROLE = 'growth_owner';

const consoleKey = (adminJwtSecret) => {
  const secret = String(adminJwtSecret || '');
  if (!secret) throw new Error('JWT_SECRET_ADMIN is not configured');
  return crypto.createHmac('sha256', secret).update('fmm-growth-social-oauth-preview-token/v1').digest();
};

// Short-lived, revocable administrator console session.
const signConsoleToken = (adminJwtSecret, { email = 'owner@growth-console', pwv, adminId, sid, iatMs, method = 'console_password' }, { expiresIn = '12h' } = {}) =>
  jwt.sign({ email, role: CONSOLE_ROLE, pwv, scope: 'growth', method, ...(adminId ? { adminId } : {}), ...(sid ? { sid } : {}), ...(iatMs ? { iatMs } : {}) }, consoleKey(adminJwtSecret), { algorithm: 'HS256', expiresIn, audience: CONSOLE_AUDIENCE, issuer: CONSOLE_ISSUER });

// Fingerprint of the current console password hash: rotating the password ends every session.
const consolePasswordVersion = (passwordHash) => crypto.createHash('sha256').update(String(passwordHash || '')).digest('hex').slice(0, 16);

// Throws on any invalid token; returns the payload otherwise.
const verifyConsoleToken = (adminJwtSecret, token) => {
  const payload = jwt.verify(String(token || ''), consoleKey(adminJwtSecret), { algorithms: ['HS256'], audience: CONSOLE_AUDIENCE, issuer: CONSOLE_ISSUER });
  if (payload?.role !== CONSOLE_ROLE) throw new Error('not a console token');
  return payload;
};

module.exports = { signConsoleToken, verifyConsoleToken, consolePasswordVersion, CONSOLE_AUDIENCE, CONSOLE_ISSUER, CONSOLE_ROLE };
