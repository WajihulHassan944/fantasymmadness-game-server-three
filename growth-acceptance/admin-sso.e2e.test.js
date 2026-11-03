'use strict';
// End-to-end: website administrator login -> Growth Engine, with NO Growth Engine password.
// Real pieces only: the real website (fmm-ver2 built by Next.js), the REAL website backend
// (server.js via full-card-bootstrap, loopback-only, local MongoDB) issuing a real admin session
// through its real /admin/login, and the real Growth Engine (routes + runtime + console).
//   GROWTH_V2=sso-live    live-site build: the logged-in admin opens the Growth Engine directly
//   GROWTH_V2=sso-review  test-copy build: "My administrator account" sign-in (token discarded)
// Env: GROWTH_TEST_MONGO_URI, SITE_URL, GROWTH_V2, SSO_WEBSITE_API, SSO_JWT_SECRET_ADMIN, SSO_JWT_SECRET
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { MongoClient } = require('mongodb');
const { registerIsolatedGrowthRoutes } = require('../growth-isolated-routes');
const { hashPassword } = require('../growth-backoffice');
const { contestFeed } = require('../growth-contest-feed.fixture');
const { PROBE_PATH } = require('../growth-admin-sso');

const uri = process.env.GROWTH_TEST_MONGO_URI;
const SITE = process.env.SITE_URL;
const MODE = process.env.GROWTH_V2;
const WEBSITE_API = process.env.SSO_WEBSITE_API || 'http://127.0.0.1:5071';
const ADMIN_SECRET = process.env.SSO_JWT_SECRET_ADMIN;
const PLAYER_SECRET = process.env.SSO_JWT_SECRET;
let chromium = null; try { ({ chromium } = require('playwright')); } catch { /* optional */ }
const skip = !['sso-live', 'sso-review'].includes(MODE) ? 'only for the website-admin sign-in builds' : (!uri || !SITE || !chromium || !ADMIN_SECRET ? 'needs MongoDB, the site, the website backend and playwright' : false);
const ENGINE = 'http://127.0.0.1:4300';
const ADMIN = { email: 'owner@fmm-sso.test', password: 'website admin password (test only)' };
const SHOTS = process.env.GROWTH_CONSOLE_SCREENSHOTS;
const feed = contestFeed();
const fetchImpl = async (url, opts) => {
  if (String(url).startsWith(WEBSITE_API)) return fetch(url, opts); // the live-backend check goes to the real website backend
  const f = feed(url); if (f) return f;
  const term = new URL(url).searchParams.get('term') || 'x';
  return { ok: true, status: 200, json: async () => ({ results: [1, 2].map((n) => ({ collectionName: `${term} show ${n}`, collectionViewUrl: `https://podcasts.apple.com/us/podcast/x-${n}/id${n}` })) }) };
};
const SECTIONS = ['overview', 'approvals', 'marketing', 'pr', 'affiliates', 'publishing', 'automation', 'analytics', 'revenue', 'connections'];
const ENDPOINTS = ['/admin/session', '/admin/overview', '/admin/status', '/admin/drafts?kind=marketing', '/admin/workstreams', '/admin/analytics', '/admin/attribution', '/admin/executive', '/admin/funnel', '/admin/research?track=pr', '/admin/research?track=affiliate',
  '/admin/social', '/admin/social/capabilities', '/admin/posters', '/admin/fighter-assets', '/admin/connections', '/admin/email/sandbox', '/admin/email/readiness', '/admin/alerts?state=all', '/admin/jobs', '/admin/runs', '/admin/reports', '/admin/audit', '/admin/suppressions', '/admin/prospects', '/admin/marketing/coverage', '/admin/affiliates', '/admin/meta'];
const decode = (t) => JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString());

test(`website administrator -> Growth Engine sign-in (${MODE})`, { skip, timeout: 420000 }, async (t) => {
  const client = await new MongoClient(uri).connect();
  await client.db('fmgrowthtest').dropDatabase();
  // the website's own administrator account, created the way the website stores it (bcrypt)
  const bcrypt = require('bcrypt');
  const site = client.db('fmm_sso_website');
  await site.collection('admins').deleteMany({});
  await site.collection('admins').insertOne({ email: ADMIN.email, password: bcrypt.hashSync(ADMIN.password, 10) });
  const baseEnv = { GROWTH_STAGING_MODE: 'isolated', GROWTH_OUTBOUND_ENABLED: 'false', GROWTH_TEST_MONGO_URI: uri, JWT_SECRET_ADMIN: ADMIN_SECRET, GROWTH_UNSUBSCRIBE_SECRET: 's'.repeat(48), CRON_SECRET: 'cron-secret-for-tests-only',
    GROWTH_DELIVERY_PROVIDER: 'none', GROWTH_ADMIN_PASSWORD_HASH: hashPassword('growth engine password that is never typed in this test'), GROWTH_SOCIAL_PROVIDER: 'sandbox', GROWTH_CONSOLE_EMBED_ORIGINS: SITE,
    GROWTH_SSO_VERIFY_URL: WEBSITE_API, GROWTH_SSO_ALLOW_LOOPBACK: 'true' };
  const servers = [];
  const startEngine = async (port, env) => {
    const app = express();
    app.use(cors({ origin: (o, cb) => (!o || [SITE, ENGINE].includes(o) ? cb(null, true) : cb(new Error('Not allowed by CORS'))), credentials: true }));
    const m = registerIsolatedGrowthRoutes({ app, env: { ...baseEnv, ...env }, express, fetchImpl, connect: async () => client });
    assert.equal(m.mounted, true, JSON.stringify(m.errors));
    const rt = await m.getRuntime();
    servers.push(app.listen(port, '127.0.0.1'));
    return { rt, url: `http://127.0.0.1:${port}/api/growth` };
  };
  const main = await startEngine(4300, {});
  await main.rt.tick({ now: new Date(Date.now() - 60 * 60000) });
  const call = async (base, method, p, token, body) => { const r = await fetch(`${base}${p}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, json: j }; };
  const websiteLogin = async (password = ADMIN.password) => { const r = await fetch(`${WEBSITE_API}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ADMIN.email, password }) }); return { status: r.status, json: await r.json().catch(() => null) }; };

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const blocked = new Set(); const websiteCalls = []; const ssoCalls = [];
  await ctx.route('**/*', (route) => {
    const req = route.request(); const u = new URL(req.url());
    if (u.origin === WEBSITE_API) websiteCalls.push({ method: req.method(), path: u.pathname, auth: Boolean(req.headers().authorization) });
    if (u.origin === ENGINE && u.pathname === '/api/growth/admin/sso') ssoCalls.push(req.method());
    if ([SITE, ENGINE, WEBSITE_API].includes(u.origin) || u.protocol === 'data:') return route.continue();
    blocked.add(u.host); return route.abort();
  });
  await ctx.addInitScript(() => { try { window.sessionStorage.setItem('jarvisGreeted', '1'); window.sessionStorage.setItem('adminPushAsked', '1'); } catch (e) { /* ignore */ } });
  const page = await ctx.newPage(); page.setDefaultTimeout(30000);
  const pageErrors = []; page.on('pageerror', (e) => pageErrors.push(e.message));
  const shot = (name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, `${MODE}-${name}.jpg`), type: 'jpeg', quality: 70 }) : null);
  const frame = () => page.frameLocator('[data-testid=ge-frame]');
  const growthSession = () => page.evaluate(() => window.sessionStorage.getItem('fmmGrowthBridgeToken'));
  try {
    if (MODE === 'sso-live') {
      await t.test('real website admin login, then the Growth Engine opens with NO Growth Engine password', async () => {
        await page.goto(`${SITE}/administration/login`);
        await page.fill('input[type=email]', ADMIN.email);
        await page.fill('input[type=password]', ADMIN.password);
        await page.click('.admin-login-submit');
        await page.waitForURL((u) => /\/administration/.test(u.pathname) && !/login/.test(u.pathname));
        assert.ok(websiteCalls.some((c) => c.method === 'POST' && c.path === '/admin/login'), 'the real website login was used');
        const websiteToken = await page.evaluate(() => window.localStorage.getItem('adminAuthToken'));
        assert.equal(decode(websiteToken).email, ADMIN.email);
        await page.goto(`${SITE}/administration/growth-engine/approvals`);
        await frame().locator('[data-testid=page-approvals]').waitFor();
        assert.equal(await frame().locator('[data-testid=login-password]').count(), 0, 'Growth Engine password asked');
        assert.ok(ssoCalls.includes('POST'), 'the website session was exchanged');
        const p = decode(await growthSession());
        assert.deepEqual([p.method, p.scope, p.email, p.aud], ['website_admin', 'growth', ADMIN.email, 'fmm-growth-console']);
        assert.ok(p.exp - p.iat <= 1800, 'short-lived');
        await shot('signed-in-with-website-admin');
      });
      await t.test('all ten Growth Engine sections work in the website back office', async () => {
        for (const s of SECTIONS) {
          await page.click(`[data-testid=ge-tab-${s}]`);
          await frame().locator(`[data-testid=page-${s}]`).waitFor();
          assert.equal(await frame().locator('[data-testid=page-error]').count(), 0, `error on ${s}`);
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
        const d = await client.db('fmgrowthtest').collection('growth_drafts').findOne({ id });
        assert.equal(d.status, 'approved'); assert.equal(d.approvedBy, ADMIN.email);
        assert.ok(await client.db('fmgrowthtest').collection('growth_audit_log').findOne({ action: 'sso_login', admin: ADMIN.email, method: 'website_admin', issuerConfirmed: true }));
      });
      await t.test('an ended Growth Engine session is renewed from the website session (no password)', async () => {
        const before = ssoCalls.length;
        await page.evaluate(() => window.sessionStorage.setItem('fmmGrowthBridgeToken', 'expired.or.garbage'));
        await page.goto(`${SITE}/administration/growth-engine/marketing`);
        await frame().locator('[data-testid=page-marketing]').waitFor();
        assert.ok(ssoCalls.length > before); assert.equal(await frame().locator('[data-testid=login-password]').count(), 0);
      });
      await t.test('a forged website admin session is refused and sent back to the website login', async () => {
        await page.evaluate((f) => { window.localStorage.setItem('adminAuthToken', f); window.sessionStorage.removeItem('fmmGrowthBridgeToken'); }, jwt.sign({ id: '65f0c0ffee0000000000abcd', email: ADMIN.email }, 'f'.repeat(48), { expiresIn: '1h' }));
        await page.goto(`${SITE}/administration/growth-engine/overview`);
        await page.waitForURL(/\/administration\/login\?reason=session-expired/);
        assert.equal(await growthSession(), null, 'no Growth Engine session from a forged token');
      });
      await t.test('signed out of the website = no Growth Engine access', async () => {
        await page.evaluate(() => { window.localStorage.removeItem('adminAuthToken'); window.sessionStorage.removeItem('fmmGrowthBridgeToken'); });
        await page.goto(`${SITE}/administration/growth-engine/overview`);
        await page.waitForURL(/\/administration\/login/);
      });
    } else {
      await t.test('test copy: "My administrator account" opens the Growth Engine; the website token is not kept', async () => {
        await page.goto(`${SITE}/administration/login?next=${encodeURIComponent('/administration/growth-engine/approvals')}`);
        await page.waitForSelector('[data-testid=staging-admin-form]');
        await page.fill('[data-testid=staging-admin-email]', ADMIN.email);
        await page.fill('[data-testid=staging-admin-password]', 'wrong password');
        await page.click('[data-testid=staging-admin-submit]');
        await page.waitForSelector('[data-testid=staging-login-error]');
        assert.equal(await growthSession(), null);
        await page.fill('[data-testid=staging-admin-password]', ADMIN.password);
        await page.click('[data-testid=staging-admin-submit]');
        await page.waitForURL(/\/administration\/growth-engine\/approvals$/);
        await frame().locator('[data-testid=page-approvals]').waitFor();
        assert.equal(await frame().locator('[data-testid=login-password]').count(), 0);
        assert.equal(decode(await growthSession()).method, 'website_admin');
        assert.equal(await page.evaluate(() => window.localStorage.getItem('adminAuthToken')), null, 'website admin token kept in the test copy');
        // the only call to the website backend was the sign-in itself (no admin pages, no writes)
        const sensitive = websiteCalls.filter((c) => c.method !== 'OPTIONS' && (c.auth || c.method !== 'GET' || /admin/i.test(c.path)));
        assert.deepEqual(sensitive.map((c) => `${c.method} ${c.path}${c.auth ? ' +auth' : ''}`), ['POST /admin/login', 'POST /admin/login'], 'test copy used the website admin session for something else');
        await shot('test-copy-signed-in-with-admin-account');
        for (const s of SECTIONS) { await page.click(`[data-testid=ge-tab-${s}]`); await frame().locator(`[data-testid=page-${s}]`).waitFor(); }
      });
    }

    // ---------- server-side security (both builds) ----------
    const login = await websiteLogin();
    assert.equal(login.status, 200);
    const websiteToken = login.json.token;
    const ex = await call(main.url, 'POST', '/admin/sso', websiteToken);
    const session = ex.json && ex.json.token;
    await t.test('every original Growth Engine endpoint works with the website-admin session', async () => {
      assert.equal(ex.status, 200, JSON.stringify(ex.json)); assert.deepEqual(ex.json.verification, { issuerConfirmed: true, signatureVerifiedLocally: true });
      for (const p of ENDPOINTS) { const r = await call(main.url, 'GET', p, session); assert.equal(r.status, 200, `${p} -> ${r.status}`); }
      assert.equal((await call(main.url, 'GET', '/admin/session', session)).json.method, 'website_admin');
    });
    await t.test('refused: no session, website token used directly, forged/expired/player/console-free tokens; Growth Engine session useless on the website', async () => {
      assert.equal((await call(main.url, 'GET', '/admin/overview')).status, 401);
      assert.equal((await call(main.url, 'GET', '/admin/overview', websiteToken)).status, 401, 'website token is not a Growth Engine session');
      assert.equal((await fetch(`${WEBSITE_API}${PROBE_PATH}`, { headers: { Authorization: `Bearer ${session}` } })).status, 401, 'Growth Engine session accepted by the website backend');
      assert.equal((await fetch(`${WEBSITE_API}${PROBE_PATH}`, { headers: { Authorization: `Bearer ${websiteToken}` } })).status, 404, 'sanity: the website backend accepts its own admin session');
      const bad = [
        [jwt.sign({ id: '65f0c0ffee0000000000abcd', email: ADMIN.email }, 'f'.repeat(48), { expiresIn: '1h' }), 'website_rejected_this_admin_session'],
        [jwt.sign({ id: '65f0c0ffee0000000000abcd', email: ADMIN.email }, ADMIN_SECRET, { expiresIn: -5 }), 'website_admin_session_expired'],
        [jwt.sign({ id: '65f0c0ffee0000000000abcd', scope: 'player' }, PLAYER_SECRET, { expiresIn: '1h' }), 'not_a_website_admin_session'],
        [session, 'not_a_website_admin_session'],
      ];
      for (const [tok, reason] of bad) { const r = await call(main.url, 'POST', '/admin/sso', tok); assert.equal(r.status === 401 || r.status === 403, true); assert.equal(r.json.reason, reason); }
      assert.equal((await websiteLogin('wrong')).status, 400, 'website login itself unchanged');
    });
    await t.test('fails closed when the website cannot confirm; allow-list; different local secret still verified by the website', async () => {
      const down = await startEngine(4301, { GROWTH_SSO_VERIFY_URL: 'http://127.0.0.1:9' });
      const r1 = await call(down.url, 'POST', '/admin/sso', websiteToken); assert.equal(r1.status, 503); assert.equal(r1.json.reason, 'website_unreachable_try_again');
      const allow = await startEngine(4302, { GROWTH_SSO_ALLOWED_ADMINS: 'someone.else@fmm-sso.test' });
      assert.equal((await call(allow.url, 'POST', '/admin/sso', websiteToken)).json.reason, 'admin_not_allowed_for_growth_engine');
      const other = await startEngine(4303, { JWT_SECRET_ADMIN: 'z'.repeat(48) });
      const r3 = await call(other.url, 'POST', '/admin/sso', websiteToken);
      assert.equal(r3.status, 200); assert.equal(r3.json.verification.signatureVerifiedLocally, false);
    });
    await t.test('rollback: GROWTH_SSO=off disables website sign-in; the Growth Engine password still works', async () => {
      const off = await startEngine(4304, { GROWTH_SSO: 'off', GROWTH_ADMIN_PASSWORD_HASH: hashPassword('rollback password') });
      assert.equal((await call(off.url, 'POST', '/admin/sso', websiteToken)).json.reason, 'sso_not_configured');
      const pw = await call(off.url, 'POST', '/admin/login', null, { password: 'rollback password' });
      assert.equal(pw.status, 200); assert.equal((await call(off.url, 'GET', '/admin/session', pw.json.token)).json.method, 'console_password');
    });
    await t.test('sandbox campaign under the website-admin session: schedule, publish (sandbox), no duplicates, no real post', async () => {
      const d = (await call(main.url, 'GET', '/admin/drafts?kind=marketing&status=approved', session)).json.drafts[0]
        || (await (async () => { const x = (await call(main.url, 'GET', '/admin/drafts?kind=marketing&status=needs_owner_review', session)).json.drafts[0]; await call(main.url, 'POST', `/admin/drafts/${encodeURIComponent(x.id)}/approve`, session, {}); return x; })());
      const s1 = await call(main.url, 'POST', `/admin/drafts/${encodeURIComponent(d.id)}/schedule`, session, { channels: ['facebook'], scheduledAt: new Date(Date.now() + 60000).toISOString() });
      assert.equal(s1.status, 200, JSON.stringify(s1.json));
      assert.match((await call(main.url, 'POST', `/admin/drafts/${encodeURIComponent(d.id)}/schedule`, session, { channels: ['facebook'], scheduledAt: new Date(Date.now() + 60000).toISOString() })).json.results[0].reason, /^already_/);
      const out = await main.rt.social.dispatch(new Date(Date.now() + 3 * 60000));
      assert.equal(out.published, 1);
      const posts = await client.db('fmgrowthtest').collection('growth_social_posts').find({ draftId: d.id }).toArray();
      assert.ok(posts.every((p) => p.status !== 'published' || p.sandbox === true));
      assert.equal(posts[0].scheduledBy, ADMIN.email);
    });
    await t.test('no browser errors; nothing left the test machine', async () => {
      assert.deepEqual(pageErrors.filter((m) => !/Failed to fetch|NetworkError|Load failed|aborted/i.test(m)), []);
      assert.deepEqual([...blocked].filter((h) => !/fonts\.|googletagmanager|google-analytics|vercel-insights|vitals/.test(h)), []);
    });
  } finally {
    await browser.close().catch(() => {});
    for (const s of servers) s.close();
    await client.close();
  }
});
