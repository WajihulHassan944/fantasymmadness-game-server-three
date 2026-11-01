'use strict';
// Browser test of the website's admin "Growth Engine (staging)" page (fmm-ver2,
// branch test/growth-engine-admin-bridge) against a real Growth Engine server on
// loopback MongoDB. The page is bundled from the website source and served from a
// DIFFERENT origin, with the same CORS allowlist behaviour as the live server.
// Env: GROWTH_TEST_MONGO_URI, BRIDGE_BUNDLE (path to the bundled harness JS).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const { registerIsolatedGrowthRoutes } = require('../growth-isolated-routes');
const { hashPassword } = require('../growth-backoffice');
const { contestFeed } = require('../growth-contest-feed.fixture');

const uri = process.env.GROWTH_TEST_MONGO_URI;
let chromium = null; try { ({ chromium } = require('playwright')); } catch { /* optional */ }
const bundle = process.env.BRIDGE_BUNDLE;
const skip = !uri || !chromium || !bundle || !fs.existsSync(bundle) ? 'needs loopback MongoDB, playwright and the bundled bridge' : false;
const ENGINE_PORT = 4300; const SITE_PORT = 4310;
const PASSWORD = 'bridge test password (test only)';
const feed = contestFeed();
const fetchImpl = async (url) => { const f = feed(url); if (f) return f; const term = new URL(url).searchParams.get('term') || 'x'; const slug = term.replace(/[^a-z]+/gi, '-').toLowerCase(); return { ok: true, status: 200, json: async () => ({ results: [1, 2].map((n) => ({ collectionName: `${term} show ${n}`, collectionViewUrl: `https://podcasts.apple.com/us/podcast/${slug}-${n}/id${n}` })) }) }; };

test('website admin Growth Engine page', { skip, timeout: 180000 }, async (t) => {
  const client = await new MongoClient(uri).connect();
  await client.db('fmgrowthtest').dropDatabase();
  const env = { GROWTH_STAGING_MODE: 'isolated', GROWTH_OUTBOUND_ENABLED: 'false', GROWTH_TEST_MONGO_URI: uri, JWT_SECRET_ADMIN: 's'.repeat(48), GROWTH_UNSUBSCRIBE_SECRET: 's'.repeat(48), CRON_SECRET: 'cron-secret-for-tests-only', GROWTH_DELIVERY_PROVIDER: 'none', GROWTH_ADMIN_PASSWORD_HASH: hashPassword(PASSWORD), GROWTH_SOCIAL_PROVIDER: 'sandbox' };
  const engine = express();
  // Same behaviour as server.js: exact-origin allowlist, anything else refused.
  const allowed = [`http://localhost:${SITE_PORT}`];
  engine.use(cors({ origin: (o, cb) => (!o || allowed.includes(o) ? cb(null, true) : cb(new Error('Not allowed by CORS'))), credentials: true }));
  const mounted = registerIsolatedGrowthRoutes({ app: engine, env, express, fetchImpl, connect: async () => client });
  const runtime = await mounted.getRuntime();
  await runtime.tick({ now: new Date(Date.now() - 60 * 60000) });
  const engineServer = engine.listen(ENGINE_PORT, '127.0.0.1');
  const site = express();
  site.get('/bridge.js', (req, res) => res.type('js').send(fs.readFileSync(bundle)));
  if (fs.existsSync(bundle.replace(/\.js$/, '.css'))) site.get('/bridge.css', (req, res) => res.type('css').send(fs.readFileSync(bundle.replace(/\.js$/, '.css'))));
  site.get('/', (req, res) => res.type('html').send('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/bridge.css"><div id="root"></div><script src="/bridge.js"></script>'));
  const siteServer = site.listen(SITE_PORT, '127.0.0.1');
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const shots = process.env.GROWTH_CONSOLE_SCREENSHOTS;
  try {
    await t.test('sign in with the Growth Engine password (separate from the live admin login)', async () => {
      await page.goto(`http://localhost:${SITE_PORT}/`);
      await page.waitForSelector('#growth-password');
      await page.fill('#growth-password', 'wrong');
      await page.click('button[type=submit]');
      await page.waitForSelector('[role=alert]');
      assert.match(await page.textContent('[role=alert]'), /Incorrect password/);
      await page.fill('#growth-password', PASSWORD);
      await page.click('button[type=submit]');
      await page.waitForSelector('text=Campaign funnel');
      assert.match(await page.textContent('main'), /Running automatically/);
      if (shots) await page.screenshot({ path: path.join(shots, '12-admin-bridge.jpg'), fullPage: true, type: 'jpeg', quality: 70 });
    });
    await t.test('approve and reject from the admin page (with live re-verification)', async () => {
      const before = await runtime.collections.drafts.countDocuments({ status: 'needs_owner_review' });
      assert.ok(before >= 2);
      await page.click('li >> nth=0 >> button:has-text("Approve")');
      await page.waitForFunction((n) => document.querySelectorAll('main li').length === Math.min(10, n - 1), before);
      assert.equal(await runtime.collections.drafts.countDocuments({ status: 'approved' }), 1);
      await page.click('li >> nth=0 >> button:has-text("Reject")');
      await page.waitForFunction((n) => document.querySelectorAll('main li').length === Math.min(10, n - 2), before);
      assert.equal(await runtime.collections.drafts.countDocuments({ status: 'rejected', rejectReason: 'Rejected from the admin back office' }), 1);
    });
    await t.test('pause and resume publishing', async () => {
      await page.click('button:has-text("Pause all publishing")');
      await page.waitForSelector('button:has-text("Resume publishing")');
      assert.equal((await runtime.social.isPaused()).paused, true);
      await page.click('button:has-text("Resume publishing")');
      await page.waitForSelector('button:has-text("Pause all publishing")');
      assert.equal((await runtime.social.isPaused()).paused, false);
    });
    await t.test('sign out', async () => {
      await page.click('button:has-text("Sign out of the Growth Engine")');
      await page.waitForSelector('#growth-password');
    });
    await t.test('when the engine cannot be reached, the page offers the console link instead', async () => {
      engineServer.close(); await new Promise((r) => setTimeout(r, 300));
      await page.goto(`http://localhost:${SITE_PORT}/`);
      await page.waitForSelector('text=Open the Growth Engine in its own tab');
      assert.match(await page.getAttribute('a:has-text("Open Growth Engine console")', 'href'), /\/api\/growth\/console#\/overview$/);
    });
    await t.test('no page errors', async () => { assert.deepEqual(errors, []); });
  } finally {
    await browser.close(); siteServer.close(); engineServer.close(); await client.close();
  }
});
