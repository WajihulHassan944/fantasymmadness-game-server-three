'use strict';
// Browser test of the owner's "Connect Facebook & Instagram" workflow in Growth Engine →
// Connections, against a loopback stand-in for Meta's sign-in and Graph API. Every other
// host is blocked. Env: GROWTH_TEST_MONGO_URI, GROWTH_CONSOLE_SCREENSHOTS (optional).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { MongoClient } = require('mongodb');
const { registerIsolatedGrowthRoutes } = require('./growth-isolated-routes');
const { hashPassword } = require('./growth-backoffice');
const { contestFeed } = require('./growth-contest-feed.fixture');
const { createFakeMeta } = require('./growth-acceptance/fake-meta');

const uri = process.env.GROWTH_TEST_MONGO_URI;
let chromium = null; try { ({ chromium } = require('playwright')); } catch { /* optional */ }
const skip = !uri || !chromium ? 'needs loopback MongoDB and playwright' : false;
const SHOTS = process.env.GROWTH_CONSOLE_SCREENSHOTS;
const PASSWORD = 'meta connect e2e password (test only)';
const feed = contestFeed();

test('Connections: owner connects Facebook & Instagram through Meta sign-in', { skip, timeout: 180000 }, async (t) => {
  const meta = createFakeMeta(); const META = await meta.listen();
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    if (u.startsWith(META)) return fetch(u, opts);
    if (opts?.method === 'HEAD') return { ok: true, status: 200, headers: { get: (k) => ({ 'content-type': 'image/jpeg', 'content-length': '200000' }[String(k).toLowerCase()] || null) } };
    const f = feed(u); if (f) return f;
    return { ok: true, status: 200, json: async () => ({ results: [] }) };
  };
  const client = await new MongoClient(uri).connect();
  await client.db('fmgrowthtest').dropDatabase();
  const app = express();
  const port = 4310; const ORIGIN = `http://127.0.0.1:${port}`;
  const env = { GROWTH_STAGING_MODE: 'isolated', GROWTH_OUTBOUND_ENABLED: 'false', GROWTH_TEST_MONGO_URI: uri, JWT_SECRET_ADMIN: 's'.repeat(48), GROWTH_UNSUBSCRIBE_SECRET: 's'.repeat(48), CRON_SECRET: 'cron-secret-for-tests-only', GROWTH_DELIVERY_PROVIDER: 'none', GROWTH_ADMIN_PASSWORD_HASH: hashPassword(PASSWORD), GROWTH_SOCIAL_PROVIDER: 'sandbox', GROWTH_META_GRAPH_BASE: META, GROWTH_META_DIALOG_BASE: META, GROWTH_TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), GROWTH_PUBLIC_ORIGIN: ORIGIN };
  const m = registerIsolatedGrowthRoutes({ app, env, express, fetchImpl, connect: async () => client });
  const server = app.listen(port, '127.0.0.1');
  await (await m.getRuntime()).tick({ now: new Date(Date.now() - 60 * 60000) });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const blocked = new Set();
  await ctx.route('**/*', (route) => { const u = new URL(route.request().url()); if (u.origin === ORIGIN || u.origin === META || u.protocol === 'data:') return route.continue(); blocked.add(u.host); return route.abort(); });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const shot = (name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, `meta-${name}.jpg`), type: 'jpeg', quality: 70, fullPage: true }) : null);
  try {
    await page.goto(`${ORIGIN}/api/growth/console#/connections`);
    await page.fill('[data-testid=login-password]', PASSWORD);
    await page.click('[data-testid=login-submit]');
    await page.waitForSelector('[data-testid=conn-meta]');

    await t.test('not set up: statuses, setup checklist, exact redirect address, App ID/Secret form', async () => {
      assert.equal(await page.getAttribute('[data-testid=conn-meta]', 'data-state'), 'not_set_up');
      assert.match(await page.textContent('[data-testid=meta-mode-facebook]'), /Facebook: Sandbox/);
      assert.match(await page.textContent('[data-testid=meta-mode-instagram]'), /Instagram: Sandbox/);
      assert.equal(await page.textContent('[data-testid=meta-redirect-uri]'), `${ORIGIN}/api/growth/meta/callback`);
      await page.fill('[data-testid=meta-app-id]', meta.state.appId);
      await page.fill('[data-testid=meta-app-secret]', 'b'.repeat(32));
      await page.click('[data-testid=btn-meta-app-save]');
      await page.waitForSelector('.toast.bad, [role=alert]');
      await page.fill('[data-testid=meta-app-secret]', meta.state.appSecret);
      await page.click('[data-testid=btn-meta-app-save]');
      await page.waitForSelector('[data-testid=conn-meta][data-state=authorization_needed]');
      assert.match(await page.textContent('[data-testid=meta-state]'), /Authorization needed/);
      await shot('authorization-needed');
    });

    await t.test('Connect opens Meta sign-in in a new window; approving returns to the Page chooser', async () => {
      const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('[data-testid=btn-meta-connect]')]);
      await popup.waitForSelector('#continue');
      assert.match(popup.url(), /\/dialog\/oauth\?/);
      assert.match(await popup.textContent('body'), /instagram_content_publish/);
      await popup.click('#continue');
      await popup.waitForSelector('[data-testid=meta-callback]');
      assert.match(await popup.textContent('h1'), /authorized/);
      assert.ok(!/code=|state=/.test(popup.url()), 'sign-in code left in the address bar');
      await page.waitForSelector('[data-testid=conn-meta][data-state=selection_needed]', { timeout: 15000 });
      const options = await page.$$eval('.page-option', (els) => els.map((e) => ({ id: e.getAttribute('data-page-id'), text: e.textContent, disabled: e.querySelector('input').disabled })));
      assert.equal(options.length, 3);
      assert.equal(options.find((o) => /FANTASY MMADNESS/.test(o.text)).disabled, false);
      assert.match(options.find((o) => /FANTASY MMADNESS/.test(o.text)).text, /@fantasymmadness/);
      assert.equal(options.find((o) => /personal fan page/.test(o.text)).disabled, true);
      assert.equal(options.find((o) => /Old Promotions/.test(o.text)).disabled, true);
      await shot('choose-page');
    });

    await t.test('choosing requires confirmation; then Connected with the verified Page and Instagram account', async () => {
      await page.check('.page-option[data-page-id="111000111000111"] input');
      await page.click('[data-testid=btn-meta-select]');
      await page.waitForSelector('.toast.bad');
      await page.check('[data-testid=meta-confirm]');
      await page.click('[data-testid=btn-meta-select]');
      await page.waitForSelector('[data-testid=conn-meta][data-state=connected]');
      assert.match(await page.textContent('[data-testid=meta-state]'), /Connected/);
      assert.match(await page.textContent('[data-testid=meta-page]'), /FANTASY MMADNESS \(ID 111000111000111\)/);
      assert.match(await page.textContent('[data-testid=meta-ig]'), /@fantasymmadness/);
      assert.match(await page.textContent('[data-testid=meta-health]'), /OK/);
      await page.click('[data-testid=btn-meta-check]');
      await page.waitForSelector('.toast.good');
      await shot('connected');
      const html = await page.content();
      assert.ok(!meta.allTokens().some((tk) => html.includes(tk)), 'token rendered in the console');
    });

    await t.test('Publishing shows Sandbox statuses and the live test is off until the owner authorizes it', async () => {
      await page.goto(`${ORIGIN}/api/growth/console#/publishing`);
      await page.waitForSelector('[data-testid=live-test]');
      assert.match(await page.textContent('[data-testid=channel-tile-facebook]'), /Sandbox/);
      assert.match(await page.textContent('[data-testid=live-test]'), /Real posting is OFF/);
      assert.equal(await page.locator('[data-testid=btn-live-test]').count(), 0);
      await shot('publishing');
    });

    await t.test('schedule dialog offers sandbox channels and affiliate credit', async () => {
      await page.goto(`${ORIGIN}/api/growth/console#/approvals`);
      const d = page.locator('[data-testid=draft]').filter({ has: page.locator('[data-testid=btn-approve]') }).first();
      const id = await d.getAttribute('data-draft-id');
      await d.locator('[data-testid=btn-approve]').click(); await page.click('[data-testid=modal-confirm]');
      await page.waitForSelector(`[data-draft-id="${id}"]`, { state: 'detached' });
      await page.goto(`${ORIGIN}/api/growth/console#/marketing`);
      const card = page.locator(`[data-draft-id="${id}"]`);
      await card.locator('[data-testid=btn-schedule]').click();
      await page.waitForSelector('[data-testid=schedule-affiliate]');
      assert.match(await page.textContent('.modal'), /Sandbox \(simulated\)/);
      await page.click('[data-testid=modal-confirm]');
      await page.waitForSelector('.toast');
      assert.equal(meta.publishCalls().length, 0, 'scheduling or sandbox contacted Meta publishing');
    });

    await t.test('no page errors; only the console and the Meta stand-in were contacted', async () => {
      assert.deepEqual(errors, []);
      assert.deepEqual([...blocked], []);
    });
  } finally {
    await ctx.close(); await browser.close(); server.close(); await meta.close(); await client.close();
  }
});
