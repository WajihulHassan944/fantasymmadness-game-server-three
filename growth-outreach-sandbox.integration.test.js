'use strict';
// PR/affiliate research -> personalized drafts -> owner approval -> SANDBOX email delivery
// (built exactly as it would be sent, stored, never sent), plus the synthetic money-path
// journey and the executive summary, on a real (loopback) MongoDB. Nothing leaves the machine:
// all public sources are stand-ins and no email provider is ever called.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { MongoClient } = require('mongodb');
const { registerIsolatedGrowthRoutes } = require('./growth-isolated-routes');
const { hashPassword } = require('./growth-backoffice');
const { signConsoleToken, consolePasswordVersion } = require('./growth-console-token');
const { contestFeed } = require('./growth-contest-feed.fixture');
const { researchWeb } = require('./growth-podcast-research.fixture');

const uri = process.env.GROWTH_TEST_MONGO_URI;
const skip = !uri || !/^mongodb:\/\/(127\.0\.0\.1|localhost)/.test(uri) ? 'needs loopback MongoDB' : false;

test('research-backed outreach, sandbox email delivery, synthetic money path, executive summary', { skip, timeout: 120000 }, async (t) => {
  const feed = contestFeed(); const web = researchWeb(); const outbound = [];
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    if (/resend\.com|sendgrid|mailgun|smtp/i.test(u)) outbound.push(u);
    const f = feed(u); if (f) return f;
    const w = await web(u, opts); if (w) return w;
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  const client = await new MongoClient(uri).connect();
  await client.db('fmgrowthtest').dropDatabase();
  const SECRET = 's'.repeat(48); const HASH = hashPassword('outreach sandbox test');
  const env = { GROWTH_STAGING_MODE: 'isolated', GROWTH_OUTBOUND_ENABLED: 'false', GROWTH_TEST_MONGO_URI: uri, JWT_SECRET_ADMIN: SECRET, GROWTH_UNSUBSCRIBE_SECRET: SECRET, CRON_SECRET: 'cron-secret-for-tests-only', GROWTH_DELIVERY_PROVIDER: 'sandbox-capture', GROWTH_ADMIN_PASSWORD_HASH: HASH, GROWTH_SOCIAL_PROVIDER: 'sandbox', GROWTH_ATTRIBUTION_INGEST_SECRET: 'i'.repeat(40), GROWTH_RESEARCH_PER_RUN: '0' };
  const app = express();
  const m = registerIsolatedGrowthRoutes({ app, env, express, fetchImpl, connect: async () => client });
  assert.equal(m.mounted, true, JSON.stringify(m.errors));
  const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/growth`;
  const token = signConsoleToken(SECRET, { pwv: consolePasswordVersion(HASH) });
  const call = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const rt = await m.getRuntime();
  const db = client.db('fmgrowthtest');
  try {
    await rt.tick({ now: new Date(Date.now() - 30 * 60000) });
    await rt.researchBatch(new Date(), { limit: 20 });

    await t.test('research API: one row per show, evidence, published contact or the reason there is none', async () => {
      const pr = (await call('GET', '/admin/research?track=pr')).json;
      assert.equal(pr.counts.drafted, 1); assert.equal(pr.bySport['mma-ufc'], 3);
      const d = pr.shows.find((x) => x.outcome === 'drafted');
      assert.equal(d.contact.email, 'bookings@mma-ufc-podcast-1.example'); assert.equal(d.contact.field, 'itunes:owner / itunes:email');
      assert.ok(d.evidence.some((e) => /Dvalishvili/.test(e.text))); assert.ok(d.angle.why);
      assert.ok(pr.shows.some((x) => x.outcome === 'no_verified_contact_route' && /anchor\.fm/.test(x.contactProblems.join())));
      const aff = (await call('GET', '/admin/research?track=affiliate')).json;
      assert.equal(aff.counts.drafted, 4);
      const ids = new Set([...pr.shows, ...aff.shows].map((x) => x.sourceUrl));
      assert.equal(ids.size, pr.shows.length + aff.shows.length, 'a show is in one department only');
    });

    let prDraft;
    await t.test('approved PR pitch is built in the sandbox outbox exactly as it would be sent; nothing is sent', async () => {
      prDraft = (await call('GET', '/admin/drafts?kind=pr&status=needs_owner_review')).json.drafts.find((x) => x.autoResearched);
      assert.ok(prDraft);
      assert.equal((await call('POST', `/admin/drafts/${encodeURIComponent(prDraft.id)}/approve`)).status, 200);
      const out = await rt.dispatch(new Date());
      assert.equal(out.delivered, 1, JSON.stringify(out));
      const d = await db.collection('growth_drafts').findOne({ id: prDraft.id });
      assert.equal(d.status, 'delivered'); assert.equal(d.sandbox, true); assert.equal(d.realDelivery, false); assert.match(d.providerMessageId, /^sandbox-/);
      const box = (await call('GET', '/admin/email/sandbox')).json;
      assert.equal(box.provider, 'sandbox-capture'); assert.equal(box.realDelivery, false); assert.equal(box.count, 1);
      const msg = box.messages[0];
      assert.equal(msg.message.from, 'FANTASY MMADNESS <contact@fantasymmadnesscom.com>');
      assert.deepEqual(msg.message.to, ['bookings@mma-ufc-podcast-1.example']);
      assert.match(msg.message.headers['List-Unsubscribe'], /^<https:\/\//); assert.equal(msg.message.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
      assert.match(msg.message.text, /Unsubscribe: https:\/\//);
      assert.ok(msg.checks.every((c) => c.ok), JSON.stringify(msg.checks));
      assert.equal(msg.sent, false); assert.equal(msg.network, false);
      assert.deepEqual(outbound, [], 'an email provider was contacted');
      // at most once
      await rt.dispatch(new Date());
      assert.equal((await call('GET', '/admin/email/sandbox')).json.count, 1);
    });

    await t.test('an address that opted out is never built or sent', async () => {
      const a = (await call('GET', '/admin/drafts?kind=affiliate&status=needs_owner_review')).json.drafts.find((x) => x.autoResearched);
      await call('POST', `/admin/drafts/${encodeURIComponent(a.id)}/approve`);
      await rt.suppression.suppress(a.recipient, { source: 'test', reason: 'opted out' });
      const out = await rt.dispatch(new Date());
      assert.equal(out.suppressed, 1);
      assert.equal((await db.collection('growth_drafts').findOne({ id: a.id })).status, 'suppressed');
      assert.equal((await call('GET', '/admin/email/sandbox')).json.count, 1);
    });

    await t.test('synthetic journey: click -> registration -> settled test payment -> accepted entry -> exactly one credit', async () => {
      const r = (await call('POST', '/admin/synthetic/journey')).json;
      assert.equal(r.ok, true, JSON.stringify(r.steps.filter((s) => !s.pass)));
      assert.equal(r.steps.length, 9);
      assert.equal(r.lane.steps.affiliateCredits, 1); assert.equal(r.lane.steps.acceptedEntries, 1); assert.equal(r.lane.steps.clicks, 1);
      assert.equal(r.lane.rejected.duplicate_entry, 1);
      const r2 = (await call('POST', '/admin/synthetic/journey')).json;
      assert.equal(r2.ok, true); assert.equal(r2.lane.steps.affiliateCredits, 2, 'each journey credits once');
      // real lane untouched
      const att = (await call('GET', '/admin/attribution')).json.attribution;
      assert.equal(att.creditedEntries, 0); assert.equal(att.payingPlayers, 0); assert.equal(att.totalRevenueCents, 0);
      assert.ok(!att.affiliates.some((x) => x.id === 'syn-affiliate'));
      const funnel = (await call('GET', '/admin/funnel')).json.funnel;
      assert.equal(funnel.stages.find((s) => s.key === 'registrations').value, 0);
      assert.equal(funnel.stages.find((s) => s.key === 'paying').value, 0);
      assert.ok(!(await call('GET', '/admin/affiliates')).json.affiliates.some((x) => x.id === 'syn-affiliate'));
      // the synthetic affiliate cannot be credited by a real (non-syn_) event
      const raw = JSON.stringify({ eventId: 'evt_real_000001', type: 'registration', playerRef: 'player_000001', liveAffiliateId: 'feedfacefeedfacefeedface' });
      const ts = String(Date.now()); const sig = require('crypto').createHmac('sha256', 'i'.repeat(40)).update(`${ts}.${raw}`).digest('hex');
      const real = await fetch(`${base}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-growth-timestamp': ts, 'x-growth-signature': sig }, body: raw });
      assert.equal(real.status, 422); assert.equal((await real.json()).reason, 'synthetic_affiliate_is_test_only');
    });

    await t.test('funnel separates researched, drafted, sandbox-captured and really delivered', async () => {
      const st = (await call('GET', '/admin/funnel')).json.funnel.stages;
      assert.ok(st.find((s) => s.key === 'researched').value >= 15);
      assert.equal(st.find((s) => s.key === 'drafted').value, 5);
      const emails = st.find((s) => s.key === 'emails');
      assert.equal(emails.value, 0); assert.equal(emails.detail.sandboxCaptured, 1);
    });

    await t.test('executive summary: honest department status, exceptions and autonomy statement', async () => {
      const ex = (await call('GET', '/admin/executive')).json;
      assert.deepEqual(ex.departments.map((d) => d.key), ['marketing', 'pr', 'affiliates', 'publishing', 'automation', 'revenue']);
      const pr = ex.departments.find((d) => d.key === 'pr');
      assert.equal(pr.status, 'ok'); assert.match(pr.headline, /published business contact/); assert.ok(pr.facts.some((f) => /sandbox outbox \(not sent\)/.test(f)));
      assert.match(ex.departments.find((d) => d.key === 'revenue').facts.join(), /Last synthetic journey PASSED/);
      assert.equal(ex.departments.find((d) => d.key === 'publishing').status, 'blocked', 'Meta not connected in this test');
      assert.ok(ex.autonomy.needsOwner.some((x) => /Approving every campaign/.test(x)));
      assert.ok(ex.autonomy.notConnected.some((x) => /Real email sending/.test(x)));
      assert.ok(Array.isArray(ex.exceptions));
    });
  } finally {
    server.close(); await client.close();
  }
});
