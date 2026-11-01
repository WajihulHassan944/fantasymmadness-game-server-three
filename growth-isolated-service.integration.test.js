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
const { MongoClient } = require('mongodb');
const { registerIsolatedGrowthRoutes } = require('./growth-isolated-routes');
const { createGrowthRuntime } = require('./growth-runtime');
const { createDeliveryProvider } = require('./growth-delivery-provider');
const { resolveGrowthRuntimeConfig } = require('./growth-runtime-config');

const uri = process.env.GROWTH_TEST_MONGO_URI;
const skip = !uri || !/^mongodb:\/\/(127\.0\.0\.1|localhost)/.test(uri);
const secret = 's'.repeat(48);
const env = { GROWTH_STAGING_MODE: 'isolated', GROWTH_OUTBOUND_ENABLED: 'false', GROWTH_TEST_MONGO_URI: uri, JWT_SECRET_ADMIN: secret, GROWTH_UNSUBSCRIBE_SECRET: secret, CRON_SECRET: 'cron-secret-for-tests-only', GROWTH_DELIVERY_PROVIDER: 'sandbox-smtp', GROWTH_UNSUBSCRIBE_BASE_URL: 'https://growth.sandbox.localhost/api/growth/unsubscribe' };
const podcastFetch = async (url) => {
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
  const adminToken = jwt.sign({ email: 'owner@fmm-staging.test' }, secret);
  const call = async (method, path, { token, body, headers = {} } = {}) => {
    const h = { ...headers }; if (token) h.Authorization = `Bearer ${token}`; if (body) h['Content-Type'] = 'application/json';
    const r = await fetch(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };
  const runtime = await mounted.getRuntime();
  const T = (m) => new Date(Date.parse('2026-11-02T12:00:00Z') + m * 60000);
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
      assert.equal(disc.result.marketingDrafts, 5);
      assert.equal(disc.result.workstreams, 25);
      assert.ok(disc.result.newProspects >= 20);
      const drafts = await runtime.listDrafts({ kind: 'marketing', status: 'needs_owner_review' });
      assert.equal(new Set(drafts.map((d) => d.genre)).size, 5);
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
      const D = (m) => new Date(Date.parse('2026-11-03T08:00:00Z') + m * 60000);
      const states = [];
      for (const m of [0, 1, 3, 7]) {
        const s = await broken.tick({ now: D(m) });
        const j = s.jobs.find((x) => x.id === 'discover-20261103');
        if (j) states.push(j.state || 'ok');
      }
      assert.deepEqual(states, ['retry', 'retry', 'failed']);
      assert.ok((await broken.listAlerts()).some((a) => a.alertKey === 'job:discover-20261103:failed'));
      const rq = await call('POST', '/admin/jobs/discover-20261103/requeue', { token: adminToken });
      assert.equal(rq.json.ok, true);
      assert.equal((await client.db('fmgrowthtest').collection('unattended_jobs').findOne({ id: 'discover-20261103' })).state, 'retry');
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
    await t.test('daily report (due one minute after the day starts) aggregates drafts, deliveries, suppressions and alerts', async () => {
      const day = Date.parse('2026-11-04T09:00:00Z');
      await runtime.tick({ now: new Date(day) });
      assert.equal(await runtime.collections.reports.countDocuments({ day: '20261104' }), 0);
      const s = await runtime.tick({ now: new Date(day + 2 * 60000) });
      const job = s.jobs.find((j) => j.id === 'report-20261104');
      assert.equal(job?.ok, true, JSON.stringify(s));
      const rep = (await runtime.overview()).latestReport;
      assert.equal(rep.day, '20261104');
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
