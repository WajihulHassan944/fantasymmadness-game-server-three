'use strict';
// End-to-end test of the TEST back office in staging review mode (fmm-ver2 built with
// NEXT_PUBLIC_ADMIN_STAGING_REVIEW=on). The test copy signs in with the Growth Engine owner
// password against a real Growth Engine on loopback MongoDB, never asks for or sends live
// admin credentials, hands its session to the embedded console (one sign-in), and never
// opens screens or server routes that use live admin data. Every request to any other host
// is blocked; the live API base is a dead loopback address (127.0.0.1:9).
// Env: GROWTH_TEST_MONGO_URI, SITE_URL (next start), GROWTH_V2=review, GROWTH_CONSOLE_SCREENSHOTS
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const { registerIsolatedGrowthRoutes } = require('../growth-isolated-routes');
const { hashPassword } = require('../growth-backoffice');
const { contestFeed } = require('../growth-contest-feed.fixture');

const uri = process.env.GROWTH_TEST_MONGO_URI;
const SITE = process.env.SITE_URL;
let chromium = null; try { ({ chromium } = require('playwright')); } catch { /* optional */ }
const skip = process.env.GROWTH_V2 !== 'review' ? 'only for the staging review build' : (!uri || !SITE || !chromium ? 'needs loopback MongoDB, a running site and playwright' : false);
const ENGINE = 'http://127.0.0.1:4300';
const LIVE_API = 'http://127.0.0.1:9';
const PASSWORD = 'staging review test password (test only)';
const SHOTS = process.env.GROWTH_CONSOLE_SCREENSHOTS;
const feed = contestFeed();
const fetchImpl = async (url) => { const f = feed(url); if (f) return f; const term = new URL(url).searchParams.get('term') || 'x'; const slug = term.replace(/[^a-z]+/gi, '-').toLowerCase(); return { ok: true, status: 200, json: async () => ({ results: [1, 2].map((n) => ({ collectionName: `${term} show ${n}`, collectionViewUrl: `https://podcasts.apple.com/us/podcast/${slug}-${n}/id${n}` })) }) }; };
const SECTIONS = ['overview', 'approvals', 'marketing', 'pr', 'affiliates', 'publishing', 'automation', 'analytics', 'revenue', 'connections'];

test('test back office — staging sign-in (no live admin access)', { skip, timeout: 300000 }, async (t) => {
  const client = await new MongoClient(uri).connect();
  await client.db('fmgrowthtest').dropDatabase();
  const env = { GROWTH_STAGING_MODE: 'isolated', GROWTH_OUTBOUND_ENABLED: 'false', GROWTH_TEST_MONGO_URI: uri, JWT_SECRET_ADMIN: 's'.repeat(48), GROWTH_UNSUBSCRIBE_SECRET: 's'.repeat(48), CRON_SECRET: 'cron-secret-for-tests-only', GROWTH_DELIVERY_PROVIDER: 'none', GROWTH_ADMIN_PASSWORD_HASH: hashPassword(PASSWORD), GROWTH_SOCIAL_PROVIDER: 'sandbox', GROWTH_CONSOLE_EMBED_ORIGINS: SITE };
  const engine = express();
  engine.use(cors({ origin: (o, cb) => (!o || [SITE, ENGINE].includes(o) ? cb(null, true) : cb(new Error('Not allowed by CORS'))), credentials: true }));
  const mounted = registerIsolatedGrowthRoutes({ app: engine, env, express, fetchImpl, connect: async () => client });
  const runtime = await mounted.getRuntime();
  await runtime.tick({ now: new Date(Date.now() - 60 * 60000) });
  const engineServer = engine.listen(4300, '127.0.0.1');
  const browser = await chromium.launch();
  const blocked = new Set();
  const liveCalls = []; // anything the page tried to send to the live API base
  const ctx = await browser.newContext();
  await ctx.route('**/*', (route) => {
    const req = route.request(); const u = new URL(req.url());
    if (u.origin === LIVE_API) { liveCalls.push({ method: req.method(), path: u.pathname, auth: Boolean(req.headers().authorization) }); return route.abort(); }
    if (u.origin === SITE || u.origin === ENGINE || u.protocol === 'data:') return route.continue();
    blocked.add(u.host); return route.abort();
  });
  const page = await ctx.newPage();
  const pageErrors = []; page.on('pageerror', (e) => pageErrors.push(e.message));
  const shot = (name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, `review-${name}.jpg`), fullPage: false, type: 'jpeg', quality: 70 }) : null);
  const frame = () => page.frameLocator('[data-testid=ge-frame]');
  try {
    await t.test('without a session every admin page goes to the staging sign-in (Growth Engine only: admin account or Growth Engine password)', async () => {
      await page.goto(`${SITE}/administration/growth-engine/marketing`);
      await page.waitForURL(/\/administration\/login\?next=/);
      await page.waitForSelector('[data-testid=staging-review-login]');
      assert.match(await page.textContent('[data-testid=staging-review-login]'), /only the Growth Engine/);
      assert.match(await page.textContent('[data-testid=staging-review-login]'), /not kept in this test copy/);
      await page.click('[data-testid=staging-mode-password]');
      assert.equal(await page.locator('input[type=email]').count(), 0, 'email field on the password tab');
      assert.match(await page.textContent('[data-testid=staging-review-login]'), /Growth Engine password/);
      await shot('login');
    });

    await t.test('a live admin token left in the browser is ignored and removed', async () => {
      await page.evaluate(() => window.localStorage.setItem('adminAuthToken', 'live-admin-token-planted-by-test'));
      await page.goto(`${SITE}/administration/fights`);
      await page.waitForURL(/\/administration\/login/);
      await page.waitForSelector('[data-testid=staging-review-login]');
      assert.equal(await page.evaluate(() => window.localStorage.getItem('adminAuthToken')), null, 'live token kept');
    });

    await t.test('wrong password is refused with a clear message', async () => {
      await page.click('[data-testid=staging-mode-password]');
      await page.fill('[data-testid=staging-password]', 'not the password');
      await page.click('[data-testid=staging-login-submit]');
      await page.waitForSelector('[data-testid=staging-login-error]');
      assert.match(await page.textContent('[data-testid=staging-login-error]'), /not the Growth Engine password/);
    });

    await t.test('correct password opens the Growth Engine; the console is signed in automatically (one sign-in)', async () => {
      await page.goto(`${SITE}/administration/login?next=${encodeURIComponent('/administration/growth-engine/approvals')}`);
      await page.click('[data-testid=staging-mode-password]');
      await page.fill('[data-testid=staging-password]', PASSWORD);
      await page.click('[data-testid=staging-login-submit]');
      await page.waitForURL(/\/administration\/growth-engine\/approvals$/);
      await frame().locator('[data-testid=page-approvals]').waitFor({ timeout: 30000 });
      assert.equal(await frame().locator('[data-testid=login-password]').count(), 0, 'console asked for a second password');
      await shot('signed-in');
    });

    await t.test('all ten Growth Engine sections work inside the test back office', async () => {
      for (const s of SECTIONS) {
        await page.click(`[data-testid=ge-tab-${s}]`);
        await frame().locator(`[data-testid=page-${s}]`).waitFor();
        await frame().locator('main .spinner').first().waitFor({ state: 'detached' }); await frame().locator('main .spinner').last().waitFor({ state: 'detached' });
        assert.equal(await frame().locator('[data-testid=page-error]').count(), 0, `error on ${s}`);
      }
      // A real staging action from inside the test back office
      await page.click('[data-testid=ge-tab-approvals]');
      const id = await frame().locator('[data-testid=draft]').first().getAttribute('data-draft-id');
      await frame().locator(`[data-draft-id="${id}"] [data-testid=btn-approve]`).click();
      await frame().locator('[data-testid=modal-confirm]').click();
      await frame().locator(`[data-draft-id="${id}"]`).waitFor({ state: 'detached' });
      assert.equal((await client.db('fmgrowthtest').collection('growth_drafts').findOne({ id })).status, 'approved');
    });

    await t.test('the session survives a reload; the dashboard address opens the Growth Engine', async () => {
      await page.goto(`${SITE}/administration/growth-engine/analytics`);
      await frame().locator('[data-testid=page-analytics]').waitFor({ timeout: 30000 });
      await page.goto(`${SITE}/administration`);
      await page.waitForURL(/\/administration\/growth-engine$/);
    });

    await t.test('screens that use live data are not opened (fights, payouts, players, Fight Launch Desk, revenue)', async () => {
      for (const p of ['/administration/fights', '/administration/payouts', '/administration/RegisteredUsers', '/administration/growth', '/administration/revenue', '/administration/AffiliateUsers']) {
        await page.goto(`${SITE}${p}`);
        await page.waitForSelector('[data-testid=staging-review-notice]', { timeout: 20000 });
        assert.ok(page.url().endsWith(p), `${p} -> ${page.url()}`);
      }
      await shot('notice');
    });

    await t.test("the test copy's own server routes never forward admin requests to production", async () => {
      for (const [m, p] of [['GET', '/api/admin/affiliate-network'], ['GET', '/api/admin/affiliate-invites'], ['POST', '/api/admin/swarm/jobs'], ['GET', '/api/admin/wrestling/events'], ['POST', '/api/founder-upload']]) {
        const r = await fetch(`${SITE}${p}`, { method: m, headers: { Authorization: 'Bearer live-admin-token-planted-by-test', 'Content-Type': 'application/json' }, body: m === 'POST' ? '{}' : undefined });
        assert.equal(r.status, 403, `${m} ${p} -> ${r.status}`);
        assert.equal((await r.json()).code, 'STAGING_REVIEW');
      }
    });

    await t.test('sign out ends the test session', async () => {
      await page.goto(`${SITE}/administration/growth-engine`);
      await frame().locator('[data-testid=page-overview]').waitFor({ timeout: 30000 });
      await page.click('.admin-command-footer button');
      await page.waitForURL(/\/administration\/login/);
      await page.goto(`${SITE}/administration/growth-engine`);
      await page.waitForURL(/\/administration\/login/);
    });

    await t.test('nothing was sent to the live API with credentials, and nothing was changed there', async () => {
      console.log('live API calls:', JSON.stringify(liveCalls));
      assert.deepEqual(liveCalls.filter((c) => c.auth), [], 'admin credentials sent to the live API');
      assert.deepEqual(liveCalls.filter((c) => c.method !== 'GET' && c.path !== '/track-click'), [], 'write request sent to the live API');
      assert.equal(liveCalls.filter((c) => /\/admin\//.test(c.path)).length, 0, 'admin endpoint called on the live API');
      assert.deepEqual(pageErrors.filter((m) => !/Failed to fetch|NetworkError|Load failed|aborted/i.test(m)), []);
      console.log('blocked outside hosts:', [...blocked].join(', ') || 'none');
    });
  } finally {
    await ctx.close(); await browser.close(); engineServer.close(); await client.close();
  }
});
