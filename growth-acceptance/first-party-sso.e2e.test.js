'use strict';
// End-to-end: website administrator login -> Growth Engine through the FIRST-PARTY session bridge.
// Real pieces only:
//   - the real website (fmm-ver2 PR #193 + the same-origin bridge, built and started by Next.js),
//   - the REAL website backend (server.js, loopback only, local MongoDB) issuing a real admin
//     session through its real /admin/login and acting as the live admin authority,
//   - the real Growth Engine (routes + runtime + original console) with the website's PUBLIC key.
// The website administrator token must never reach the Growth Engine (browser OR server side).
// Env: GROWTH_TEST_MONGO_URI, SITE_URL, GROWTH_V2=first-party, SSO_WEBSITE_API, SSO_JWT_SECRET_ADMIN,
//      SSO_JWT_SECRET, SSO_SITE_PUBLIC_KEY, SSO_SITE_PRIVATE_KEY (test-only keys), WEB_DIR, GROWTH_CONSOLE_SCREENSHOTS
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { MongoClient } = require('mongodb');
const { registerIsolatedGrowthRoutes } = require('../growth-isolated-routes');
const { hashPassword } = require('../growth-backoffice');
const { contestFeed } = require('../growth-contest-feed.fixture');
const { signAssertion } = require('../growth-admin-sso');

const uri = process.env.GROWTH_TEST_MONGO_URI;
const SITE = process.env.SITE_URL;
const MODE = process.env.GROWTH_V2;
const WEBSITE_API = process.env.SSO_WEBSITE_API || 'http://127.0.0.1:5071';
const ADMIN_SECRET = process.env.SSO_JWT_SECRET_ADMIN;
const PLAYER_SECRET = process.env.SSO_JWT_SECRET;
const PUBLIC_KEY = process.env.SSO_SITE_PUBLIC_KEY;
const PRIVATE_KEY = process.env.SSO_SITE_PRIVATE_KEY;
const WEB_DIR = process.env.WEB_DIR;
const PROBE_PATH = '/api/admin/matches/000000000000000000000000';
let chromium = null; try { ({ chromium } = require('playwright')); } catch { /* optional */ }
const skip = MODE !== 'first-party' ? 'only for the first-party sign-in build' : (!uri || !SITE || !chromium || !ADMIN_SECRET || !PUBLIC_KEY || !PRIVATE_KEY || !WEB_DIR ? 'needs MongoDB, the site, the website backend, test keys and playwright' : false);
const ENGINE = 'http://127.0.0.1:4300';
const ADMIN = { email: 'owner@fmm-sso.test', password: 'website admin password (test only)' };
const SHOTS = process.env.GROWTH_CONSOLE_SCREENSHOTS;
const feed = contestFeed();
const fetchImpl = async (url, opts) => {
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(String(url))) return fetch(url, opts);
  const f = feed(url); if (f) return f;
  const term = new URL(url).searchParams.get('term') || 'x';
  return { ok: true, status: 200, json: async () => ({ results: [1, 2].map((n) => ({ collectionName: `${term} show ${n}`, collectionViewUrl: `https://podcasts.apple.com/us/podcast/x-${n}/id${n}` })) }) };
};
// Codex's back-office sections -> the original console page each opens
const SECTIONS = [['overview', 'overview'], ['approvals', 'approvals'], ['marketing', 'marketing'], ['pr', 'pr'], ['affiliates', 'affiliates'], ['publishing', 'publishing'], ['posters', 'marketing'], ['automation', 'automation'], ['analytics', 'analytics'], ['revenue', 'revenue'], ['connections', 'connections']];
const ENDPOINTS = ['/admin/session', '/admin/overview', '/admin/status', '/admin/drafts?kind=marketing', '/admin/workstreams', '/admin/analytics', '/admin/attribution', '/admin/executive', '/admin/funnel', '/admin/research?track=pr', '/admin/research?track=affiliate',
  '/admin/social', '/admin/social/capabilities', '/admin/posters', '/admin/fighter-assets', '/admin/connections', '/admin/email/sandbox', '/admin/email/readiness', '/admin/alerts?state=all', '/admin/jobs', '/admin/runs', '/admin/reports', '/admin/audit', '/admin/suppressions', '/admin/prospects', '/admin/marketing/coverage', '/admin/affiliates', '/admin/meta'];
const decode = (t) => JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString());
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await new Promise((r) => setTimeout(r, 200)); } };

test(`website administrator -> Growth Engine, first-party session bridge (${MODE})`, { skip, timeout: 480000 }, async (t) => {
  const client = await new MongoClient(uri).connect();
  await client.db('fmgrowthtest').dropDatabase();
  const gdb = client.db('fmgrowthtest');
  const bcrypt = require('bcrypt');
  const site = client.db('fmm_sso_website');
  await site.collection('admins').deleteMany({});
  await site.collection('admins').insertOne({ email: ADMIN.email, password: bcrypt.hashSync(ADMIN.password, 10) });
  const baseEnv = { GROWTH_STAGING_MODE: 'isolated', GROWTH_OUTBOUND_ENABLED: 'false', GROWTH_TEST_MONGO_URI: uri, JWT_SECRET_ADMIN: 'engine-only-secret-not-the-website-one-0123456789', GROWTH_UNSUBSCRIBE_SECRET: 's'.repeat(48), CRON_SECRET: 'cron-secret-for-tests-only',
    GROWTH_DELIVERY_PROVIDER: 'none', GROWTH_ADMIN_PASSWORD_HASH: hashPassword('growth engine password that is never typed in this test'), GROWTH_SOCIAL_PROVIDER: 'sandbox', GROWTH_CONSOLE_EMBED_ORIGINS: SITE,
    GROWTH_SSO_SITE_PUBLIC_KEY: PUBLIC_KEY, GROWTH_SSO_RATE_LIMIT_PER_MIN: '200' };
  const servers = []; const inbound = [];
  const startEngine = async (port, env) => {
    const app = express();
    // every request that reaches the engine is recorded (headers + parsed body) for the credential-egress check
    app.use((req, res, next) => { res.on('finish', () => inbound.push({ port, path: req.originalUrl.split('?')[0], auth: String(req.headers.authorization || ''), body: JSON.stringify(req.body || {}), origin: req.headers.origin || null })); next(); });
    app.use(cors({ origin: (o, cb) => (!o || [SITE, ENGINE].includes(o) ? cb(null, true) : cb(new Error('Not allowed by CORS'))), credentials: true }));
    const m = registerIsolatedGrowthRoutes({ app, env: { ...baseEnv, ...env }, express, fetchImpl, connect: async () => client });
    assert.equal(m.mounted, true, JSON.stringify(m.errors));
    const rt = await m.getRuntime();
    servers.push(app.listen(port, '127.0.0.1'));
    return { rt, url: `http://127.0.0.1:${port}/api/growth` };
  };
  const main = await startEngine(4300, {});
  await main.rt.tick({ now: new Date(Date.now() - 60 * 60000) });
  const call = async (base, method, p, token, body, headers = {}) => { const r = await fetch(`${base}${p}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, json: j }; };
  const websiteLogin = async (password = ADMIN.password) => { const r = await fetch(`${WEBSITE_API}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ADMIN.email, password }) }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const sitePost = (token, headers = {}, method = 'POST', body = '{}') => fetch(`${SITE}/api/admin/growth-session`, { method, headers: { Origin: SITE, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: method === 'GET' ? undefined : body }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const auditFind = (q) => gdb.collection('growth_audit_log').findOne(q);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const blocked = new Set(); const toEngine = []; const exchanges = [];
  await ctx.route('**/*', (route) => {
    const req = route.request(); const u = new URL(req.url());
    if (u.origin === ENGINE) toEngine.push({ path: u.pathname, auth: req.headers().authorization || '', body: req.postData() || '' });
    if (u.origin === SITE && u.pathname === '/api/admin/growth-session') exchanges.push(req.method());
    if ([SITE, ENGINE, WEBSITE_API].includes(u.origin) || u.protocol === 'data:') return route.continue();
    blocked.add(u.host); return route.abort();
  });
  await ctx.addInitScript(() => { try { window.sessionStorage.setItem('jarvisGreeted', '1'); window.sessionStorage.setItem('adminPushAsked', '1'); } catch (e) { /* ignore */ } });
  const page = await ctx.newPage(); page.setDefaultTimeout(30000);
  let phase = 'signed-in'; const pageErrors = []; page.on('pageerror', (e) => pageErrors.push({ phase, url: page.url(), message: e.message }));
  const shot = (name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, `first-party-${name}.jpg`), type: 'jpeg', quality: 70 }) : null);
  const frame = () => page.frameLocator('[data-testid=ge-frame]');
  const growthSession = () => page.evaluate(() => window.sessionStorage.getItem('fmmGrowthBridgeToken'));
  const websiteTokens = new Set();
  let websiteToken = null; let firstSession = null;
  try {
    await t.test('real website admin login, then the original Growth Engine opens with NO second password', async () => {
      await page.goto(`${SITE}/administration/login`);
      await page.fill('input[type=email]', ADMIN.email);
      await page.fill('input[type=password]', ADMIN.password);
      await page.click('.admin-login-submit');
      await page.waitForURL((u) => /\/administration/.test(u.pathname) && !/login/.test(u.pathname));
      websiteToken = await page.evaluate(() => window.localStorage.getItem('adminAuthToken'));
      websiteTokens.add(websiteToken);
      assert.equal(decode(websiteToken).email, ADMIN.email);
      await page.goto(`${SITE}/administration/growth-engine/approvals`);
      await frame().locator('[data-testid=page-approvals]').waitFor();
      assert.equal(await frame().locator('[data-testid=login-password]').count(), 0, 'Growth Engine password asked');
      assert.ok(exchanges.includes('POST'), 'the same-origin session endpoint was used');
      firstSession = await growthSession();
      const p = decode(firstSession);
      assert.deepEqual([p.method, p.scope, p.email, p.aud], ['website_admin', 'growth', ADMIN.email, 'fmm-growth-console']);
      assert.ok(p.exp - p.iat <= 1800, 'short-lived'); assert.ok(p.sid, 'revocable session id');
      assert.ok(await auditFind({ action: 'sso_login', admin: ADMIN.email, transport: 'first_party_assertion', site: SITE, issuerConfirmed: true }));
      await shot('signed-in-with-website-admin');
    });
    await t.test('every Growth Engine section opens inside the back office (11 tabs, 10 departments)', async () => {
      for (const [slug, consolePage] of SECTIONS) {
        await page.click(`[data-testid=ge-tab-${slug}]`);
        await frame().locator(`[data-testid=page-${consolePage}]`).waitFor();
        assert.equal(await frame().locator('[data-testid=page-error]').count(), 0, `error on ${slug}`);
      }
      await shot('sections');
    });
    await t.test('owner approval in the console is recorded under the website administrator', async () => {
      await page.click('[data-testid=ge-tab-approvals]');
      const card = frame().locator('[data-testid=draft][data-status=needs_owner_review]').first();
      await card.waitFor();
      const id = await card.getAttribute('data-draft-id');
      await card.locator('[data-testid=btn-approve]').click();
      await frame().locator('[data-testid=modal-confirm]').click();
      await frame().locator(`[data-draft-id="${id}"]`).waitFor({ state: 'detached' });
      const d = await gdb.collection('growth_drafts').findOne({ id });
      assert.equal(d.status, 'approved'); assert.equal(d.approvedBy, ADMIN.email);
    });
    await t.test('a revoked/ended Growth session is renewed automatically from the administrator session (no password)', async () => {
      const before = exchanges.length; const sid = decode(await growthSession()).sid;
      await gdb.collection('growth_session_revocations').insertOne({ kind: 'session', key: sid, expiresAt: new Date(Date.now() + 3600000) });
      await page.click('[data-testid=ge-tab-marketing]');
      assert.ok(await waitFor(() => exchanges.length > before), 'renewed through the same-origin endpoint');
      await frame().locator('[data-testid=page-marketing]').waitFor();
      assert.ok(await waitFor(async () => { const s = await growthSession(); return s && decode(s).sid !== sid; }), 'a new session replaced the revoked one');
      assert.equal(await frame().locator('[data-testid=login-password]').count(), 0);
    });
    await t.test('mobile 390x844: no horizontal overflow in the embedded console (CSS repair)', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      for (const [slug, consolePage] of [['overview', 'overview'], ['marketing', 'marketing'], ['approvals', 'approvals'], ['connections', 'connections'], ['analytics', 'analytics'], ['revenue', 'revenue']]) {
        await page.goto(`${SITE}/administration/growth-engine/${slug === 'overview' ? '' : slug}`.replace(/\/$/, ''));
        await frame().locator(`[data-testid=page-${consolePage}]`).waitFor();
        const f = page.frames().find((x) => x.url().startsWith(`${ENGINE}/api/growth/console`));
        const [sw, cw] = await f.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
        assert.ok(sw <= cw + 1, `${slug}: console ${sw}px wide in a ${cw}px frame`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${slug}: page overflows`);
        if (slug === 'marketing') await shot('mobile-marketing');
      }
      await page.setViewportSize({ width: 1360, height: 900 });
    });
    await t.test('sign out inside the console revokes that session; the back office does not silently sign back in', async () => {
      await page.goto(`${SITE}/administration/growth-engine/overview`);
      await frame().locator('[data-testid=page-overview]').waitFor();
      const tok = await growthSession(); const sid = decode(tok).sid;
      await frame().locator('[data-testid=signout]').click();
      assert.ok(await waitFor(() => auditFind({ action: 'session_revoked', sid: sid.slice(0, 12) })), 'revoked on the server');
      assert.equal((await call(main.url, 'GET', '/admin/session', tok)).json.reason, 'session_revoked');
      await page.locator('[data-testid=ge-session-notice]').waitFor();
      assert.equal(await growthSession(), null);
    });
    await t.test('website logout ends every Growth session (server-side revocation), then a new login works again', async () => {
      await page.click('[data-testid=ge-session-notice] button');
      await frame().locator('[data-testid=page-overview]').waitFor();
      const tok = await growthSession();
      const logout = page.locator('button[aria-label=Logout], button:has-text("Logout")').first();
      await logout.click();
      await page.waitForURL(/\/administration\/login/);
      assert.ok(await waitFor(() => auditFind({ action: 'sso_revoked', admin: ADMIN.email, reason: 'website_logout' })), 'website logout reached the engine as a signed revoke');
      const r = await call(main.url, 'GET', '/admin/session', tok);
      assert.equal(r.status, 401); assert.ok(['signed_out_of_website', 'session_revoked'].includes(r.json.reason), r.json.reason);
      assert.equal(await growthSession(), null);
      phase = 'signed-out';
      await page.goto(`${SITE}/administration/growth-engine/overview`);
      await page.waitForURL(/\/administration\/login/);
      phase = 'signed-in';
      await page.fill('input[type=email]', ADMIN.email);
      await page.fill('input[type=password]', ADMIN.password);
      await page.click('.admin-login-submit');
      await page.waitForURL((u) => /\/administration/.test(u.pathname) && !/login/.test(u.pathname));
      websiteTokens.add(await page.evaluate(() => window.localStorage.getItem('adminAuthToken')));
      await page.goto(`${SITE}/administration/growth-engine/overview`);
      await frame().locator('[data-testid=page-overview]').waitFor();
      assert.equal(await frame().locator('[data-testid=login-password]').count(), 0);
    });
    await t.test('forged administrator session is refused by the live authority; no Growth session', async () => {
      const forged = jwt.sign({ id: '65f0c0ffee0000000000abcd', email: ADMIN.email }, 'f'.repeat(48), { expiresIn: '1h' });
      await page.evaluate((f) => { window.localStorage.setItem('adminAuthToken', f); window.sessionStorage.removeItem('fmmGrowthBridgeToken'); window.sessionStorage.removeItem('fmmGrowthBridgeExpiry'); }, forged);
      await page.goto(`${SITE}/administration/growth-engine/overview`);
      await page.locator('[data-testid=ge-session-notice]').waitFor();
      assert.equal(await growthSession(), null, 'no Growth Engine session from a forged token');
      assert.equal(await frame().locator('[data-testid=page-overview]').count(), 0);
    });

    // ---------- server level ----------
    const login = await websiteLogin(); assert.equal(login.status, 200);
    const adminTok = login.json.token; websiteTokens.add(adminTok);
    await t.test('same-origin endpoint: CSRF/origin, method and content checks; refused administrator sessions', async () => {
      assert.equal((await sitePost(adminTok, { Origin: 'https://evil.example' })).status, 403);
      assert.equal((await sitePost(adminTok, { Origin: '' })).status, 403);
      assert.equal((await sitePost(adminTok, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
      assert.equal((await sitePost(adminTok, { 'Content-Type': 'text/plain' })).status, 415);
      assert.equal((await sitePost(adminTok, {}, 'GET')).status, 405);
      const bad = [
        [jwt.sign({ id: '65f0c0ffee0000000000abcd', email: ADMIN.email }, 'f'.repeat(48), { expiresIn: '1h' }), 'administrator_session_rejected'],
        [jwt.sign({ id: '65f0c0ffee0000000000abcd', email: ADMIN.email }, ADMIN_SECRET, { expiresIn: -5 }), 'administrator_session_expired'],
        [jwt.sign({ id: '65f0c0ffee0000000000abcd', scope: 'player' }, PLAYER_SECRET, { expiresIn: '1h' }), 'not_an_administrator_session'],
        [firstSession, 'not_an_administrator_session'],
        ['', 'administrator_session_required'],
      ];
      for (const [tok, reason] of bad) { const r = await sitePost(tok); assert.equal(r.status, 401, reason); assert.equal(r.json.reason, reason); }
      const ok = await sitePost(adminTok);
      assert.equal(ok.status, 200, JSON.stringify(ok.json)); assert.equal(ok.json.engineOrigin, ENGINE); assert.ok(ok.json.expiresAt > Date.now() && ok.json.expiresAt <= Date.now() + 1800000 + 2000);
      assert.deepEqual(Object.keys(ok.json).sort(), ['admin', 'engineOrigin', 'expiresAt', 'method', 'ok', 'token']);
    });
    const session = (await sitePost(adminTok)).json.token;
    await t.test('every original Growth Engine endpoint works with the first-party session', async () => {
      for (const p of ENDPOINTS) { const r = await call(main.url, 'GET', p, session); assert.equal(r.status, 200, `${p} -> ${r.status}`); }
      assert.equal((await call(main.url, 'GET', '/admin/session', session)).json.method, 'website_admin');
    });
    await t.test('engine: assertions only server to server, signed by the website key, single use; the old direct route is gone', async () => {
      const nowS = Math.floor(Date.now() / 1000);
      const claims = { iss: 'fmm-admin-site', aud: 'fmm-growth-engine', purpose: 'session', sub: '65f0c0ffee0000000000abcd', email: ADMIN.email, site: SITE, jti: crypto.randomBytes(24).toString('base64url'), iat: nowS, exp: nowS + 60, adminExp: nowS + 3600, verifiedBy: 'live-admin-authority' };
      const key = crypto.createPrivateKey(Buffer.from(PRIVATE_KEY, 'base64').toString('utf8'));
      const a = signAssertion(key, claims);
      assert.equal((await call(main.url, 'POST', '/admin/sso/assertion', null, { assertion: a }, { Origin: SITE })).json.reason, 'server_to_server_only', 'browser-originated request refused');
      assert.equal((await call(main.url, 'POST', '/admin/sso/assertion', null, { assertion: a })).status, 200);
      assert.equal((await call(main.url, 'POST', '/admin/sso/assertion', null, { assertion: a })).json.reason, 'assertion_replayed');
      const other = crypto.generateKeyPairSync('ed25519').privateKey;
      assert.equal((await call(main.url, 'POST', '/admin/sso/assertion', null, { assertion: signAssertion(other, { ...claims, jti: crypto.randomBytes(24).toString('base64url') }) })).json.reason, 'assertion_bad_signature');
      assert.equal((await call(main.url, 'POST', '/admin/sso/assertion', null, { assertion: signAssertion(key, { ...claims, jti: crypto.randomBytes(24).toString('base64url'), site: 'https://evil.example' }) })).json.reason, 'assertion_unknown_site');
      const old = await call(main.url, 'POST', '/admin/sso', adminTok);
      assert.equal(old.status, 410); assert.equal(old.json.reason, 'direct_admin_token_exchange_removed');
      assert.equal((await call(main.url, 'GET', '/admin/overview', adminTok)).status, 401, 'website token is not a Growth Engine session');
      assert.equal((await fetch(`${WEBSITE_API}${PROBE_PATH}`, { headers: { Authorization: `Bearer ${session}` } })).status, 401, 'Growth session accepted by the website backend');
      assert.equal((await fetch(`${WEBSITE_API}${PROBE_PATH}`, { headers: { Authorization: `Bearer ${adminTok}` } })).status, 404, 'sanity: the website backend accepts its own admin session');
    });
    await t.test('fails closed: admin authority down, engine down, allow-list, rollback (GROWTH_SSO=off keeps the password)', async () => {
      const { createGrowthSessionBridge } = require(path.join(WEB_DIR, 'src/server/growthSessionBridge.cjs'));
      const req = (tok) => ({ method: 'POST', ip: 't', selfOrigin: SITE, headers: { origin: SITE, 'content-type': 'application/json', authorization: `Bearer ${tok}` } });
      const env = { GROWTH_SSO_SITE_PRIVATE_KEY: PRIVATE_KEY, GROWTH_SSO_ALLOW_LOOPBACK: 'true', GROWTH_SITE_ORIGINS: SITE, FMM_ADMIN_VERIFY_URL: WEBSITE_API, GROWTH_ENGINE_SERVER_URL: ENGINE };
      const real = await createGrowthSessionBridge({ env }).handle(req(adminTok));
      assert.equal(real.status, 200, JSON.stringify(real.body));
      assert.equal((await createGrowthSessionBridge({ env: { ...env, FMM_ADMIN_VERIFY_URL: 'http://127.0.0.1:9' } }).handle(req(adminTok))).body.reason, 'admin_authority_unreachable');
      assert.equal((await createGrowthSessionBridge({ env: { ...env, GROWTH_ENGINE_SERVER_URL: 'http://127.0.0.1:9' } }).handle(req(adminTok))).status, 503);
      await startEngine(4302, { GROWTH_SSO_ALLOWED_ADMINS: 'someone.else@fmm-sso.test' });
      const denied = await createGrowthSessionBridge({ env: { ...env, GROWTH_ENGINE_SERVER_URL: 'http://127.0.0.1:4302' } }).handle(req(adminTok));
      assert.deepEqual([denied.status, denied.body.reason], [403, 'admin_not_allowed_for_growth_engine']);
      const off = await startEngine(4304, { GROWTH_SSO: 'off', GROWTH_ADMIN_PASSWORD_HASH: hashPassword('rollback password') });
      assert.equal((await createGrowthSessionBridge({ env: { ...env, GROWTH_ENGINE_SERVER_URL: 'http://127.0.0.1:4304' } }).handle(req(adminTok))).body.reason, 'sso_not_configured');
      const pw = await call(off.url, 'POST', '/admin/login', null, { password: 'rollback password' });
      assert.equal(pw.status, 200); assert.equal((await call(off.url, 'GET', '/admin/session', pw.json.token)).json.method, 'console_password');
    });
    await t.test('sandbox campaign under the first-party session: schedule, publish (sandbox), no duplicates, no real post', async () => {
      const d = (await call(main.url, 'GET', '/admin/drafts?kind=marketing&status=approved', session)).json.drafts[0]
        || (await (async () => { const x = (await call(main.url, 'GET', '/admin/drafts?kind=marketing&status=needs_owner_review', session)).json.drafts[0]; await call(main.url, 'POST', `/admin/drafts/${encodeURIComponent(x.id)}/approve`, session, {}); return x; })());
      const s1 = await call(main.url, 'POST', `/admin/drafts/${encodeURIComponent(d.id)}/schedule`, session, { channels: ['facebook'], scheduledAt: new Date(Date.now() + 60000).toISOString() });
      assert.equal(s1.status, 200, JSON.stringify(s1.json));
      assert.match((await call(main.url, 'POST', `/admin/drafts/${encodeURIComponent(d.id)}/schedule`, session, { channels: ['facebook'], scheduledAt: new Date(Date.now() + 60000).toISOString() })).json.results[0].reason, /^already_/);
      const out = await main.rt.social.dispatch(new Date(Date.now() + 3 * 60000));
      assert.equal(out.published, 1);
      const posts = await gdb.collection('growth_social_posts').find({ draftId: d.id }).toArray();
      assert.ok(posts.every((p) => p.status !== 'published' || p.sandbox === true));
      assert.equal(posts[0].scheduledBy, ADMIN.email);
    });
    await t.test('credential egress: no website administrator token ever reached the Growth Engine (browser or server)', async () => {
      const tokens = [...websiteTokens].filter(Boolean);
      assert.ok(tokens.length >= 2 && toEngine.length > 10 && inbound.length > 10);
      // the deliberate checks above sent the website token to the engine on purpose (old route, wrong-token check): exclude only those two paths
      const deliberate = (r) => r.port === 4300 && ((r.path === '/api/growth/admin/sso') || (r.path === '/api/growth/admin/overview' && r.auth === `Bearer ${adminTok}`));
      for (const tok of tokens) {
        const sig = tok.split('.')[2];
        assert.deepEqual(toEngine.filter((r) => r.auth.includes(sig) || r.body.includes(sig)).map((r) => r.path), [], 'browser sent an admin token to the engine');
        assert.deepEqual(inbound.filter((r) => !deliberate(r) && (r.auth.includes(sig) || r.body.includes(sig))).map((r) => r.path), [], 'an admin token arrived at the engine');
      }
      assert.ok(inbound.some((r) => r.path === '/api/growth/admin/sso/assertion' && !r.origin), 'the website server used the signed assertion');
    });
    await t.test('no browser errors; nothing left the test machine', async () => {
      console.log('aborted outside requests:', [...blocked].join(', ') || 'none');
      console.log('page errors:', JSON.stringify(pageErrors));
      // React #418 (hydration mismatch) is the website's existing admin guard rendering nothing for a signed-out visitor
      assert.deepEqual(pageErrors.filter((e) => !/Failed to fetch|NetworkError|Load failed|aborted/i.test(e.message) && !(/Minified React error #418/.test(e.message) && (e.phase === 'signed-out' || !/growth-engine/.test(e.url)))), []);
      assert.deepEqual([...blocked].filter((h) => /fantasymmadness|vercel\.app$/i.test(h)), []);
    });
  } finally {
    await browser.close().catch(() => {});
    for (const s of servers) s.close();
    await client.close();
  }
});
