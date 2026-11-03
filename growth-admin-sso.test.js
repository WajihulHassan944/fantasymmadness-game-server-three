'use strict';
// Website administrator -> Growth Engine single sign-on: server-side verification rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { resolveSsoConfig, createAdminSso, PROBE_PATH } = require('./growth-admin-sso');
const { signConsoleToken, verifyConsoleToken } = require('./growth-console-token');

const LIVE_SECRET = 'L'.repeat(48);            // the live backend's JWT_SECRET_ADMIN
const ADMIN_ID = '65f0c0ffee0000000000abcd';
const liveAdminToken = (o = {}, secret = LIVE_SECRET, opts = { expiresIn: '12h' }) => jwt.sign({ id: ADMIN_ID, email: 'owner@fantasymmadness.test', ...o }, secret, opts);
// Stand-in for the live backend's admin check (same rule as server.js verifyAdminToken).
const issuer = (calls = []) => async (url, opts) => {
  calls.push({ url, auth: opts.headers.Authorization });
  assert.equal(new URL(url).pathname, PROBE_PATH);
  try { jwt.verify(opts.headers.Authorization.slice(7), LIVE_SECRET); return { status: 404 }; } catch { return { status: 401 }; }
};
const config = (env = {}) => resolveSsoConfig(env, { defaultVerifyBase: 'https://fantasymmadness-game-server-three-taupe.vercel.app' });
const make = ({ env = {}, secret = LIVE_SECRET, fetchImpl = issuer(), audit } = {}) => createAdminSso({ config: config(env), adminJwtSecret: secret, fetchImpl, audit,
  signSession: ({ email, adminId, ttl }) => signConsoleToken(secret, { email, adminId, pwv: 'pwv1', method: 'website_admin' }, { expiresIn: ttl }) });

test('a live website admin session becomes a short-lived Growth-Engine-only session', async () => {
  const events = [];
  const calls = [];
  const sso = make({ fetchImpl: issuer(calls), audit: async (a, d) => events.push([a, d]) });
  const websiteToken = liveAdminToken();
  const r = await sso.exchange(websiteToken, { ip: '198.51.100.1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.expiresInSeconds <= 1800 && r.expiresInSeconds >= 1700);
  assert.deepEqual(r.verification, { issuerConfirmed: true, signatureVerifiedLocally: true });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, `https://fantasymmadness-game-server-three-taupe.vercel.app${PROBE_PATH}`);
  const p = verifyConsoleToken(LIVE_SECRET, r.token);
  assert.deepEqual([p.method, p.scope, p.email, p.adminId], ['website_admin', 'growth', 'owner@fantasymmadness.test', ADMIN_ID]);
  assert.ok(p.exp - p.iat <= 1800);
  // the new session is useless on the live API (different key + audience), and the website token is not a console token
  assert.throws(() => jwt.verify(r.token, LIVE_SECRET));
  assert.throws(() => verifyConsoleToken(LIVE_SECRET, websiteToken));
  // audited without the token itself
  const [action, d] = events.at(-1);
  assert.equal(action, 'sso_login'); assert.equal(d.admin, 'owner@fantasymmadness.test'); assert.match(d.fp, /^[a-f0-9]{12}$/);
  assert.ok(!JSON.stringify(events).includes(websiteToken));
});

test('session never outlives the website session', async () => {
  const r = await make().exchange(liveAdminToken({}, LIVE_SECRET, { expiresIn: 300 }));
  assert.equal(r.ok, true); assert.ok(r.expiresInSeconds <= 300);
});

test('the issuer decides: a different local secret still works (issuer confirmed), forged tokens never do', async () => {
  const other = await make({ secret: 'O'.repeat(48) }).exchange(liveAdminToken());
  assert.equal(other.ok, true); assert.equal(other.verification.signatureVerifiedLocally, false);
  const forged = await make({ secret: 'F'.repeat(48) }).exchange(liveAdminToken({}, 'F'.repeat(48)));
  assert.deepEqual([forged.ok, forged.status, forged.reason], [false, 401, 'website_rejected_this_admin_session'], 'signed with the wrong key: the live backend rejects it');
});

test('rejected without asking the issuer: missing, malformed, expired, too old, wrong kind of token', async () => {
  const calls = []; const sso = make({ fetchImpl: issuer(calls) });
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    ['', 'website_admin_session_required'],
    ['not.a.jwt', 'not_a_website_admin_session'],
    ['abc', 'website_admin_session_required'],
    [jwt.sign({ id: ADMIN_ID, email: 'a@b.c' }, LIVE_SECRET, { expiresIn: -10 }), 'website_admin_session_expired'],
    [jwt.sign({ id: ADMIN_ID, email: 'a@b.c', iat: now - 13 * 3600, exp: now + 3600 }, LIVE_SECRET), 'website_admin_session_too_old'],
    [jwt.sign({ id: ADMIN_ID, scope: 'player' }, LIVE_SECRET, { expiresIn: '1h' }), 'not_a_website_admin_session'],
    [jwt.sign({ id: ADMIN_ID, email: 'a@b.c', scope: 'owner-preview' }, LIVE_SECRET, { expiresIn: '1h' }), 'not_a_website_admin_session'],
    [signConsoleToken(LIVE_SECRET, { pwv: 'x' }), 'not_a_website_admin_session'],
    [jwt.sign({ id: 'nothex', email: 'a@b.c' }, LIVE_SECRET, { expiresIn: '1h' }), 'not_a_website_admin_session'],
    [jwt.sign({ id: ADMIN_ID, email: 'a@b.c' }, 'k', { algorithm: 'HS512', expiresIn: '1h' }), 'not_a_website_admin_session'],
    [`${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ id: ADMIN_ID, email: 'a@b.c', iat: now, exp: now + 3600 })).toString('base64url')}.`, 'not_a_website_admin_session'],
  ];
  for (const [t, reason] of cases) { const r = await make({ fetchImpl: issuer(calls) }).exchange(t); assert.equal(r.reason, reason, `${t.slice(0, 30)} -> ${r.reason}`); assert.equal(r.ok, false); }
  void sso; assert.equal(calls.length, 0);
});

test('fails closed when the website cannot confirm, or answers unexpectedly', async () => {
  const down = await make({ fetchImpl: async () => { throw Error('ECONNREFUSED'); } }).exchange(liveAdminToken());
  assert.deepEqual([down.ok, down.status, down.reason], [false, 503, 'website_unreachable_try_again']);
  const odd = await make({ fetchImpl: async () => ({ status: 500 }) }).exchange(liveAdminToken());
  assert.deepEqual([odd.ok, odd.status], [false, 503]);
  const ok200 = await make({ fetchImpl: async () => ({ status: 200 }) }).exchange(liveAdminToken());
  assert.equal(ok200.ok, false, 'only the exact admin-check answer (404 for the all-zero fight) counts');
});

test('allow-list, rate limit, configuration', async () => {
  assert.equal((await make({ env: { GROWTH_SSO_ALLOWED_ADMINS: 'someone@else.test' } }).exchange(liveAdminToken())).reason, 'admin_not_allowed_for_growth_engine');
  assert.equal((await make({ env: { GROWTH_SSO_ALLOWED_ADMINS: ` OWNER@fantasymmadness.test ` } }).exchange(liveAdminToken())).ok, true);
  assert.equal((await make({ env: { GROWTH_SSO_ALLOWED_ADMINS: ADMIN_ID } }).exchange(liveAdminToken())).ok, true);
  const sso = make(); let last;
  for (let i = 0; i < 22; i++) last = await sso.exchange('', { ip: '203.0.113.9' });
  assert.equal(last.reason, 'too_many_attempts');
  assert.equal((await sso.exchange(liveAdminToken(), { ip: '203.0.113.10' })).ok, true, 'other addresses unaffected');
  assert.equal(config({ GROWTH_SSO_VERIFY_URL: 'https://evil.example' }).enabled, false);
  assert.equal(config({ GROWTH_SSO_VERIFY_URL: 'http://127.0.0.1:5071' }).enabled, false, 'loopback only when explicitly allowed (tests)');
  assert.equal(config({ GROWTH_SSO_VERIFY_URL: 'http://127.0.0.1:5071', GROWTH_SSO_ALLOW_LOOPBACK: 'true' }).enabled, true);
  assert.equal(config({ GROWTH_SSO: 'off' }).enabled, false);
  assert.equal((await make({ env: { GROWTH_SSO: 'off' } }).exchange(liveAdminToken())).reason, 'sso_not_configured');
});
