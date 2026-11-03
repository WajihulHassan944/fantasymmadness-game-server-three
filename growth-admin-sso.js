'use strict';
// Website administrator -> Growth Engine single sign-on (server side).
//
// The FANTASY MMADNESS website's administrator login issues an admin token (HS256, signed by the
// live backend with JWT_SECRET_ADMIN, {id, email}, 12 h). The browser hands that token to
// POST /api/growth/admin/sso once; this module decides, ON THE SERVER, whether it is a live
// administrator session, and if so issues a short-lived, Growth-Engine-only session.
//
// Verification (all required, fail closed):
//   1. well-formed HS256 JWT, not expired, issued at most 12 h ago, with an admin id and email;
//   2. the live backend itself accepts the token right now: a read-only request to an admin-only
//      route (GET /api/admin/matches/<all-zero id>) must pass its admin check (404 "not found"),
//      not 401. This is the issuer's own verification, so a forged, expired, rotated or
//      otherwise rejected token never works, and nothing on the live backend is changed;
//   3. if the Growth Engine holds the same admin signing secret, the signature is also checked
//      locally (defence in depth; recorded as "signature_verified_locally");
//   4. optional allow-list (GROWTH_SSO_ALLOWED_ADMINS: emails or admin ids).
// The website token is never stored or logged; only a short fingerprint is audited.
// Issued session: a Growth Engine console token (dedicated key + audience: useless on the live
// API), scope "growth", lifetime min(30 min, the website session's remaining time).
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const PROBE_PATH = '/api/admin/matches/000000000000000000000000';
const MAX_TOKEN_AGE_S = 12 * 3600 + 300;
const SESSION_S = 30 * 60;
const clean = (s, n = 200) => String(s ?? '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, n);
const fingerprint = (t) => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 12);

function resolveSsoConfig(env = {}, { defaultVerifyBase } = {}) {
  const errors = [];
  let verifyBase = String(env.GROWTH_SSO_VERIFY_URL || defaultVerifyBase || '').replace(/\/+$/, '');
  try {
    const u = new URL(verifyBase);
    const okHost = /^fantasymmadness-game-server-three[a-z0-9-]*\.vercel\.app$/.test(u.hostname) || /(^|\.)fantasymmadness\.com$/.test(u.hostname)
      || (env.GROWTH_SSO_ALLOW_LOOPBACK === 'true' && /^(127\.0\.0\.1|localhost)$/.test(u.hostname));
    if (!(u.protocol === 'https:' || (env.GROWTH_SSO_ALLOW_LOOPBACK === 'true' && u.protocol === 'http:')) || !okHost) errors.push('GROWTH_SSO_VERIFY_URL must be the live FANTASY MMADNESS backend (https)');
    verifyBase = u.origin;
  } catch { errors.push('GROWTH_SSO_VERIFY_URL is not a valid address'); }
  const allow = String(env.GROWTH_SSO_ALLOWED_ADMINS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return { enabled: env.GROWTH_SSO !== 'off' && errors.length === 0, verifyBase, allow, errors };
}

function createAdminSso({ config, adminJwtSecret, fetchImpl = globalThis.fetch, signSession, audit = async () => {} }) {
  const hits = new Map(); // ip -> [timestamps]   (per instance; basic brute-force brake)
  const limited = (ip) => {
    const now = Date.now(); const list = (hits.get(ip) || []).filter((t) => t > now - 60000); list.push(now); hits.set(ip, list);
    if (hits.size > 5000) hits.clear();
    return list.length > 20;
  };
  async function exchange(websiteToken, { ip = 'unknown', now = new Date() } = {}) {
    const fail = async (status, reason, extra = {}) => { await audit('sso_denied', { reason, ip: clean(ip, 64), fp: websiteToken ? fingerprint(websiteToken) : null, ...extra }); return { ok: false, status, reason }; };
    if (!config.enabled) return fail(503, 'sso_not_configured');
    if (limited(ip)) return fail(429, 'too_many_attempts');
    const token = String(websiteToken || '');
    if (!token || token.length > 4096 || token.split('.').length !== 3) return fail(401, 'website_admin_session_required');
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || decoded.header?.alg !== 'HS256' || typeof decoded.payload !== 'object') return fail(401, 'not_a_website_admin_session');
    const p = decoded.payload; const nowS = Math.floor(now.getTime() / 1000);
    if (p.aud || p.role || p.scope) return fail(401, 'not_a_website_admin_session'); // console / player / preview tokens carry these
    if (!/^[a-f0-9]{24}$/i.test(String(p.id || '')) || !/^[^@\s]+@[^@\s]+$/.test(String(p.email || ''))) return fail(401, 'not_a_website_admin_session');
    if (!Number.isInteger(p.exp) || p.exp <= nowS + 30) return fail(401, 'website_admin_session_expired');
    if (!Number.isInteger(p.iat) || p.iat > nowS + 60 || nowS - p.iat > MAX_TOKEN_AGE_S) return fail(401, 'website_admin_session_too_old');
    // 2. the issuer must accept it now
    let probe;
    try { probe = await fetchImpl(`${config.verifyBase}${PROBE_PATH}`, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined }); }
    catch (e) { return fail(503, 'website_unreachable_try_again'); }
    if (probe.status === 401 || probe.status === 403) return fail(401, 'website_rejected_this_admin_session');
    if (probe.status !== 404) return fail(503, `website_verification_unexpected_${probe.status}`);
    // 3. local signature (only meaningful when the same secret is configured here)
    let signatureVerifiedLocally = false;
    try { jwt.verify(token, adminJwtSecret, { algorithms: ['HS256'] }); signatureVerifiedLocally = true; } catch { /* different secret here: rely on the issuer's check */ }
    // 4. allow-list
    const email = clean(p.email, 200).toLowerCase(); const adminId = String(p.id).toLowerCase();
    if (config.allow.length && !config.allow.includes(email) && !config.allow.includes(adminId)) return fail(403, 'admin_not_allowed_for_growth_engine', { email });
    const ttl = Math.max(60, Math.min(SESSION_S, p.exp - nowS));
    const session = signSession({ email, adminId, ttl });
    await audit('sso_login', { admin: email, adminId, ip: clean(ip, 64), fp: fingerprint(token), method: 'website_admin', signatureVerifiedLocally, issuerConfirmed: true, ttlSeconds: ttl });
    return { ok: true, token: session, expiresInSeconds: ttl, expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(), admin: { email }, verification: { issuerConfirmed: true, signatureVerifiedLocally } };
  }
  return { exchange };
}

module.exports = { resolveSsoConfig, createAdminSso, PROBE_PATH, SESSION_S };
