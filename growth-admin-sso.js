'use strict';
// Website administrator -> Growth Engine sign-in: FIRST-PARTY SIGNED ASSERTION (server to server).
//
// The ordinary website administrator token never reaches this engine. Instead:
//   1. the admin's browser calls the WEBSITE's own same-origin endpoint (fmm-ver2
//      /api/admin/growth-session) with its usual admin session;
//   2. the website SERVER verifies that session with the live admin authority (the live backend)
//      and signs a one-time assertion with its Ed25519 private key (never shared with this engine);
//   3. the website server posts the assertion here (POST /api/growth/admin/sso/assertion,
//      server to server; browser requests are refused);
//   4. this engine verifies the signature with the website's PUBLIC key, the issuer, audience,
//      purpose, site origin, a <=120 s lifetime, and consumes the nonce (single use, stored with a
//      TTL so replays fail), applies the optional allow-list, and issues a short-lived
//      Growth-Engine-only session (scope "growth", own key + audience, <=30 min and never past
//      the website session) with a session id that can be revoked.
// Revocation: POST /admin/logout (the Growth session itself) revokes that session id;
// a signed "revoke" assertion from the website server (website logout) revokes every session of
// that administrator issued before now. Every check fails closed and is audited (no tokens logged).
const crypto = require('crypto');

const ISSUER = 'fmm-admin-site';
const AUDIENCE = 'fmm-growth-engine';
const TYP = 'fmm-admin-assertion+jwt';
const MAX_ASSERTION_S = 120;
const SESSION_S = 30 * 60;
const clean = (s, n = 200) => String(s ?? '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, n);
const b64u = (buf) => Buffer.from(buf).toString('base64url');

// Accepts a PEM, or base64 of a PEM, or base64 of the raw SPKI DER.
function parsePublicKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const tries = [];
  if (raw.includes('BEGIN')) tries.push(() => crypto.createPublicKey(raw.replace(/\\n/g, '\n')));
  tries.push(() => crypto.createPublicKey(Buffer.from(raw, 'base64').toString('utf8')));
  tries.push(() => crypto.createPublicKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'spki' }));
  for (const t of tries) { try { const k = t(); if (k.asymmetricKeyType === 'ed25519') return k; } catch { /* next */ } }
  return null;
}

function resolveSsoConfig(env = {}) {
  const errors = [];
  const off = env.GROWTH_SSO === 'off';
  const publicKey = parsePublicKey(env.GROWTH_SSO_SITE_PUBLIC_KEY);
  if (!off && env.GROWTH_SSO_SITE_PUBLIC_KEY && !publicKey) errors.push('GROWTH_SSO_SITE_PUBLIC_KEY is not an Ed25519 public key');
  const listed = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  const siteOrigins = [...new Set(listed(env.GROWTH_SSO_SITE_ORIGINS || env.GROWTH_CONSOLE_EMBED_ORIGINS).map((o) => { try { return new URL(o).origin; } catch { return null; } }).filter(Boolean))];
  if (!off && publicKey && !siteOrigins.length) errors.push('GROWTH_SSO_SITE_ORIGINS (or GROWTH_CONSOLE_EMBED_ORIGINS) must list the website origins');
  const allow = listed(env.GROWTH_SSO_ALLOWED_ADMINS).map((x) => x.toLowerCase());
  return { enabled: !off && Boolean(publicKey) && errors.length === 0, publicKey, siteOrigins, allow, errors, keyId: publicKey ? crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16) : null };
}

// Pure signature + claims check. Returns { ok, payload } or { ok:false, reason }.
function verifyAssertion(assertion, config, { now = new Date(), purpose = 'session' } = {}) {
  const parts = String(assertion || '').split('.');
  if (parts.length !== 3 || String(assertion).length > 4096) return { ok: false, reason: 'assertion_malformed' };
  let header; let payload;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'assertion_malformed' }; }
  if (!header || header.alg !== 'EdDSA' || header.typ !== TYP || (header.kid && header.kid !== config.keyId)) return { ok: false, reason: 'assertion_wrong_type' };
  let good = false;
  try { good = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), config.publicKey, Buffer.from(parts[2], 'base64url')); } catch { good = false; }
  if (!good) return { ok: false, reason: 'assertion_bad_signature' };
  const nowS = Math.floor(now.getTime() / 1000);
  if (!payload || payload.iss !== ISSUER || payload.aud !== AUDIENCE) return { ok: false, reason: 'assertion_wrong_audience' };
  if (payload.purpose !== purpose) return { ok: false, reason: 'assertion_wrong_purpose' };
  if (!config.siteOrigins.includes(payload.site)) return { ok: false, reason: 'assertion_unknown_site' };
  if (payload.verifiedBy !== 'live-admin-authority') return { ok: false, reason: 'assertion_not_verified' };
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(String(payload.jti || ''))) return { ok: false, reason: 'assertion_malformed' };
  if (!/^[a-f0-9]{24}$/i.test(String(payload.sub || '')) || !/^[^@\s]+@[^@\s]+$/.test(String(payload.email || ''))) return { ok: false, reason: 'assertion_malformed' };
  if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.exp - payload.iat > MAX_ASSERTION_S || payload.iat > nowS + 30) return { ok: false, reason: 'assertion_lifetime_invalid' };
  if (payload.exp <= nowS) return { ok: false, reason: 'assertion_expired' };
  if (purpose === 'session' && (!Number.isInteger(payload.adminExp) || payload.adminExp <= nowS + 30)) return { ok: false, reason: 'website_admin_session_expired' };
  return { ok: true, payload };
}

// collections: { nonces, revocations, audit } (Mongo collections). signSession({email, adminId, sid, iatMs, ttl}).
function createAdminSso({ config, collections, signSession, now: clock = () => new Date(), rateLimit = 30 }) {
  // rateLimit: assertions per calling address per minute (the website's servers)
  const hits = new Map();
  const limited = (ip) => {
    const t = Date.now(); const list = (hits.get(ip) || []).filter((x) => x > t - 60000); list.push(t); hits.set(ip, list);
    if (hits.size > 5000) hits.clear();
    return list.length > rateLimit;
  };
  const audit = async (action, details) => { try { await collections.audit.insertOne({ action, ...details, at: new Date().toISOString() }); } catch { /* best effort */ } };
  let indexed = null;
  const ensureIndexes = () => (indexed ||= Promise.all([
    collections.nonces.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    collections.revocations.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    collections.revocations.createIndex({ kind: 1, key: 1 }),
  ]).catch(() => { indexed = null; }));

  // single use: the nonce is stored until the assertion would have expired anyway
  async function consume(payload) {
    await ensureIndexes();
    try { await collections.nonces.insertOne({ _id: `${payload.purpose}:${payload.jti}`, adminId: String(payload.sub).toLowerCase(), expiresAt: new Date((payload.exp + 60) * 1000), at: new Date() }); return true; }
    catch (e) { if (e && e.code === 11000) return false; throw e; }
  }

  async function check(assertion, { ip, purpose }) {
    const fail = async (status, reason, extra = {}) => { await audit('sso_denied', { reason, purpose, ip: clean(ip, 64), ...extra }); return { ok: false, status, reason }; };
    if (!config.enabled) return fail(503, 'sso_not_configured');
    if (limited(ip)) return fail(429, 'too_many_attempts');
    const v = verifyAssertion(assertion, config, { now: clock(), purpose });
    if (!v.ok) return fail(401, v.reason);
    const p = v.payload; const email = clean(p.email, 200).toLowerCase(); const adminId = String(p.sub).toLowerCase();
    if (!(await consume(p))) return fail(401, 'assertion_replayed', { admin: email });
    if (purpose === 'session' && config.allow.length && !config.allow.includes(email) && !config.allow.includes(adminId)) return fail(403, 'admin_not_allowed_for_growth_engine', { admin: email });
    return { ok: true, payload: p, email, adminId };
  }

  async function exchange(assertion, { ip = 'unknown' } = {}) {
    const c = await check(assertion, { ip, purpose: 'session' });
    if (!c.ok) return c;
    const nowS = Math.floor(clock().getTime() / 1000);
    const ttl = Math.max(1, Math.min(SESSION_S, c.payload.adminExp - nowS));
    const sid = b64u(crypto.randomBytes(18));
    const token = signSession({ email: c.email, adminId: c.adminId, sid, iatMs: clock().getTime(), ttl });
    await audit('sso_login', { admin: c.email, adminId: c.adminId, ip: clean(ip, 64), method: 'website_admin', transport: 'first_party_assertion', site: c.payload.site, assertionId: c.payload.jti.slice(0, 12), sid: sid.slice(0, 12), issuerConfirmed: true, ttlSeconds: ttl });
    return { ok: true, token, sid, expiresInSeconds: ttl, expiresAt: new Date((nowS + ttl) * 1000).toISOString(), expiresAtMs: (nowS + ttl) * 1000, admin: { email: c.email } };
  }

  // website logout: every Growth session of this administrator issued up to now is ended
  async function revokeAdmin(assertion, { ip = 'unknown' } = {}) {
    const c = await check(assertion, { ip, purpose: 'revoke' });
    if (!c.ok) return c;
    const nowMs = clock().getTime(); const nowS = Math.floor(nowMs / 1000);
    await collections.revocations.updateOne({ kind: 'admin', key: c.adminId }, { $set: { kind: 'admin', key: c.adminId, notBeforeMs: nowMs, expiresAt: new Date((nowS + SESSION_S + 300) * 1000) } }, { upsert: true });
    await audit('sso_revoked', { admin: c.email, adminId: c.adminId, ip: clean(ip, 64), scope: 'all_sessions', reason: 'website_logout' });
    return { ok: true };
  }

  // one session (console sign-out, or the back office logging out with the Growth session itself)
  async function revokeSession(claims, { ip = 'unknown', reason = 'logout' } = {}) {
    if (!claims?.sid) return { ok: true, revoked: false };
    const exp = Number.isInteger(claims.exp) ? claims.exp : Math.floor(Date.now() / 1000) + SESSION_S;
    await ensureIndexes();
    await collections.revocations.updateOne({ kind: 'session', key: claims.sid }, { $set: { kind: 'session', key: claims.sid, expiresAt: new Date((exp + 60) * 1000) } }, { upsert: true });
    await audit('session_revoked', { admin: claims.email || null, sid: String(claims.sid).slice(0, 12), ip: clean(ip, 64), reason });
    return { ok: true, revoked: true };
  }

  // null when the session may be used; otherwise the reason it ended
  async function revokedReason(claims) {
    if (!claims?.sid) return null; // Growth Engine password sessions (no session id): ended by password rotation
    const keys = [{ kind: 'session', key: claims.sid }, ...(claims.adminId ? [{ kind: 'admin', key: String(claims.adminId).toLowerCase() }] : [])];
    const rows = await collections.revocations.find({ $or: keys }).toArray();
    if (rows.some((r) => r.kind === 'session')) return 'session_revoked';
    const adminRow = rows.find((r) => r.kind === 'admin');
    const issuedMs = Number.isFinite(claims.iatMs) ? claims.iatMs : (Number.isInteger(claims.iat) ? claims.iat * 1000 : 0);
    if (adminRow && issuedMs <= adminRow.notBeforeMs) return 'signed_out_of_website';
    return null;
  }

  return { exchange, revokeAdmin, revokeSession, revokedReason };
}

// Used by tests and by the website's signer (same format, kept in one place).
function signAssertion(privateKey, claims, { kid } = {}) {
  const header = b64u(JSON.stringify({ alg: 'EdDSA', typ: TYP, ...(kid ? { kid } : {}) }));
  const body = b64u(JSON.stringify(claims));
  return `${header}.${body}.${b64u(crypto.sign(null, Buffer.from(`${header}.${body}`), privateKey))}`;
}

module.exports = { resolveSsoConfig, createAdminSso, verifyAssertion, signAssertion, parsePublicKey, ISSUER, AUDIENCE, TYP, SESSION_S, MAX_ASSERTION_S };
