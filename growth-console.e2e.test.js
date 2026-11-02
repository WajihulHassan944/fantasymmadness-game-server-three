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
const env = { GROWTH_RESEARCH_PER_RUN: '0', /* research runs explicitly before the PR step */
  GROWTH_STAGING_MODE: 'isolated', GROWTH_OUTBOUND_ENABLED: 'false', GROWTH_TEST_MONGO_URI: uri, JWT_SECRET_ADMIN: secret, GROWTH_UNSUBSCRIBE_SECRET: secret,
  CRON_SECRET: 'cron-secret-for-tests-only', GROWTH_DELIVERY_PROVIDER: 'none', GROWTH_ADMIN_PASSWORD_HASH: hashPassword(PASSWORD),
  GROWTH_SOCIAL_PROVIDER: 'sandbox', GROWTH_ATTRIBUTION_INGEST_SECRET: 'i'.repeat(40),
};
const LIVE_AFFILIATE_ID = '0123456789abcdef01234567';
const signedPost = async (origin, event, { secretOverride, ts = Date.now() } = {}) => {
  const raw = JSON.stringify(event);
  const sig = require('crypto').createHmac('sha256', secretOverride || env.GROWTH_ATTRIBUTION_INGEST_SECRET).update(`${ts}.${raw}`).digest('hex');
  const r = await fetch(`${origin}/api/growth/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Growth-Timestamp': String(ts), 'X-Growth-Signature': `sha256=${sig}` }, body: raw });
  return { status: r.status, json: await r.json() };
};
const { contestFeed } = require('./growth-contest-feed.fixture');
const feed = contestFeed();
const { researchWeb } = require('./growth-podcast-research.fixture');
const web = researchWeb();
const podcastFetch = async (url, opts) => {
  const f = feed(url); if (f) return f;
  const w = await web(url, opts); if (w) return w;
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
  // A legacy campaign from the old logic (podcast name used as a fight): must be withdrawn automatically.
  await db.collection('growth_drafts').insertOne({ id: 'mkt-boxing-legacy', kind: 'marketing', genre: 'boxing', headline: 'Mannix and Mora: fight-week prediction challenge', text: 'Mannix and Mora: fight-week prediction challenge — make your picks on FANTASY MMADNESS.', status: 'needs_owner_review', ownerApproved: false, sendPermitted: false, createdAt: new Date(now - 30 * 3600000).toISOString() });
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
    if (await page.evaluate((hh) => location.hash === hh, hash)) await goto(hash.startsWith('#/overview') ? '#/automation' : '#/overview');
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
      // An edit that drops the fighters / link is blocked by the safeguard
      await page.fill('[data-testid=edit-text]', 'Win a $500 prize! Make your picks on FANTASY MMADNESS.');
      await page.click('[data-testid=modal-confirm]');
      await page.waitForFunction(() => /safeguard|fighter|money/i.test(document.querySelector('[data-testid=modal] .error')?.textContent || ''));
      const original = (await draft(first)).text;
      await page.fill('[data-testid=edit-title]', 'Fight week: pick every round');
      await page.fill('[data-testid=edit-text]', original + '\n\nWho are you taking?');
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
      // Filters (rejected = the owner's rejection + the legacy podcast campaign withdrawn by the safeguard)
      await page.selectOption('[data-testid=filter-status]', 'rejected');
      await page.waitForFunction(() => document.querySelectorAll('[data-testid=draft]').length === 2);
      assert.match(await page.textContent('[data-draft-id="mkt-boxing-legacy"]'), /Withdrawn automatically: not based on a verified/);
      await page.selectOption('[data-testid=filter-status]', '');
      await page.waitForFunction(() => document.querySelectorAll('[data-testid=draft]').length === 11);
      await page.selectOption('[data-testid=filter-sport]', 'boxing');
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=draft]')].length === 3);
      await page.selectOption('[data-testid=filter-kind]', 'pr');
      await page.waitForSelector('[data-testid=empty]');
    });

    await t.test('Marketing: copy post, mark published (with link validation), withdraw approval', async () => {
      await goto('#/marketing');
      assert.equal((await page.$$('[data-testid=coverage-row]')).length, 5);
      for (const sp of ['boxing', 'mma-ufc', 'kickboxing', 'bare-knuckle', 'pro-wrestling']) assert.match(await page.textContent(`[data-testid=coverage-row][data-sport="${sp}"]`), /Covered/);
      assert.match(await page.textContent('[data-testid=blocked-table]'), /Mannix and Mora vs Budocast/);
      const facts = await page.$$eval('[data-testid=fight-facts]', (els) => els.map((e) => e.textContent).join(' | '));
      assert.match(facts, /Naoya Inoue vs Murodjon Akhmadaliev/); assert.doesNotMatch(facts, /podcast|show \d/i);
      // Channel variants
      const anyCard = await page.getAttribute('[data-testid=marketing-list] [data-testid=draft]', 'data-draft-id');
      await page.click(`[data-draft-id="${anyCard}"] [data-testid=channel-x]`);
      assert.match(await page.textContent(`[data-draft-id="${anyCard}"] [data-testid=draft-text]`), /#FANTASYMMADNESS/);
      // Check now: idempotent, nothing new
      await page.click('[data-testid=btn-check-fights]');
      assert.match(await toastText(), /10 verified fights, 0 new campaigns/); await clearToasts();
      await page.waitForSelector('[data-testid=coverage-table]');
      await page.waitForSelector('[data-testid=marketing-list] [data-testid=draft]');
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

    await t.test('Public Relations: researched shows, evidence, auto-drafted pitch, manual contact fallback, approve', async () => {
      await runtime.researchBatch(new Date(), { limit: 20 }); // research every discovered show (normally 4 per 15-minute run)
      await goto('#/pr?sport=mma-ufc');
      await page.waitForSelector('[data-testid=prepared-row]');
      assert.ok(Number(await page.textContent('[data-testid=pr-researched] .value')) >= 3);
      assert.ok(Number(await page.textContent('[data-testid=pr-drafted] .value')) >= 1);
      await page.waitForFunction(() => document.querySelector('[data-testid=prepared-count]')?.textContent.includes('MMA'));
      // the show that published a business contact and discussed an upcoming fight got a personalized pitch
      const drafted = '[data-testid=prepared-row][data-outcome=drafted]';
      await page.waitForSelector(drafted);
      assert.match(await page.textContent(`${drafted} [data-testid=research-contact]`), /bookings@mma-ufc-podcast-1\.example/);
      assert.match(await page.textContent(drafted), /Mentioned Merab Dvalishvili/);
      await page.click(`${drafted} [data-testid=btn-view-template]`);
      await page.waitForSelector('[data-testid=prepared-list] [data-testid=email-preview]');
      assert.equal(await page.getAttribute('[data-testid=email-preview]', 'sandbox'), '');
      await shot('05-public-relations');
      const autoId = `pr-${await page.getAttribute(drafted, 'data-prospect-id')}`;
      const auto = await draft(autoId);
      assert.equal(auto.status, 'needs_owner_review'); assert.match(auto.subject, /round-by-round angle on Merab Dvalishvili vs Petr Yan/);
      // a hosting-platform address is never used
      assert.match(await page.textContent('[data-testid=prepared-list]'), /hosting platform \(anchor\.fm\)/);
      // manual fallback for a show that publishes no contact
      const noContact = '[data-testid=prepared-row][data-outcome=no_verified_contact_route]';
      const prospectId = await page.getAttribute(`${noContact} >> nth=-1`, 'data-prospect-id');
      await page.click(`[data-testid=prepared-row][data-prospect-id="${prospectId}"] [data-testid=btn-add-contact]`);
      await page.fill('[data-testid=contact-email]', 'bookings@mma-show.example');
      await page.click('[data-testid=modal-confirm]'); // consent missing
      await page.waitForFunction(() => document.querySelector('[data-testid=modal] .error')?.textContent.includes('consent'));
      await page.fill('[data-testid=contact-consent]', 'Listed as the booking contact on the show’s official website');
      await confirm(); assert.match(await toastText(), /Personalized email created/); await clearToasts();
      await page.waitForSelector(`[data-draft-id="pr-${prospectId}"]`);
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
      // the show now shows the contact you added, and no second "add contact" button
      await goto('#/pr?sport=mma-ufc');
      await page.waitForSelector(`[data-testid=prepared-row][data-prospect-id="${prospectId}"] .chip.good`);
      assert.equal(await page.locator(`[data-testid=prepared-row][data-prospect-id="${prospectId}"] [data-testid=btn-add-contact]`).count(), 0);
    });

    let affiliateProspect;
    await t.test('Affiliate Recruitment: auto-drafted proposal approved; manual contact validation', async () => {
      await goto('#/affiliates?sport=boxing');
      await page.waitForSelector('[data-testid=prepared-row]');
      assert.ok(Number(await page.textContent('[data-testid=affiliate-drafted] .value')) >= 4);
      await shot('06-affiliate-recruitment');
      const drafted = '[data-testid=prepared-row][data-outcome=drafted]';
      affiliateProspect = await page.getAttribute(drafted, 'data-prospect-id');
      const proposal = await draft(`affiliate-${affiliateProspect}`);
      assert.match(proposal.subject, /fan league for Naoya Inoue vs Murodjon Akhmadaliev/);
      assert.match(proposal.text, /affiliate program terms are shown on the sign-up page/);
      // manual contact form still validates addresses
      await page.click('[data-testid=prepared-row][data-outcome=no_verified_contact_route] [data-testid=btn-add-contact]');
      assert.equal(await page.inputValue('[data-testid=contact-kind]'), 'affiliate');
      await page.fill('[data-testid=contact-email]', 'not-an-email');
      await page.fill('[data-testid=contact-consent]', 'Creator applied through our affiliate interest form');
      await page.click('[data-testid=modal-confirm]');
      await page.waitForFunction(() => document.querySelector('[data-testid=modal] .error')?.textContent.length > 0);
      await page.click('[data-testid=modal-cancel]');
      await page.waitForSelector(`[data-draft-id="affiliate-${affiliateProspect}"]`);
      await page.click(`[data-draft-id="affiliate-${affiliateProspect}"] [data-testid=btn-approve]`); await confirm(); await clearToasts();
      await page.waitForSelector(`[data-draft-id="affiliate-${affiliateProspect}"][data-status=approved]`);
      // Onboarding pipeline: approved invitation -> invited -> active (linked to the live affiliate program)
      await goto('#/affiliates?sport=boxing');
      const row = `[data-testid=aff-row][data-aff-id="${affiliateProspect}"]`;
      await page.waitForSelector(`${row}[data-status=invite_prepared]`);
      await page.click(`${row} [data-testid=btn-copy-onboarding]`);
      assert.match(await page.evaluate(() => navigator.clipboard.readText()), /affiliate-create-account\?utm_source=fan_acquisition&utm_medium=partner_outreach&utm_campaign=combat_fans_aff_/);
      await clearToasts();
      await page.click(`${row} [data-testid=btn-aff-invited]`);
      await page.waitForSelector(`${row}[data-status=invited]`);
      await page.click(`${row} [data-testid=btn-aff-activate]`);
      await page.fill('[data-testid=live-affiliate-id]', 'not-an-id');
      await page.click('[data-testid=modal-confirm]');
      await page.waitForFunction(() => /live ID/.test(document.querySelector('[data-testid=modal] .error')?.textContent || ''));
      await page.fill('[data-testid=live-affiliate-id]', LIVE_AFFILIATE_ID);
      await confirm(); await clearToasts();
      await page.waitForSelector(`${row}[data-status=active]`);
      await page.click(`${row} [data-testid=btn-copy-player-link]`);
      assert.match(await page.evaluate(() => navigator.clipboard.readText()), new RegExp(`/fight/bx\\d+\\?play=1&ref=${LIVE_AFFILIATE_ID}&utm_source=fan_acquisition`));
      await clearToasts();
      await shot('06b-affiliate-onboarding');
    });

    await t.test('Revenue Attribution: tracked link + verified events from a signed server only', async () => {
      await goto('#/revenue');
      assert.match(await page.textContent('[data-testid=payment-banner]'), /not connected/);
      assert.equal(await page.textContent('[data-testid=rev-total] .value'), '$0.00');
      await page.waitForSelector('[data-testid=rev-affiliate-row]');
      await page.click('[data-testid=btn-copy-link]');
      assert.match(await page.evaluate(() => navigator.clipboard.readText()), new RegExp(`ref=${LIVE_AFFILIATE_ID}`));
      await clearToasts();
      const base = { liveAffiliateId: LIVE_AFFILIATE_ID, playerRef: 'player_0001', fightId: 'bx0000000001' };
      // Unsigned / wrongly signed / stale events are refused
      assert.equal((await signedPost(origin, { eventId: 'evt_bad_sig_1', type: 'registration', ...base }, { secretOverride: 'w'.repeat(40) })).status, 401);
      assert.equal((await signedPost(origin, { eventId: 'evt_stale_001', type: 'registration', ...base }, { ts: Date.now() - 10 * 60000 })).status, 401);
      assert.equal((await fetch(`${origin}/api/growth/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
      assert.equal((await signedPost(origin, { eventId: 'evt_no_player', type: 'registration', liveAffiliateId: LIVE_AFFILIATE_ID })).status, 422);
      // Verified events
      assert.equal((await signedPost(origin, { eventId: 'evt_reg_0001', type: 'registration', ...base })).json.attributedTo, affiliateProspect);
      assert.equal((await signedPost(origin, { eventId: 'evt_reg_0001', type: 'registration', ...base })).json.duplicate, true);
      await signedPost(origin, { eventId: 'evt_paid_001', type: 'paid_entry', ...base, entryId: 'entry-1', amountCents: 500, paymentStatus: 'settled' });
      await signedPost(origin, { eventId: 'evt_paid_002', type: 'paid_entry', ...base, entryId: 'entry-1', amountCents: 500, paymentStatus: 'settled' }); // same entry again
      await signedPost(origin, { eventId: 'evt_paid_003', type: 'paid_entry', ...base, entryId: 'entry-2', amountCents: 500, paymentStatus: 'pending' }); // not settled
      await db.collection('growth_attribution_events').insertOne({ type: 'paid_entry', verified: false, paymentStatus: 'settled', entryId: 'entry-3', amountCents: 500, affiliateId: affiliateProspect, referralAffiliateId: affiliateProspect, playerId: 'p3', fightId: 'f', at: new Date().toISOString() }); // browser-only, never counts
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

    await t.test('Publishing: schedule (approval-gated), sandbox publish, pause, cancel, interrupted-post recovery', async () => {
      // Only approved fight campaigns can be scheduled
      const pending = await db.collection('growth_drafts').findOne({ kind: 'marketing', status: 'needs_owner_review' });
      const tok = (await (await fetch(`${origin}/api/growth/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })).json()).token;
      const sch = await fetch(`${origin}/api/growth/admin/drafts/${pending.id}/schedule`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channels: ['x'], scheduledAt: new Date().toISOString() }) });
      assert.equal(sch.status, 409); assert.equal((await sch.json()).reason, 'approve_the_campaign_before_scheduling');
      // Schedule an approved campaign now, through the UI
      await goto('#/approvals?status=approved&kind=marketing');
      const id = await page.getAttribute('[data-testid=draft]', 'data-draft-id');
      await page.click(`[data-draft-id="${id}"] [data-testid=btn-schedule]`);
      await page.waitForSelector('[data-testid=schedule-time]');
      await page.evaluate(() => { const i = document.querySelector('[data-testid=schedule-time]'); const d = new Date(Math.floor(Date.now() / 60000) * 60000); i.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); });
      await confirm();
      assert.match(await toastText(), /scheduled/); await clearToasts();
      const scheduled = await db.collection('growth_social_posts').find({ draftId: id }).toArray();
      assert.ok(scheduled.length >= 2 && scheduled.every((p) => p.status === 'scheduled'));
      // Pause: nothing goes out
      await goto('#/publishing');
      await page.click('[data-testid=btn-toggle-pause]'); await confirm(); await clearToasts();
      await page.waitForSelector('[data-testid=paused-banner]');
      let out = await runtime.social.dispatch(new Date());
      assert.equal(out.paused, true); assert.equal(await db.collection('growth_social_posts').countDocuments({ draftId: id, status: 'published' }), 0);
      await page.click('[data-testid=btn-toggle-pause]'); await confirm(); await clearToasts();
      // The 15-minute run publishes them (sandbox: simulated, never counted as real posts)
      out = await runtime.social.dispatch(new Date());
      assert.equal(out.published, scheduled.length);
      assert.equal(await db.collection('growth_social_sandbox').countDocuments(), scheduled.length);
      assert.equal((await db.collection('growth_drafts').findOne({ id })).status, 'approved', 'sandbox posts do not mark the campaign published');
      await goto('#/publishing');
      await page.waitForSelector('[data-testid=post-row][data-status=published]');
      assert.match(await page.textContent('[data-testid=posts-table]'), /Sandbox \(simulated\)/);
      // Cannot schedule the same channel twice
      const again = await fetch(`${origin}/api/growth/admin/drafts/${id}/schedule`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channels: ['x'], scheduledAt: new Date(Date.now() + 3600000).toISOString() }) });
      assert.equal(again.status, 409);
      // Recovery: a post interrupted mid-publish is flagged, never re-posted automatically
      await db.collection('growth_social_posts').insertOne({ id: 'stuck__facebook', draftId: id, channel: 'facebook', genre: 'boxing', text: 'stuck post', status: 'publishing', claimedAt: new Date(Date.now() - 30 * 60000).toISOString(), scheduledAt: new Date(Date.now() - 31 * 60000).toISOString(), attempts: 1, history: [] });
      out = await runtime.social.dispatch(new Date());
      assert.equal(out.needsCheck, 1);
      await goto('#/publishing');
      await page.click('[data-post-id="stuck__facebook"] [data-testid=btn-check-post]');
      await page.click('[data-testid=modal-confirm]');
      await page.waitForFunction(() => /not already live/.test(document.querySelector('[data-testid=modal] .error')?.textContent || ''));
      await page.check('[data-testid=confirm-not-live]'); await confirm(); await clearToasts();
      await page.waitForSelector('[data-post-id="stuck__facebook"][data-status=scheduled]');
      await page.click('[data-post-id="stuck__facebook"] [data-testid=btn-cancel-post]'); await clearToasts();
      await page.waitForSelector('[data-post-id="stuck__facebook"][data-status=cancelled]');
      assert.ok((await db.collection('growth_alerts').findOne({ alertKey: 'social-check:stuck__facebook' })));
      await shot('10-publishing');
    });

    await t.test('Connections + funnel: every stage counted from its own evidence', async () => {
      await goto('#/connections');
      assert.match(await page.textContent('[data-testid=conn-social]'), /sandbox/);
      assert.match(await page.textContent('[data-testid=conn-email]'), /real sending: OFF/);
      assert.match(await page.textContent('[data-testid=conn-results]'), /Signed event channel/);
      await shot('11-connections');
      await goto('#/overview');
      await page.waitForSelector('[data-testid=funnel]');
      const v = async (k) => (await page.textContent(`[data-testid=funnel-${k}] .value`)).replace(/,/g, '');
      assert.ok(Number(await v('prospects')) >= 30);
      assert.equal(await v('approved'), '4');           // 2 marketing (1 approved + 1 published), 1 PR, 1 affiliate; withdrawn ones excluded
      assert.equal(await v('published'), '1');         // the one post the owner marked published; sandbox posts excluded
      assert.equal(await v('registrations'), '1');     // one signed registration (duplicate ignored)
      assert.equal(await v('paying'), '1');            // one settled, server-verified paid entry
      await goto('#/analytics'); await page.waitForSelector('[data-testid=funnel]');
    });

    await t.test('opted-out contact cannot be given an outreach email', async () => {
      await goto('#/pr?sport=mma-ufc');
      await page.waitForSelector('[data-testid=prepared-row][data-outcome=no_verified_contact_route] [data-testid=btn-add-contact]');
      await page.click('[data-testid=prepared-row][data-outcome=no_verified_contact_route] [data-testid=btn-add-contact] >> nth=0');
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
      const { signConsoleToken } = require('./growth-console-token');
      const stale = signConsoleToken(secret, { pwv: 'old-password-ver' }, { expiresIn: '1h' });
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
