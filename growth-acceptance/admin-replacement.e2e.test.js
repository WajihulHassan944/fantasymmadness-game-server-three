'use strict';
// End-to-end test of the website back office with the Growth Engine replacement
// (fmm-ver2, branch test/growth-engine-replacement, built on the live website code), built and served by Next.js,
// against a real Growth Engine on loopback MongoDB. Every request to any other host
// (including the live backend) is blocked, so production is never contacted.
//   GROWTH_V2=on  -> one Growth Engine command center replaces the retired screens
//   GROWTH_V2=off -> rollback: the previous menu and screens, unchanged
// Env: GROWTH_TEST_MONGO_URI, SITE_URL (next start), GROWTH_V2, GROWTH_CONSOLE_SCREENSHOTS
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
const V2 = process.env.GROWTH_V2 !== 'off';
let chromium = null; try { ({ chromium } = require('playwright')); } catch { /* optional */ }
const skip = process.env.GROWTH_V2 === 'review' ? 'staging review build: see staging-review.e2e.test.js' : (!uri || !SITE || !chromium ? 'needs loopback MongoDB, a running site and playwright' : false);
const ENGINE = 'http://127.0.0.1:4300';
const PASSWORD = 'replacement test password (test only)';
const SHOTS = process.env.GROWTH_CONSOLE_SCREENSHOTS;
const feed = contestFeed();
const fetchImpl = async (url) => { const f = feed(url); if (f) return f; const term = new URL(url).searchParams.get('term') || 'x'; const slug = term.replace(/[^a-z]+/gi, '-').toLowerCase(); return { ok: true, status: 200, json: async () => ({ results: [1, 2].map((n) => ({ collectionName: `${term} show ${n}`, collectionViewUrl: `https://podcasts.apple.com/us/podcast/${slug}-${n}/id${n}` })) }) }; };
const SECTIONS = ['overview', 'approvals', 'marketing', 'pr', 'affiliates', 'publishing', 'automation', 'analytics', 'revenue', 'connections'];
// Legacy automation audit (Nov 2026): obsolete, broken and display-only screens are hidden
// from the V2 menu; the working Fight Launch Desk is kept inside the Growth Engine group.
const RETIRED_LABELS = ['July 10K growth', 'This Week’s Three Fights', 'Growth Engine (staging)', 'Swarm command center', 'SEO growth center', 'Content assistants', 'Social publishing', 'Blog & SEO automation'];
const LEGACY_ONLY_LABELS = ['Fight Launch Desk', 'July 10K growth', 'This Week’s Three Fights', 'Swarm command center', 'SEO growth center', 'Content assistants', 'Social publishing'];
const PRESERVED_LABELS = ['Fight registry', 'Create fight', 'Registered users', 'Affiliate users', 'Payouts', 'Wrestling registry', 'Jarvis AI assistant', 'Blogs', 'Support tickets'];

test(`admin back office — Growth Engine ${V2 ? 'replacement' : 'rollback'}`, { skip, timeout: 300000 }, async (t) => {
  const client = await new MongoClient(uri).connect();
  await client.db('fmgrowthtest').dropDatabase();
  const env = { GROWTH_STAGING_MODE: 'isolated', GROWTH_OUTBOUND_ENABLED: 'false', GROWTH_TEST_MONGO_URI: uri, JWT_SECRET_ADMIN: 's'.repeat(48), GROWTH_UNSUBSCRIBE_SECRET: 's'.repeat(48), CRON_SECRET: 'cron-secret-for-tests-only', GROWTH_DELIVERY_PROVIDER: 'none', GROWTH_ADMIN_PASSWORD_HASH: hashPassword(PASSWORD), GROWTH_SOCIAL_PROVIDER: 'sandbox', GROWTH_CONSOLE_EMBED_ORIGINS: SITE };
  const engine = express();
  engine.use(cors({ origin: (o, cb) => (!o || [SITE, ENGINE].includes(o) ? cb(null, true) : cb(new Error('Not allowed by CORS'))), credentials: true })); // as server.js + CORS_ORIGINS (admin site + the engine's own address)
  const mounted = registerIsolatedGrowthRoutes({ app: engine, env, express, fetchImpl, connect: async () => client });
  const runtime = await mounted.getRuntime();
  await runtime.tick({ now: new Date(Date.now() - 60 * 60000) });
  let engineServer = engine.listen(4300, '127.0.0.1');
  const browser = await chromium.launch();
  const blocked = new Set();
  const newContext = async (opts = {}) => {
    const ctx = await browser.newContext(opts);
    await ctx.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (u.origin === SITE || u.origin === ENGINE || u.protocol === 'data:') return route.continue();
      blocked.add(u.host); return route.abort();
    });
    return ctx;
  };
  const asAdmin = async (ctx) => ctx.addInitScript(() => { try { window.localStorage.setItem('adminAuthToken', 'test-admin-token'); window.sessionStorage.setItem('jarvisGreeted', '1'); window.sessionStorage.setItem('adminPushAsked', '1'); } catch (e) { /* ignore */ } });
  const shot = (page, name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, `${V2 ? 'v2' : 'rollback'}-${name}.jpg`), fullPage: false, type: 'jpeg', quality: 70 }) : null);
  const navText = async (page) => {
    await page.waitForSelector('.admin-command-nav');
    for (const b of await page.$$('.admin-command-group-toggle[aria-expanded="false"]')) await b.click();
    return page.textContent('.admin-command-nav');
  };
  try {
    await t.test('permissions: without an admin session the back office redirects to admin login', async () => {
      const ctx = await newContext(); const page = await ctx.newPage();
      await page.goto(`${SITE}/administration/growth-engine/marketing`);
      await page.waitForURL(/\/administration\/login/, { timeout: 30000 });
      await ctx.close();
    });

    const ctx = await newContext({ viewport: { width: 1400, height: 900 } }); await asAdmin(ctx);
    const page = await ctx.newPage();
    const pageErrors = []; page.on('pageerror', (e) => pageErrors.push(e.message));

    await t.test('navigation: retired growth screens gone (V2) / present (rollback); working tools preserved', async () => {
      await page.goto(`${SITE}/administration`);
      const nav = await navText(page);
      for (const l of PRESERVED_LABELS) assert.ok(nav.includes(l), `missing preserved menu item: ${l}`);
      if (V2) {
        for (const l of RETIRED_LABELS) assert.ok(!nav.includes(l), `retired item still in menu: ${l}`);
        for (const l of ['Growth Engine', 'Campaign approvals', 'Marketing', 'Public relations', 'Affiliate recruitment', 'Publishing', 'Automation', 'Analytics', 'Revenue attribution', 'Connections', 'Fight Launch Desk (posters & QR)']) assert.ok(nav.includes(l), `missing ${l}`);
        await page.waitForSelector('[data-testid=growth-engine-panel]');
        const dash = await page.textContent('main');
        assert.ok(!/FAN ACQUISITION COMMAND CENTER|Fan Acquisition Swarm|Swarm automation|SEO growth center/.test(dash), 'retired dashboard entries remain');
        assert.match(dash, /Fight Launch Desk/, 'working Fight Launch Desk shortcut kept');
        assert.match(dash, /Revenue Command Center/);
      } else {
        for (const l of LEGACY_ONLY_LABELS) assert.ok(nav.includes(l), `rollback lost ${l}`);
        assert.ok(!nav.includes('Campaign approvals') && !nav.includes('Growth Engine'), 'rollback still shows the new group');
        assert.match(await page.textContent('main'), /FAN ACQUISITION COMMAND CENTER/);
      }
      await shot(page, 'dashboard');
    });

    await t.test('replaced routes redirect to the matching Growth Engine section (V2) / still work (rollback)', async () => {
      const cases = { '/administration/fan-acquisition': 'pr', '/administration/july-growth': '', '/administration/MakePost': 'publishing', '/administration/tweet': 'publishing', '/administration/tiktok': 'publishing' };
      for (const [from, to] of Object.entries(cases)) {
        await page.goto(`${SITE}${from}`);
        if (V2) await page.waitForURL(new RegExp(`/administration/growth-engine${to ? `/${to}` : ''}$`), { timeout: 20000 });
        else { await page.waitForTimeout(1500); assert.ok(page.url().endsWith(from), `rollback redirected ${from}`); }
      }
    });

    await t.test('Fight Launch Desk kept: posters & QR desk loads; weekly draft generator only in rollback', async () => {
      await page.goto(`${SITE}/administration/growth`);
      await page.waitForSelector('.admin-command-nav', { timeout: 20000 });
      await page.waitForTimeout(1500);
      assert.ok(page.url().endsWith('/administration/growth'), `Fight Launch Desk redirected to ${page.url()}`);
      assert.match(await page.title(), /Fight Launch Desk/);
      await shot(page, 'fight-launch-desk');
    });

    await t.test('working admin pages and the shared affiliate fight-launch page still load', async () => {
      for (const p of ['/administration/fights', '/administration/RegisteredUsers', '/administration/AffiliateUsers', '/administration/payouts', '/administration/revenue', '/administration/seo-growth', '/administration/swarm', '/administration/blogs', '/administration/YoutubeArchive', '/administration/jarvis']) {
        const r = await page.goto(`${SITE}${p}`);
        assert.ok(r.status() < 400, `${p} -> ${r.status()}`);
        await page.waitForSelector('.admin-command-nav', { timeout: 20000 });
        assert.ok(page.url().endsWith(p), `${p} redirected to ${page.url()}`);
      }
      const r = await page.goto(`${SITE}/affiliate/fight-launch`);
      assert.ok(r.status() < 400, 'affiliate fight-launch page');
    });

    if (V2) {
      await t.test('command center: embedded console, its own sign-in, all ten sections, menu stays in sync', async () => {
        await page.goto(`${SITE}/administration/growth-engine`);
        await page.waitForSelector('[data-testid=ge-frame]');
        const frame = page.frameLocator('[data-testid=ge-frame]');
        await frame.locator('[data-testid=login-password]').fill(PASSWORD);
        await frame.locator('[data-testid=login-submit]').click();
        await frame.locator('[data-testid=page-overview]').waitFor();
        assert.equal(await frame.locator('.sidenav').isVisible(), false, 'console sidebar hidden when embedded');
        await shot(page, 'command-center');
        for (const s of SECTIONS) {
          await page.click(`[data-testid=ge-tab-${s}]`);
          await frame.locator(`[data-testid=page-${s}]`).waitFor();
          await frame.locator('main .spinner').first().waitFor({ state: 'detached' }); await frame.locator('main .spinner').last().waitFor({ state: 'detached' });
          assert.equal(await frame.locator('[data-testid=page-error]').count(), 0, `error on ${s}`);
          assert.equal(await page.getAttribute(`[data-testid=ge-tab-${s}]`, 'aria-current'), 'page');
        }
        // Navigating inside the console updates the admin URL + active menu item
        await page.click('[data-testid=ge-tab-overview]'); await frame.locator('[data-testid=page-overview]').waitFor();
        await frame.locator('[data-testid=tile-pending]').click();
        await page.waitForURL(/\/administration\/growth-engine\/approvals$/);
        assert.equal(await page.getAttribute('[data-testid=ge-tab-approvals]', 'aria-current'), 'page');
        assert.match(await page.getAttribute('.admin-command-link.is-active', 'href'), /\/growth-engine\/approvals$/);
        // A real action from inside the back office
        const id = await frame.locator('[data-testid=draft]').first().getAttribute('data-draft-id');
        await frame.locator(`[data-draft-id="${id}"] [data-testid=btn-approve]`).click();
        await frame.locator('[data-testid=modal-confirm]').click();
        await frame.locator(`[data-draft-id="${id}"]`).waitFor({ state: 'detached' });
        assert.equal((await client.db('fmgrowthtest').collection('growth_drafts').findOne({ id })).status, 'approved');
        // Deep link straight to a section
        await page.goto(`${SITE}/administration/growth-engine/revenue`);
        await page.frameLocator('[data-testid=ge-frame]').locator('[data-testid=page-revenue]').waitFor();
      });

      await t.test('security: the console may be framed only by the admin site', async () => {
        const r = await fetch(`${ENGINE}/api/growth/console`);
        assert.match(r.headers.get('content-security-policy'), new RegExp(`frame-ancestors ${SITE.replace(/[.:/]/g, '\\$&')}$`));
        assert.equal(r.headers.get('x-frame-options'), null);
        const other = await (await newContext()).newPage();
        await other.setContent(`<iframe id="f" src="${ENGINE}/api/growth/console"></iframe>`);
        await other.waitForTimeout(1500);
        const f = other.frames().find((fr) => fr.url().startsWith(ENGINE));
        assert.ok(!f || (await f.$('[data-testid=login]').catch(() => null)) === null, 'console rendered inside a foreign page');
      });

      await t.test('responsive: phone-sized screen', async () => {
        const m = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); await asAdmin(m);
        const p = await m.newPage();
        await p.goto(`${SITE}/administration/growth-engine/analytics`);
        await p.waitForSelector('[data-testid=ge-frame]');
        const box = await p.$eval('[data-testid=ge-frame]', (e) => e.getBoundingClientRect().toJSON());
        assert.ok(box.width <= 390 && box.width >= 300, `frame width ${box.width}`);
        assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'page scrolls sideways');
        const tabs = await p.$eval('nav[aria-label="Growth Engine sections"]', (e) => ({ sw: e.scrollWidth, cw: e.clientWidth, ox: getComputedStyle(e).overflowX }));
        assert.ok(tabs.ox === 'auto' || tabs.sw <= tabs.cw, 'section tabs not scrollable');
        await p.click('.admin-mobile-trigger');
        await p.waitForSelector('.admin-command-nav.is-open');
        if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'v2-mobile.jpg'), type: 'jpeg', quality: 70 });
        await m.close();
      });

      await t.test('if the engine cannot be reached, the page offers the console in a new tab', async () => {
        engineServer.close(); await new Promise((r) => setTimeout(r, 500));
        await page.goto(`${SITE}/administration/growth-engine/publishing`);
        await page.waitForSelector('[data-testid=ge-unreachable]');
        assert.match(await page.getAttribute('[data-testid=ge-unreachable] a', 'href'), /\/api\/growth\/console#\/publishing$/);
        engineServer = engine.listen(4300, '127.0.0.1');
      });
    }

    await t.test('no page errors; nothing reached any outside host', async () => {
      assert.deepEqual(pageErrors.filter((m) => !/Failed to fetch|NetworkError|Load failed|aborted/i.test(m)), []);
      console.log('blocked outside hosts:', [...blocked].join(', ') || 'none');
    });
    await ctx.close();
  } finally {
    await browser.close(); engineServer.close(); await client.close();
  }
});
