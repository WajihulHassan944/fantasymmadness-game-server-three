'use strict';
// Unit tests: first-party signed administrator assertion -> Growth Engine session (growth-admin-sso.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { resolveSsoConfig, createAdminSso, signAssertion, verifyAssertion } = require('./growth-admin-sso');

const SITE = 'https://www.fantasymmadness.com';
const keys = crypto.generateKeyPairSync('ed25519');
const otherKeys = crypto.generateKeyPairSync('ed25519');
const pubB64 = Buffer.from(keys.publicKey.export({ type: 'spki', format: 'pem' })).toString('base64');
const ADMIN_ID = '65f0c0ffee0000000000abcd';
const NOW = new Date('2026-11-03T16:00:00Z');
const nowS = Math.floor(NOW.getTime() / 1000);

// minimal in-memory stand-ins for the Mongo collections used
function memColl() {
  const rows = [];
  const match = (r, q) => Object.entries(q).every(([k, v]) => (k === '$or' ? v.some((x) => match(r, x)) : r[k] === v));
  return {
    rows,
    createIndex: async () => 'ok',
    insertOne: async (doc) => { if (doc._id && rows.some((r) => r._id === doc._id)) { const e = new Error('dup'); e.code = 11000; throw e; } rows.push({ ...doc }); return { acknowledged: true }; },
    updateOne: async (q, { $set }, { upsert } = {}) => { const r = rows.find((x) => match(x, q)); if (r) Object.assign(r, $set); else if (upsert) rows.push({ ...$set }); return {}; },
    find: (q) => ({ toArray: async () => rows.filter((r) => match(r, q)) }),
  };
}
const claims = (over = {}) => ({ iss: 'fmm-admin-site', aud: 'fmm-growth-engine', purpose: 'session', sub: ADMIN_ID, email: 'Owner@FMM.test', site: SITE, jti: crypto.randomBytes(24).toString('base64url'), iat: nowS, exp: nowS + 60, adminExp: nowS + 6 * 3600, verifiedBy: 'live-admin-authority', ...over });
const setup = (env = {}, clock = () => NOW) => {
  const config = resolveSsoConfig({ GROWTH_SSO_SITE_PUBLIC_KEY: pubB64, GROWTH_SSO_SITE_ORIGINS: SITE, ...env });
  const collections = { nonces: memColl(), revocations: memColl(), audit: memColl() };
  const issued = [];
  const sso = createAdminSso({ config, collections, now: clock, signSession: (s) => { issued.push(s); return `growth.${s.sid}.token`; } });
  return { config, collections, sso, issued };
};

test('config: needs an Ed25519 public key and the website origins; GROWTH_SSO=off turns it off', () => {
  assert.equal(resolveSsoConfig({}).enabled, false);
  assert.equal(resolveSsoConfig({ GROWTH_SSO_SITE_PUBLIC_KEY: pubB64, GROWTH_SSO_SITE_ORIGINS: SITE }).enabled, true);
  assert.equal(resolveSsoConfig({ GROWTH_SSO_SITE_PUBLIC_KEY: pubB64, GROWTH_CONSOLE_EMBED_ORIGINS: SITE }).siteOrigins[0], SITE);
  assert.equal(resolveSsoConfig({ GROWTH_SSO_SITE_PUBLIC_KEY: pubB64 }).enabled, false, 'no site origins');
  assert.equal(resolveSsoConfig({ GROWTH_SSO_SITE_PUBLIC_KEY: 'not a key', GROWTH_SSO_SITE_ORIGINS: SITE }).enabled, false);
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.equal(resolveSsoConfig({ GROWTH_SSO_SITE_PUBLIC_KEY: rsa, GROWTH_SSO_SITE_ORIGINS: SITE }).enabled, false, 'only Ed25519');
  assert.equal(resolveSsoConfig({ GROWTH_SSO: 'off', GROWTH_SSO_SITE_PUBLIC_KEY: pubB64, GROWTH_SSO_SITE_ORIGINS: SITE }).enabled, false);
});

test('a valid first-party assertion gives a short-lived Growth session (<=30 min, never past the website session), audited', async () => {
  const { sso, issued, collections } = setup();
  const r = await sso.exchange(signAssertion(keys.privateKey, claims()), { ip: '1.2.3.4' });
  assert.equal(r.ok, true); assert.equal(r.expiresInSeconds, 1800); assert.equal(r.admin.email, 'owner@fmm.test');
  assert.equal(issued[0].adminId, ADMIN_ID); assert.ok(issued[0].sid.length >= 20); assert.equal(issued[0].iatMs, NOW.getTime());
  const short = await sso.exchange(signAssertion(keys.privateKey, claims({ adminExp: nowS + 300 })));
  assert.equal(short.expiresInSeconds, 300, 'bounded by the website session');
  const ending = await sso.exchange(signAssertion(keys.privateKey, claims({ adminExp: nowS + 45 })));
  assert.equal(ending.expiresInSeconds, 45, 'a near-expiry administrator session must not be extended to a minute');
  const log = collections.audit.rows.find((a) => a.action === 'sso_login');
  assert.equal(log.transport, 'first_party_assertion'); assert.equal(log.issuerConfirmed, true);
  assert.equal(JSON.stringify(collections.audit.rows).includes('growth.'), false, 'no tokens in the audit log');
});

test('refused: replay, wrong key, wrong audience/issuer/purpose/site, unverified, too long, expired, malformed, website session ended', async () => {
  const { sso } = setup();
  const once = signAssertion(keys.privateKey, claims());
  assert.equal((await sso.exchange(once)).ok, true);
  assert.equal((await sso.exchange(once)).reason, 'assertion_replayed');
  const cases = [
    [signAssertion(otherKeys.privateKey, claims()), 'assertion_bad_signature'],
    [signAssertion(keys.privateKey, claims({ aud: 'something-else' })), 'assertion_wrong_audience'],
    [signAssertion(keys.privateKey, claims({ iss: 'someone' })), 'assertion_wrong_audience'],
    [signAssertion(keys.privateKey, claims({ purpose: 'revoke' })), 'assertion_wrong_purpose'],
    [signAssertion(keys.privateKey, claims({ site: 'https://evil.example' })), 'assertion_unknown_site'],
    [signAssertion(keys.privateKey, claims({ verifiedBy: 'browser' })), 'assertion_not_verified'],
    [signAssertion(keys.privateKey, claims({ exp: nowS + 600 })), 'assertion_lifetime_invalid'],
    [signAssertion(keys.privateKey, claims({ iat: nowS - 90, exp: nowS - 1 })), 'assertion_expired'],
    [signAssertion(keys.privateKey, claims({ adminExp: nowS + 5 })), 'website_admin_session_expired'],
    [signAssertion(keys.privateKey, claims({ sub: 'not-an-id' })), 'assertion_malformed'],
    [signAssertion(keys.privateKey, claims({ jti: 'short' })), 'assertion_malformed'],
    ['a.b.c', 'assertion_malformed'],
    ['', 'assertion_malformed'],
  ];
  for (const [a, reason] of cases) { const r = await sso.exchange(a); assert.equal(r.ok, false); assert.equal(r.status, 401); assert.equal(r.reason, reason); }
  // a website admin token (HS256 JWT) is not an assertion
  const hs = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ id: ADMIN_ID, email: 'x@y.z' })).toString('base64url')}.sig`;
  assert.equal((await sso.exchange(hs)).reason, 'assertion_wrong_type');
  // tampered body
  const [h, , s] = signAssertion(keys.privateKey, claims()).split('.');
  assert.equal((await sso.exchange(`${h}.${Buffer.from(JSON.stringify(claims({ email: 'attacker@x.y' }))).toString('base64url')}.${s}`)).reason, 'assertion_bad_signature');
});

test('allow-list, not configured, and rate limit fail closed', async () => {
  const { sso } = setup({ GROWTH_SSO_ALLOWED_ADMINS: 'someone@else.test' });
  const r = await sso.exchange(signAssertion(keys.privateKey, claims()));
  assert.deepEqual([r.status, r.reason], [403, 'admin_not_allowed_for_growth_engine']);
  assert.equal((await setup({ GROWTH_SSO_ALLOWED_ADMINS: ADMIN_ID }).sso.exchange(signAssertion(keys.privateKey, claims()))).ok, true);
  assert.equal((await setup({ GROWTH_SSO: 'off' }).sso.exchange(signAssertion(keys.privateKey, claims()))).reason, 'sso_not_configured');
  const limited = setup().sso; let last;
  for (let i = 0; i < 31; i += 1) last = await limited.exchange('x', { ip: '9.9.9.9' });
  assert.equal(last.status, 429);
});

test('revocation: logout ends one session; website logout ends every earlier session of that admin, but not a new sign-in', async () => {
  let t = NOW.getTime(); const clock = () => new Date(t);
  const { sso, issued } = setup({}, clock);
  await sso.exchange(signAssertion(keys.privateKey, claims())); await sso.exchange(signAssertion(keys.privateKey, claims()));
  const [a, b] = issued.map((s) => ({ sid: s.sid, adminId: s.adminId, email: s.email, iat: Math.floor(s.iatMs / 1000), iatMs: s.iatMs, exp: nowS + 1800 }));
  assert.equal(await sso.revokedReason(a), null);
  await sso.revokeSession(a, { reason: 'logout' });
  assert.equal(await sso.revokedReason(a), 'session_revoked'); assert.equal(await sso.revokedReason(b), null);
  t += 1;
  const rv = await sso.revokeAdmin(signAssertion(keys.privateKey, claims({ purpose: 'revoke' })));
  assert.equal(rv.ok, true);
  assert.equal(await sso.revokedReason(b), 'signed_out_of_website');
  t += 1; // same second, later millisecond: a fresh sign-in after logout works
  await sso.exchange(signAssertion(keys.privateKey, claims()));
  const c = issued[2];
  assert.equal(await sso.revokedReason({ sid: c.sid, adminId: c.adminId, iat: Math.floor(c.iatMs / 1000), iatMs: c.iatMs }), null);
  // a session assertion cannot be used to revoke, nor a revoke assertion to sign in
  assert.equal((await sso.revokeAdmin(signAssertion(keys.privateKey, claims()))).reason, 'assertion_wrong_purpose');
  assert.equal(await sso.revokedReason({ email: 'owner' }), null, 'password sessions have no session id');
});

test('verifyAssertion is a pure check (no state)', () => {
  const config = resolveSsoConfig({ GROWTH_SSO_SITE_PUBLIC_KEY: pubB64, GROWTH_SSO_SITE_ORIGINS: SITE });
  const a = signAssertion(keys.privateKey, claims());
  assert.equal(verifyAssertion(a, config, { now: NOW }).ok, true);
  assert.equal(verifyAssertion(a, config, { now: NOW }).ok, true, 'replay protection lives in the nonce store');
  assert.equal(verifyAssertion(a, config, { now: new Date(NOW.getTime() + 61000) }).reason, 'assertion_expired');
});
