'use strict';
// Browser end-to-end test of the Growth Engine back-office console.
// Real Express routes + real runtime + real (loopback) MongoDB, driven by a real
// Chromium through every screen, button and workflow. Data comes from genuine
// engine runs (discovery uses a stub of the public podcast API so CI has no
// network dependency). Nothing is sent: delivery provider "none".
//
// Requires: GROWTH_TEST_MONGO_URI (loopback) and the `playwright` package.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { MongoClient } = require('mongodb');
const { registerIsolatedGrowthRoutes } = require('./growth-isolated-routes');
const { hashPassword } = require('./growth-backoffice');

const uri = process.env.GROWTH_TEST_MONGO_URI;
let chromium = null; try { ({ chromium } = require('playwright')); } catch { /* optional dependency */ }
const skip = !uri || !/^mongodb:\/\/(127\.0\.0\.1|localhost)/.test(uri) || !chromium ? 'needs loopback MongoDB and playwright' : false;
const PASSWORD = 'correct horse battery staple (test only)';
const secret = 's'.repeat(48);
const SHOTS = process.env.GROWTH_CONSOLE_SCREENSHOTS || path.join(__dirname, 'growth-console-screenshots');
const env = {
  GROWTH_STAGING_MODE: 'isolated', GROWTH_OUTBOUND_ENABLED: 'false', GROWTH_TEST_MONGO_URI: uri, JWT_SECRET_ADMIN: secret, GROWTH_UNSUBSCRIBE_SECRET: secret,
  CRON_SECRET: 'cron-secret-for-tests-only', GROWTH_DELIVERY_PROVIDER: 'none', GROWTH_ADMIN_PASSWORD_HASH: hashPassword(PASSWORD),
};
const podcastFetch = async (url) => {
  const term = new URL(url).searchParams.get('term');
  const slug = term.replace(/[^a-z]+/gi, '-').toLowerCase();
  return { ok: true, status: 200, json: async () => ({ results: [1, 2, 3].map((n) => ({ collectionName: `${term} show ${n}`, collectionViewUrl: `https://podcasts.apple.com/us/podcast/${slug}-${n}/id${n}` })) }) };
};

test('Growth Engine back-office console: every screen, button and workflow', { skip, timeout: 240000 }, async (t) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const client = await new MongoClient(uri).connect();
  const db = client.db('fmgrowthtest');
  await db.dropDatabase();
  const app = express();
  const mounted = registerIsolatedGrowthRoutes({ app, env, express, fetchImpl: podcastFetch, connect: async () => client });
  assert.equal(mounted.mounted, true);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const runtime = await mounted.getRuntime();

  // ---- genuine engine activity: interrupted run, two days of runs, a job that exhausted retries
  const now = Date.now();
  await db.collection('isolated_run_claims').insertOne({ runId: 'growth_202601010000', mode: 'isolated', state: 'claimed', createdAt: new Date(now - 3 * 3600000).toISOString() });
  await runtime.tick({ now: new Date(now - 26 * 3600000) });
  await runtime.tick({ now: new Date(now - 26 * 3600000 + 2 * 60000) });
  await runtime.tick({ now: new Date(now - 61 * 60000) });
  await runtime.tick({ now: new Date(now - 60 * 60000) });
  await db.collection('unattended_jobs').insertOne({ id: 'discover-20260101', type: 'discover', state: 'failed', attempts: 3, dueAt: new Date(now - 5 * 86400000).toISOString(), lastError: 'upstream 503 (seeded for requeue test)', createdAt: new Date(now - 5 * 86400000).toISOString() });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/401|409|422|429|Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`); });
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.jpg`), fullPage: true, type: "jpeg", quality: 70 });
  const confirm = async () => { await page.click('[data-testid=modal-confirm]'); await page.waitForSelector('[data-testid=modal]', { state: 'detached' }); };
  const toastText = async () => (await page.waitForSelector('[data-testid=toast]')).textContent();
  const clearToasts = () => page.evaluate(() => document.querySelectorAll('[data-testid=toast]').forEach((e) => e.remove()));
  const goto = async (hash) => {
    const before = Number(await page.evaluate(() => document.querySelector('main')?.dataset.render || 0));
    await page.evaluate((hh) => { location.hash = hh; }, hash);
    await page.waitForSelector(`main[data-render="${before + 1}"]`);
    await page.waitForSelector('main .spinner', { state: 'detached' });
  };
  const draft = (id) => db.collection('growth_drafts').findOne({ id });

  try {
    await t.test('console is served with a strict security policy', async () => {
      const r = await fetch(`${origin}/api/growth/console`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
      assert.equal(r.headers.get('x-frame-options'), 'DENY');
      const h = await (await fetch(`${origin}/api/growth/health`)).json();
      assert.equal(h.console.signInConfigured, true);
    });

    await t.test('API refuses every admin route without a valid token', async () => {
      for (const p of ['overview', 'drafts', 'status', 'runs', 'jobs', 'workstreams', 'analytics', 'attribution', 'reports', 'audit', 'suppressions', 'session']) {
        assert.equal((await fetch(`${origin}/api/growth/admin/${p}`)).status, 401, p);
      }
    });

    await t.test('sign-in: wrong password rejected, correct password opens the overview', async () => {
      await page.goto(`${origin}/api/growth/console`);
      await page.waitForSelector('[data-testid=login]');
      await shot('01-sign-in');
      await page.fill('[data-testid=login-password]', 'wrong password');
      await page.click('[data-testid=login-submit]');
      await page.waitForFunction(() => document.querySelector('[data-testid=login-error]').textContent.includes('Incorrect'));
      await page.fill('[data-testid=login-password]', PASSWORD);
      await page.click('[data-testid=login-submit]');
      await page.waitForSelector('[data-testid=page-overview] [data-testid=scheduler-banner]');
    });

    await t.test('Overview shows live engine status and counts', async () => {
      const banner = await page.textContent('[data-testid=scheduler-banner]');
      assert.match(banner, /running automatically/);
      assert.equal(await page.textContent('[data-testid=tile-pending] .value'), '10');
      assert.equal(await page.textContent('[data-testid=tile-alerts] .value'), '1'); // the interrupted run
      assert.ok(await page.$('[data-testid=daily-report]'));
      assert.ok((await page.$$('[data-testid=runs-table] tbody tr')).length >= 3);
      assert.equal(await page.textContent('[data-testid=nav-pending]'), '10');
      await shot('02-overview');
      await page.click('[data-testid=btn-refresh]');
      await page.waitForSelector('[data-testid=scheduler-banner]');
      await page.click('[data-testid=tile-pending]');
      await page.waitForSelector('[data-testid=page-approvals] [data-testid=draft]');
    });

    await t.test('Campaign Approvals: approve, edit, reject, filter', async () => {
      assert.equal((await page.$$('[data-testid=draft]')).length, 10);
      await shot('03-approvals');
      // Edit the first post (still awaiting approval afterwards)
      const first = await page.getAttribute('[data-testid=draft]:nth-of-type(2)', 'data-draft-id') || await page.getAttribute('[data-testid=draft]', 'data-draft-id');
      const card = `[data-draft-id="${first}"]`;
      await page.click(`${card} [data-testid=btn-edit]`);
      await page.fill('[data-testid=edit-title]', 'Fight week: pick every round');
      await page.fill('[data-testid=edit-text]', 'Make your round-by-round picks for fight week on FANTASY MMADNESS. fantasymmadness.com');
      await confirm();
      assert.match(await toastText(), /saved/i); await clearToasts();
      await page.waitForFunction((sel) => document.querySelector(sel + ' [data-testid=draft-title]')?.textContent === 'Fight week: pick every round', card);
      let d = await draft(first);
      assert.equal(d.headline, 'Fight week: pick every round'); assert.equal(d.status, 'needs_owner_review'); assert.equal(d.editCount, 1);
      // Approve it
      await page.click(`${card} [data-testid=btn-approve]`); await confirm();
      assert.match(await toastText(), /Approved/); await clearToasts();
      await page.waitForSelector(card, { state: 'detached' });
      d = await draft(first); assert.equal(d.status, 'approved'); assert.equal(d.ownerApproved, true); assert.equal(d.approvedBy, 'owner@growth-console');
      // Cancel leaves it untouched
      const second = await page.getAttribute('[data-testid=draft]', 'data-draft-id');
      await page.click(`[data-draft-id="${second}"] [data-testid=btn-approve]`);
      await page.click('[data-testid=modal-cancel]');
      assert.equal((await draft(second)).status, 'needs_owner_review');
      // Reject with a reason
      await page.click(`[data-draft-id="${second}"] [data-testid=btn-reject]`);
      await page.fill('[data-testid=reject-reason]', 'Not this week');
      await confirm(); await clearToasts();
      await page.waitForSelector(`[data-draft-id="${second}"]`, { state: 'detached' });
      d = await draft(second); assert.equal(d.status, 'rejected'); assert.equal(d.rejectReason, 'Not this week');
      // Approve two more for the publishing workflow
      for (let i = 0; i < 2; i++) {
        const id = await page.getAttribute('[data-testid=draft]', 'data-draft-id');
        await page.click(`[data-draft-id="${id}"] [data-testid=btn-approve]`); await confirm(); await clearToasts();
        await page.waitForSelector(`[data-draft-id="${id}"]`, { state: 'detached' });
      }
      assert.equal(await page.textContent('[data-testid=nav-pending]'), '6');
      // Filters
      await page.selectOption('[data-testid=filter-status]', 'rejected');
      await page.waitForFunction(() => document.querySelectorAll('[data-testid=draft]').length === 1);
      await page.selectOption('[data-testid=filter-status]', '');
      await page.waitForFunction(() => document.querySelectorAll('[data-testid=draft]').length === 10);
      await page.selectOption('[data-testid=filter-sport]', 'boxing');
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=draft]')].length === 2);
      await page.selectOption('[data-testid=filter-kind]', 'pr');
      await page.waitForSelector('[data-testid=empty]');
    });

    await t.test('Marketing: copy post, mark published (with link validation), withdraw approval', async () => {
      await goto('#/marketing');
      assert.equal((await page.$$('[data-testid=marketing-workstreams] tbody tr')).length, 5);
      assert.equal(await page.textContent('[data-testid=mkt-approved] .value'), '3');
      await shot('04-marketing');
      const approved = await page.$$eval('[data-testid=marketing-list] [data-status=approved]', (els) => els.map((e) => e.getAttribute('data-draft-id')));
      assert.equal(approved.length, 3);
      await page.click(`[data-draft-id="${approved[0]}"] [data-testid=btn-copy]`);
      assert.match(await toastText(), /Copied/); await clearToasts();
      assert.match(await page.evaluate(() => navigator.clipboard.readText()), /FANTASY MMADNESS/);
      await page.click(`[data-draft-id="${approved[0]}"] [data-testid=btn-mark-published]`);
      await page.fill('[data-testid=post-url]', 'http://not-secure.example');
      await page.click('[data-testid=modal-confirm]');
      await page.waitForFunction(() => document.querySelector('[data-testid=modal] .error')?.textContent.includes('https'));
      await page.fill('[data-testid=post-url]', 'https://www.instagram.com/p/test-post/');
      await confirm(); assert.match(await toastText(), /published/); await clearToasts();
      await page.waitForSelector(`[data-draft-id="${approved[0]}"][data-status=published]`);
      const p = await draft(approved[0]); assert.equal(p.status, 'published'); assert.equal(p.postUrl, 'https://www.instagram.com/p/test-post/');
      await page.click(`[data-draft-id="${approved[1]}"] [data-testid=btn-withdraw]`); await confirm(); await clearToasts();
      await page.waitForSelector(`[data-draft-id="${approved[1]}"][data-status=rejected]`);
      assert.equal((await draft(approved[1])).status, 'rejected');
      await page.selectOption('[data-testid=filter-sport]', 'kickboxing');
      await page.waitForFunction(() => location.hash.includes('kickboxing'));
      await page.waitForSelector('[data-testid=marketing-list] [data-testid=draft], [data-testid=marketing-list] [data-testid=empty]');
    });

    await t.test('Public Relations: sport tabs, prepared drafts, add verified contact, approve personalized email', async () => {
      await goto('#/pr');
      await page.waitForSelector('[data-testid=prepared-row]');
      assert.ok(Number(await page.textContent('[data-testid=pr-prepared] .value')) >= 15);
      await page.click('[data-testid=tab-mma-ufc]');
      await page.waitForFunction(() => document.querySelector('[data-testid=prepared-count]')?.textContent.includes('MMA'));
      await page.click('[data-testid=prepared-row] [data-testid=btn-view-template]');
      await page.waitForSelector('[data-testid=prepared-list] [data-testid=email-preview]');
      assert.equal(await page.getAttribute('[data-testid=email-preview]', 'sandbox'), '');
      await shot('05-public-relations');
      await page.click('[data-testid=prepared-row] [data-testid=btn-view-template]');
      const prospectId = await page.getAttribute('[data-testid=prepared-row]', 'data-prospect-id');
      await page.click('[data-testid=prepared-row] [data-testid=btn-add-contact]');
      await page.fill('[data-testid=contact-email]', 'bookings@mma-show.example');
      await page.click('[data-testid=modal-confirm]'); // consent missing
      await page.waitForFunction(() => document.querySelector('[data-testid=modal] .error')?.textContent.includes('consent'));
      await page.fill('[data-testid=contact-consent]', 'Listed as the booking contact on the show’s official website');
      await confirm(); assert.match(await toastText(), /Personalized email created/); await clearToasts();
      await page.waitForSelector('[data-testid=pr-draft-list] [data-testid=draft]');
      const prDraft = await draft(`pr-${prospectId}`);
      assert.equal(prDraft.status, 'needs_owner_review'); assert.equal(prDraft.recipient, 'bookings@mma-show.example');
      await page.click(`[data-draft-id="pr-${prospectId}"] [data-testid=btn-preview]`);
      await page.waitForSelector(`[data-draft-id="pr-${prospectId}"] [data-testid=email-preview]`);
      await page.click(`[data-draft-id="pr-${prospectId}"] [data-testid=btn-edit]`);
      await page.fill('[data-testid=edit-title]', 'Round-by-round predictions for your MMA audience');
      await confirm(); await clearToasts();
      await page.click(`[data-draft-id="pr-${prospectId}"] [data-testid=btn-approve]`); await confirm(); await clearToasts();
      await page.waitForSelector(`[data-draft-id="pr-${prospectId}"][data-status=approved]`);
      const after = await draft(`pr-${prospectId}`);
      assert.equal(after.status, 'approved'); assert.equal(after.subject, 'Round-by-round predictions for your MMA audience');
      // Same prospect again -> clear duplicate message
      await page.waitForSelector(`[data-testid=prepared-row][data-prospect-id="${prospectId}"] .chip.good`);
      await page.click(`[data-testid=prepared-row][data-prospect-id="${prospectId}"] [data-testid=btn-add-contact]`);
      await page.fill('[data-testid=contact-email]', 'bookings@mma-show.example');
      await page.fill('[data-testid=contact-consent]', 'Official website');
      await page.click('[data-testid=modal-confirm]');
      await page.waitForFunction(() => document.querySelector('[data-testid=modal] .error')?.textContent.includes('already exists'));
      await page.click('[data-testid=modal-cancel]');
    });

    let affiliateProspect;
    await t.test('Affiliate Recruitment: add contact, approve invitation', async () => {
      await goto('#/affiliates?sport=boxing');
      await page.waitForSelector('[data-testid=prepared-row]');
      assert.ok(Number(await page.textContent('[data-testid=affiliate-prepared] .value')) >= 15);
      await shot('06-affiliate-recruitment');
      affiliateProspect = await page.getAttribute('[data-testid=prepared-row]', 'data-prospect-id');
      await page.click('[data-testid=prepared-row] [data-testid=btn-add-contact]');
      assert.equal(await page.inputValue('[data-testid=contact-kind]'), 'affiliate');
      await page.fill('[data-testid=contact-email]', 'not-an-email');
      await page.fill('[data-testid=contact-consent]', 'Creator applied through our affiliate interest form');
      await page.click('[data-testid=modal-confirm]');
      await page.waitForFunction(() => document.querySelector('[data-testid=modal] .error')?.textContent.length > 0);
      await page.fill('[data-testid=contact-email]', 'partners@boxing-creator.example');
      await confirm(); await clearToasts();
      await page.waitForSelector(`[data-draft-id="affiliate-${affiliateProspect}"]`);
      await page.click(`[data-draft-id="affiliate-${affiliateProspect}"] [data-testid=btn-approve]`); await confirm(); await clearToasts();
      await page.waitForSelector(`[data-draft-id="affiliate-${affiliateProspect}"][data-status=approved]`);
    });

    await t.test('Revenue Attribution: tracked link, verified revenue only', async () => {
      await goto('#/revenue');
      assert.match(await page.textContent('[data-testid=payment-banner]'), /not connected/);
      assert.equal(await page.textContent('[data-testid=rev-total] .value'), '$0.00');
      await page.waitForSelector('[data-testid=rev-affiliate-row]');
      await page.click('[data-testid=btn-copy-link]');
      assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^https:\/\/fantasymmadness\.com\/affiliate\/.+\?fight=next-event$/);
      await clearToasts();
      // Verified tracking events recorded in the isolated database
      const base = { affiliateId: affiliateProspect, referralAffiliateId: affiliateProspect, playerId: 'player-1', fightId: 'fight-1', at: new Date().toISOString() };
      await db.collection('growth_attribution_events').insertMany([
        { ...base, type: 'visit', verified: true }, { ...base, type: 'signup', verified: true },
        { ...base, type: 'paid_entry', verified: true, paymentStatus: 'settled', entryId: 'entry-1', amountCents: 500 },
        { ...base, type: 'paid_entry', verified: true, paymentStatus: 'settled', entryId: 'entry-1', amountCents: 500 }, // duplicate
        { ...base, type: 'paid_entry', verified: true, paymentStatus: 'pending', entryId: 'entry-2', amountCents: 500 }, // not settled
        { ...base, type: 'paid_entry', verified: false, paymentStatus: 'settled', entryId: 'entry-3', amountCents: 500 }, // browser-only
      ]);
      await goto('#/overview'); await goto('#/revenue');
      assert.equal(await page.textContent('[data-testid=rev-total] .value'), '$5.00');
      assert.equal(await page.textContent('[data-testid=rev-entries] .value'), '1');
      assert.match(await page.textContent('[data-testid=rev-events]'), /duplicate entry \(1\)/);
      assert.match(await page.textContent('[data-testid=rev-by-sport]'), /Boxing\s*1\s*\$5\.00/);
      await shot('07-revenue-attribution');
    });

    await t.test('Automation: run now, acknowledge alert, requeue job, opt-outs, alert filter', async () => {
      await goto('#/automation');
      assert.match(await page.textContent('[data-testid=delivery-tile]'), /OFF/);
      await shot('08-automation');
      // Alert from the interrupted run
      await page.waitForSelector('[data-alert-key="stale:growth_202601010000"]');
      await page.click('[data-alert-key="stale:growth_202601010000"] [data-testid=btn-ack]');
      assert.match(await toastText(), /acknowledged/); await clearToasts();
      await page.waitForSelector('[data-testid=alerts-empty]');
      assert.equal((await db.collection('growth_alerts').findOne({ alertKey: 'stale:growth_202601010000' })).state, 'acknowledged');
      await page.click('[data-testid=alerts-all]');
      await page.waitForSelector('[data-alert-key="stale:growth_202601010000"]');
      await page.click('[data-testid=alerts-open]');
      await page.waitForSelector('[data-testid=alerts-empty]');
      // Requeue the job that exhausted its retries
      await page.click('[data-job-id="discover-20260101"] [data-testid=btn-requeue]');
      assert.match(await toastText(), /queued/); await clearToasts();
      assert.equal((await db.collection('unattended_jobs').findOne({ id: 'discover-20260101' })).state, 'retry');
      // Run now executes a full cycle (and picks up the requeued job)
      const runsBefore = await db.collection('isolated_run_claims').countDocuments();
      await page.click('[data-testid=btn-run-now]'); await confirm();
      assert.match(await toastText(), /finished|already happened/); await clearToasts();
      assert.equal(await db.collection('isolated_run_claims').countDocuments(), runsBefore + 1);
      assert.equal((await db.collection('unattended_jobs').findOne({ id: 'discover-20260101' })).state, 'completed');
      // Opt-outs: invalid rejected, valid added and listed
      await page.fill('[data-testid=optout-email]', 'nope');
      await page.evaluate(() => { document.querySelector('[data-testid=optout-email]').type = 'text'; });
      await page.click('[data-testid=btn-add-optout]');
      assert.match(await toastText(), /valid email/); await clearToasts();
      await page.fill('[data-testid=optout-email]', 'Stop.Contacting@Example.com');
      await page.click('[data-testid=btn-add-optout]');
      assert.match(await toastText(), /do-not-contact/); await clearToasts();
      await page.waitForSelector('[data-testid=optout-row]');
      assert.match(await page.textContent('[data-testid=optout-table]'), /stop\.contacting@example\.com/);
      assert.ok((await page.$$('[data-testid=audit-table] tbody tr')).length >= 8);
    });

    await t.test('opted-out contact cannot be given an outreach email', async () => {
      await goto('#/pr?sport=kickboxing');
      await page.waitForSelector('[data-testid=prepared-row]');
      await page.click('[data-testid=prepared-row] [data-testid=btn-add-contact]');
      await page.fill('[data-testid=contact-email]', 'stop.contacting@example.com');
      await page.fill('[data-testid=contact-consent]', 'Website');
      await page.click('[data-testid=modal-confirm]');
      await page.waitForFunction(() => document.querySelector('[data-testid=modal] .error')?.textContent.includes('opted out'));
      await page.click('[data-testid=modal-cancel]');
    });

    await t.test('Analytics: 5 x 5 department matrix and charts from live data', async () => {
      await goto('#/analytics');
      const cells = await page.$$eval('[data-testid=workstream-matrix] td.cell', (els) => els.map((e) => e.textContent));
      assert.equal(cells.length, 25);
      assert.ok(cells.every((c) => c !== '—'), 'every department ran for every sport');
      assert.equal((await page.$$('[data-testid=chart-marketing] .bar-row')).length, 5);
      assert.equal((await page.$$('[data-testid=chart-partners] .bar-row')).length, 5);
      assert.ok(await page.$('[data-testid=chart-runs] .vbar'));
      assert.ok((await page.$$('[data-testid=reports-table] tbody tr')).length >= 2);
      assert.equal(await page.textContent('[data-testid=an-real] .value'), '0');
      await shot('09-analytics');
    });

    await t.test('every nav link opens its screen without errors', async () => {
      for (const n of ['overview', 'approvals', 'marketing', 'pr', 'affiliates', 'automation', 'analytics', 'revenue']) {
        await page.click(`[data-testid=nav-${n}]`);
        await page.waitForSelector(`[data-testid=page-${n}]`);
        await page.waitForSelector('main .spinner', { state: 'detached' });
        assert.equal(await page.$('[data-testid=page-error]'), null, n);
      }
    });

    await t.test('API guards: state rules and sign-in rate limit', async () => {
      const token = (await (await fetch(`${origin}/api/growth/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })).json()).token;
      const call = (m, p, body) => fetch(`${origin}/api/growth/admin${p}`, { method: m, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const published = await db.collection('growth_drafts').findOne({ status: 'published' });
      assert.equal((await call('POST', `/drafts/${published.id}/edit`, { text: 'x' })).status, 409);
      assert.equal((await call('POST', `/drafts/${published.id}/approve`)).status, 409);
      assert.equal((await call('POST', '/drafts/nope/mark-published', {})).status, 409);
      assert.equal((await call('GET', '/workstreams/none/none')).status, 404);
      // A console session from before a password change is refused
      const jwt = require('jsonwebtoken');
      const stale = jwt.sign({ email: 'owner@growth-console', role: 'growth_owner', pwv: 'old-password-ver' }, secret, { expiresIn: '1h' });
      assert.equal((await fetch(`${origin}/api/growth/admin/session`, { headers: { Authorization: `Bearer ${stale}` } })).status, 401);
      assert.equal((await call('GET', '/session')).status, 200);
      // Markup typed into an email draft is escaped, never injected into the HTML
      const target = await db.collection('growth_prospects').findOne({ focus: 'partners', contactVerified: false, genre: 'pro-wrestling' });
      assert.equal((await call('POST', `/prospects/${target.id}/contact`, { contact: 'media@wrestling-show.example', kind: 'pr', consentNote: 'Press contact on official site' })).status, 201);
      assert.equal((await call('POST', `/drafts/pr-${target.id}/edit`, { text: 'Hi <script>alert(1)</script>' })).status, 200);
      const edited = await draft(`pr-${target.id}`);
      assert.ok(!edited.html.includes('<script>') && edited.html.includes('&lt;script&gt;'));
      for (let i = 0; i < 10; i++) await fetch(`${origin}/api/growth/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' }, body: JSON.stringify({ password: 'x' }) });
      assert.equal((await fetch(`${origin}/api/growth/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' }, body: JSON.stringify({ password: PASSWORD }) })).status, 429);
    });

    await t.test('sign out and expired session both return to sign-in', async () => {
      await page.click('[data-testid=signout]');
      await page.waitForSelector('[data-testid=login]');
      await page.evaluate(() => sessionStorage.setItem('fmmGrowthConsoleToken', 'expired.token.value'));
      await page.goto(`${origin}/api/growth/console#/automation`);
      await page.waitForSelector('[data-testid=login]');
    });

    await t.test('nothing was sent and no browser errors occurred', async () => {
      assert.equal(await db.collection('growth_delivery_claims').countDocuments(), 0);
      assert.equal(await db.collection('growth_drafts').countDocuments({ status: 'delivered' }), 0);
      assert.deepEqual(problems, []);
    });
  } finally {
    await browser.close();
    server.close();
    await client.close();
  }
});
