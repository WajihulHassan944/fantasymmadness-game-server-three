'use strict';
// Isolated Growth Engine service end to end on a real (loopback) MongoDB:
// HTTP routes, cron auth, scheduled ticks, duplicate prevention, discovery ->
// drafts -> owner approval -> sandbox delivery with unsubscribe, opt-out
// enforcement, at-most-once delivery, failure alerts, stale-run recovery,
// retry exhaustion + requeue, and the "no provider" hold. No network: discovery
// uses a stub of the public podcast API; mail goes to an in-memory transport.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { signConsoleToken, consolePasswordVersion } = require('./growth-console-token');
const { MongoClient } = require('mongodb');
const { registerIsolatedGrowthRoutes } = require('./growth-isolated-routes');
const { createGrowthRuntime } = require('./growth-runtime');
const { createDeliveryProvider } = require('./growth-delivery-provider');
const { resolveGrowthRuntimeConfig } = require('./growth-runtime-config');

const uri = process.env.GROWTH_TEST_MONGO_URI;
const skip = !uri || !/^mongodb:\/\/(127\.0\.0\.1|localhost)/.test(uri);
const secret = 's'.repeat(48);
const env = { GROWTH_STAGING_MODE: 'isolated', GROWTH_OUTBOUND_ENABLED: 'false', GROWTH_TEST_MONGO_URI: uri, JWT_SECRET_ADMIN: secret, GROWTH_UNSUBSCRIBE_SECRET: secret, CRON_SECRET: 'cron-secret-for-tests-only', GROWTH_DELIVERY_PROVIDER: 'sandbox-smtp', GROWTH_UNSUBSCRIBE_BASE_URL: 'https://growth.sandbox.localhost/api/growth/unsubscribe' };
const { contestFeed } = require('./growth-contest-feed.fixture');
// Simulated days start at noon (UTC) a year after today, so they never coincide with the
// real-time cron call made in this test (a fixed calendar date eventually becomes "today").
const BASE = (() => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() + 1); d.setUTCHours(12, 0, 0, 0); return d.getTime(); })();
const feed = contestFeed(() => BASE);
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, ''); // e.g. 20271102
const DAY1 = dayKey(BASE + 86400000); const DAY2 = dayKey(BASE + 2 * 86400000);
const podcastFetch = async (url) => {
  const f = feed(url); if (f) return f;
  const term = new URL(url).searchParams.get('term');
  const slug = term.replace(/[^a-z]+/gi, '-').toLowerCase();
  return { ok: true, status: 200, json: async () => ({ results: [1, 2].map((n) => ({ collectionName: `${term} show ${n}`, collectionViewUrl: `https://podcasts.apple.com/us/podcast/${slug}-${n}/id${n}` })) }) };
};
const failingFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });

test('isolated Growth Engine service', { skip }, async (t) => {
  const mail = [];
  let failNext = '';
  const transport = { sendMail: async (m) => { if (failNext && m.to === failNext) throw new Error('SMTP 451 temporary failure'); mail.push(m); return { messageId: `<m${mail.length}@sandbox>` }; } };
  const client = await new MongoClient(uri).connect();
  await client.db('fmgrowthtest').dropDatabase();
  const app = express();
  const mounted = registerIsolatedGrowthRoutes({ app, env, express, transport, fetchImpl: podcastFetch, connect: async () => client });
  assert.equal(mounted.mounted, true);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/growth`;
  const adminToken = signConsoleToken(secret, { email: 'owner@fmm-staging.test', pwv: consolePasswordVersion(env.GROWTH_ADMIN_PASSWORD_HASH) });
  // A token signed directly with JWT_SECRET_ADMIN (what the live backend issues) is refused.
  assert.equal((await fetch(`${base}/admin/overview`, { headers: { Authorization: `Bearer ${jwt.sign({ email: 'owner@fmm-staging.test', role: 'growth_owner', pwv: consolePasswordVersion(env.GROWTH_ADMIN_PASSWORD_HASH) }, secret)}` } })).status, 401);
  const call = async (method, path, { token, body, headers = {} } = {}) => {
    const h = { ...headers }; if (token) h.Authorization = `Bearer ${token}`; if (body) h['Content-Type'] = 'application/json';
    const r = await fetch(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };
  const runtime = await mounted.getRuntime();
  const T = (m) => new Date(BASE + m * 60000);
  try {
    await t.test('health reports a valid isolated configuration', async () => {
      const h = await call('GET', '/health');
      assert.equal(h.status, 200); assert.equal(h.json.ok, true); assert.equal(h.json.database.name, 'fmgrowthtest');
    });
    await t.test('cron endpoint requires the cron secret', async () => {
      assert.equal((await call('GET', '/cron/tick')).status, 401);
      assert.equal((await call('GET', '/cron/tick', { token: 'wrong' })).status, 401);
      const ok = await call('GET', '/cron/tick', { token: env.CRON_SECRET });
      assert.equal(ok.status, 200); assert.ok(ok.json.summary.runId);
    });
    await t.test('scheduled tick: discovery -> prospects, marketing drafts per sport, 25 workstreams', async () => {
      const s = await runtime.tick({ now: T(0) });
      const disc = s.jobs.find((j) => j.id.startsWith('discover-'));
      assert.equal(disc.ok, true, JSON.stringify(s));
      assert.equal(await runtime.collections.drafts.countDocuments({ kind: 'marketing', contestId: { $exists: true } }), 10); // 2 verified contests x 5 sports (one campaign per contest, not per day); invalid contests rejected
      assert.equal(disc.result.workstreams, 25);
      assert.ok(disc.result.prospectsFound >= 20); // already stored by the earlier cron call, so newProspects may be 0
      assert.ok(await runtime.collections.prospects.countDocuments() >= 20);
      const ws = runtime.collections.workstreams;
      for (const fn of ['public-relations', 'affiliate-recruitment']) {
        const withDrafts = await ws.distinct('genre', { runId: s.runId.replace('growth_', 'growth_'), functionName: fn, 'data.drafts.0': { $exists: true } });
        assert.equal(withDrafts.length, 5, `${fn} drafts prepared for all five sports`);
      }
      const drafts = await runtime.listDrafts({ kind: 'marketing', status: 'needs_owner_review' });
      assert.equal(new Set(drafts.map((d) => d.genre)).size, 5);
      for (const d of drafts) { assert.ok(d.contestId && d.text.includes(d.contest.fighterA) && d.text.includes(d.contest.fighterB)); assert.doesNotMatch(d.text, /podcast|show \d/i); }
    });
    await t.test('duplicate invocation in the same minute is skipped', async () => {
      assert.equal((await runtime.tick({ now: T(0) })).skipped, 'duplicate_invocation');
    });
    await t.test('back office requires admin auth and returns an overview', async () => {
      assert.equal((await call('GET', '/admin/overview')).status, 401);
      const o = await call('GET', '/admin/overview', { token: adminToken });
      assert.equal(o.status, 200); assert.ok(o.json.overview.prospects >= 20); assert.ok(o.json.overview.draftsAwaitingReview >= 5);
    });
    let prDraftId, prospects;
    await t.test('owner adds a verified contact -> personalized PR draft awaiting review', async () => {
      prospects = (await call('GET', '/admin/prospects', { token: adminToken })).json.prospects.filter((p) => p.focus === 'partners');
      const missingConsent = await call('POST', `/admin/prospects/${prospects[0].id}/contact`, { token: adminToken, body: { contact: 'editor@sandbox.localhost', kind: 'pr' } });
      assert.equal(missingConsent.status, 422); assert.equal(missingConsent.json.reason, 'consent_basis_required');
      const r = await call('POST', `/admin/prospects/${prospects[0].id}/contact`, { token: adminToken, body: { contact: 'editor@sandbox.localhost', kind: 'pr', consentNote: 'Public press contact on outlet website; business outreach' } });
      assert.equal(r.status, 201, r.text); prDraftId = r.json.draft.id;
      assert.equal(r.json.draft.status, 'needs_owner_review');
      assert.match(r.json.draft.html, /round-by-round fight predictions/);
    });
    await t.test('unapproved drafts are never delivered', async () => {
      await runtime.tick({ now: T(1) });
      assert.equal(mail.length, 0);
    });
    await t.test('approved draft is delivered once to the sandbox, with unsubscribe link and header', async () => {
      const a = await call('POST', `/admin/drafts/${prDraftId}/approve`, { token: adminToken });
      assert.equal(a.status, 200);
      assert.equal((await call('POST', `/admin/drafts/${prDraftId}/approve`, { token: adminToken })).status, 409);
      const s = await runtime.tick({ now: T(2) });
      assert.equal(s.delivery.delivered, 1, JSON.stringify(s.delivery));
      assert.equal(mail.length, 1);
      assert.equal(mail[0].to, 'editor@sandbox.localhost');
      assert.match(mail[0].text, /Unsubscribe: https:\/\/growth\.sandbox\.localhost\/api\/growth\/unsubscribe\?token=/);
      assert.match(mail[0].headers['List-Unsubscribe'], /token=/);
      await runtime.tick({ now: T(3) });
      assert.equal(mail.length, 1, 'no resend on the next tick');
      const d = (await runtime.listDrafts({ status: 'delivered' })).find((x) => x.id === prDraftId);
      assert.equal(d.sandbox, true); assert.equal(d.realDelivery, false);
    });
    await t.test('one-click unsubscribe suppresses the address everywhere', async () => {
      const token = decodeURIComponent(mail[0].text.match(/token=([^\s]+)/)[1]);
      assert.equal((await call('GET', `/unsubscribe?token=${encodeURIComponent(token)}x`)).status, 400);
      const u = await call('GET', `/unsubscribe?token=${encodeURIComponent(token)}`);
      assert.equal(u.status, 200); assert.match(u.text, /unsubscribed/);
      const again = await call('POST', `/admin/prospects/${prospects[1].id}/contact`, { token: adminToken, body: { contact: 'EDITOR@sandbox.localhost', kind: 'affiliate', consentNote: 'x' } });
      assert.equal(again.json.reason, 'contact_opted_out');
    });
    await t.test('an approved draft to an address that opts out before delivery is suppressed, not sent', async () => {
      const r = await call('POST', `/admin/prospects/${prospects[2].id}/contact`, { token: adminToken, body: { contact: 'creator@sandbox.localhost', kind: 'affiliate', consentNote: 'Creator business inquiries address' } });
      await call('POST', `/admin/drafts/${r.json.draft.id}/approve`, { token: adminToken });
      await runtime.suppression.unsubscribe(runtime.suppression.token('creator@sandbox.localhost'));
      const s = await runtime.tick({ now: T(4) });
      assert.equal(s.delivery.suppressed, 1);
      assert.equal(mail.length, 1);
    });
    await t.test('delivery failure raises one alert; the failed draft is not retried automatically', async () => {
      const r = await call('POST', `/admin/prospects/${prospects[3].id}/contact`, { token: adminToken, body: { contact: 'fail@sandbox.localhost', kind: 'pr', consentNote: 'Press contact' } });
      await call('POST', `/admin/drafts/${r.json.draft.id}/approve`, { token: adminToken });
      failNext = 'fail@sandbox.localhost';
      const s = await runtime.tick({ now: T(5) });
      assert.equal(s.delivery.failed, 1);
      const alerts = (await call('GET', '/admin/alerts', { token: adminToken })).json.alerts;
      assert.ok(alerts.some((a) => a.kind === 'delivery' && a.id === r.json.draft.id));
      failNext = '';
      await runtime.tick({ now: T(6) });
      assert.equal(mail.filter((m) => m.to === 'fail@sandbox.localhost').length, 0);
      assert.equal((await call('POST', `/admin/alerts/${encodeURIComponent(`delivery:${r.json.draft.id}`)}/ack`, { token: adminToken })).json.ok, true);
    });
    await t.test('stale interrupted run is detected and alerted', async () => {
      await runtime.collections.runs.insertOne({ runId: 'growth_202611021000', state: 'claimed', mode: 'isolated', createdAt: T(-120).toISOString() });
      const s = await runtime.tick({ now: T(7) });
      assert.equal(s.recoveredStaleRuns, 1);
      assert.equal((await runtime.collections.runs.findOne({ runId: 'growth_202611021000' })).state, 'stale');
      assert.ok((await runtime.listAlerts()).some((a) => a.kind === 'run' && a.id === 'growth_202611021000'));
    });
    await t.test('a failing provider retries with backoff, then alerts once; admin can requeue', async () => {
      const resolved = resolveGrowthRuntimeConfig(env);
      const broken = createGrowthRuntime({ db: client.db('fmgrowthtest'), config: resolved.config, secrets: resolved.secrets, provider: createDeliveryProvider({ config: resolved.config, secrets: resolved.secrets, transport }), fetchImpl: failingFetch });
      const D = (m) => new Date(BASE + (24 * 60 - 4 * 60) * 60000 + m * 60000); // next day 08:00 UTC
      const states = [];
      for (const m of [0, 1, 3, 7]) {
        const s = await broken.tick({ now: D(m) });
        const j = s.jobs.find((x) => x.id === `discover-${DAY1}`);
        if (j) states.push(j.state || 'ok');
      }
      assert.deepEqual(states, ['retry', 'retry', 'failed']);
      assert.ok((await broken.listAlerts()).some((a) => a.alertKey === `job:discover-${DAY1}:failed`));
      const rq = await call('POST', `/admin/jobs/discover-${DAY1}/requeue`, { token: adminToken });
      assert.equal(rq.json.ok, true);
      assert.equal((await client.db('fmgrowthtest').collection('unattended_jobs').findOne({ id: `discover-${DAY1}` })).state, 'retry');
    });
    await t.test('with no delivery provider, approved emails are held, never sent', async () => {
      const resolved = resolveGrowthRuntimeConfig({ ...env, GROWTH_DELIVERY_PROVIDER: 'none' });
      const held = createGrowthRuntime({ db: client.db('fmgrowthtest'), config: resolved.config, secrets: resolved.secrets, provider: createDeliveryProvider({ config: resolved.config }), fetchImpl: podcastFetch });
      const r = await held.addVerifiedContact(prospects[4].id, { contact: 'held@sandbox.localhost', kind: 'pr', consentNote: 'Press contact', admin: 'owner' });
      await held.approveDraft(r.draft.id, { admin: 'owner' });
      const before = mail.length;
      const s = await held.tick({ now: T(30) });
      assert.ok(s.delivery.held >= 1);
      assert.equal(mail.length, before);
    });
    await t.test('publishing gates: not connected -> held; fight no longer verified -> cancelled', async () => {
      const d = (await runtime.listDrafts({ kind: 'marketing', status: 'needs_owner_review' }))[0];
      assert.equal((await runtime.approveDraft(d.id, { admin: 'owner', now: T(40) })).ok, true);
      const s1 = await runtime.social.schedule(d.id, { channels: ['x', 'facebook'], scheduledAt: T(41).toISOString(), admin: 'owner', now: T(40) });
      assert.equal(s1.ok, true, JSON.stringify(s1));
      const out = await runtime.social.dispatch(T(42));
      assert.equal(out.held, 2); // provider "none": nothing is posted
      const held = await runtime.social.list({ status: 'held' });
      assert.ok(held.every((p) => /provider is "none"/.test(p.heldReason)));
      // Owner retries after "connecting"; the fight has meanwhile disappeared from the contest list
      for (const p of held) assert.equal((await runtime.social.retry(p.id, { admin: 'owner', now: T(43) })).ok, true);
      const resolved = resolveGrowthRuntimeConfig({ ...env, GROWTH_SOCIAL_PROVIDER: 'sandbox', GROWTH_DELIVERY_PROVIDER: 'none' });
      const emptyFeed = async (url) => (url.includes('/api/public/') ? { ok: true, status: 200, json: async () => ({ items: [] }) } : podcastFetch(url));
      const other = createGrowthRuntime({ db: client.db('fmgrowthtest'), config: resolved.config, secrets: resolved.secrets, provider: createDeliveryProvider({ config: resolved.config }), fetchImpl: emptyFeed });
      const out2 = await other.social.dispatch(T(50));
      assert.equal(out2.cancelled, 2); assert.equal(out2.published, 0);
      assert.ok((await other.social.list({ status: 'cancelled' })).every((p) => p.cancelReason === 'contest_no_longer_open_or_verified'));
    });
    await t.test('daily report (due one minute after the day starts) aggregates drafts, deliveries, suppressions and alerts', async () => {
      const day = BASE + (2 * 24 * 60 - 3 * 60) * 60000; // two days later, 09:00 UTC
      await runtime.tick({ now: new Date(day) });
      assert.equal(await runtime.collections.reports.countDocuments({ day: DAY2 }), 0);
      const s = await runtime.tick({ now: new Date(day + 2 * 60000) });
      const job = s.jobs.find((j) => j.id === `report-${DAY2}`);
      assert.equal(job?.ok, true, JSON.stringify(s));
      const rep = (await runtime.overview()).latestReport;
      assert.equal(rep.day, DAY2);
      assert.equal(rep.suppressions, 2);
      assert.ok(rep.draftsByStatus.delivered >= 1);
      assert.ok(rep.openAlerts >= 2);
      assert.equal(rep.provider, 'sandbox-smtp');
      assert.equal(rep.realDelivery, false);
    });
  } finally {
    server.close();
    await client.db('fmgrowthtest').dropDatabase();
    await client.close();
  }
});
