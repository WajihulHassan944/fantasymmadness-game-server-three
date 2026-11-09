'use strict';
// APPROVE ALL & SEND + Autonomous Mode acceptance tests.
// Runs against real MongoDB when GROWTH_TEST_MONGO_URI points at a local server (CI),
// otherwise against a small in-memory stand-in so it can run anywhere.
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto'), path = require('node:path');

// Contest timing rules are covered by their own tests; here they are controlled per draft.
const expired = new Set();
require.cache[require.resolve('./growth-contest-campaigns')] = { id: 'stub', filename: 'stub', loaded: true, exports: { checkCampaign: d => expired.has(d.id) ? ['event_date_in_past'] : [] } };
require.cache[require.resolve('./growth-smtp-relay-provider')] = { id: 'stub2', filename: 'stub2', loaded: true, exports: { TEST_ID: 'controlled-test' } };
const { createProductionDistribution } = require('./growth-production-distribution');
const { createProductionReview, contentVersion } = require('./growth-production-review');
const { createBulkAutonomy, templateOf, normalizePolicy } = require('./growth-production-bulk-autonomy');

// ---------- minimal in-memory Mongo stand-in ----------
function get(doc, key) { return key.split('.').reduce((v, k) => (v == null ? undefined : v[k]), doc); }
function eq(a, b) { if (b === null) return a === null || a === undefined; return JSON.stringify(a) === JSON.stringify(b); }
function matchCond(v, c) {
  if (c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).some(k => k[0] === '$')) {
    return Object.entries(c).every(([op, x]) => {
      if (op === '$in') return x.some(y => eq(v, y));
      if (op === '$ne') return !eq(v, x);
      if (op === '$eq') return eq(v, x);
      if (op === '$exists') return (v !== undefined) === x;
      if (op === '$gte') return v !== undefined && v >= x;
      if (op === '$gt') return v !== undefined && v > x;
      if (op === '$lte') return v !== undefined && v <= x;
      if (op === '$lt') return v !== undefined && v < x;
      if (op === '$not') return !matchCond(v, x);
      if (op === '$regex') return new RegExp(x).test(v);
      throw Error('unsupported op ' + op);
    });
  }
  return eq(v, c);
}
function matches(doc, f = {}) { return Object.entries(f).every(([k, c]) => k === '$or' ? c.some(x => matches(doc, x)) : matchCond(get(doc, k), c)); }
function setPath(doc, key, val) { const ks = key.split('.'); let o = doc; for (const k of ks.slice(0, -1)) o = o[k] ||= {}; o[ks.at(-1)] = val; }
function apply(doc, u, inserting) {
  for (const [k, v] of Object.entries(u.$set || {})) setPath(doc, k, structuredClone(v));
  if (inserting) for (const [k, v] of Object.entries(u.$setOnInsert || {})) setPath(doc, k, structuredClone(v));
  for (const [k, v] of Object.entries(u.$inc || {})) setPath(doc, k, (get(doc, k) || 0) + v);
  for (const [k, v] of Object.entries(u.$push || {})) setPath(doc, k, [...(get(doc, k) || []), structuredClone(v)]);
  for (const k of Object.keys(u.$unset || {})) delete doc[k];
}
function project(doc, p) { if (!p) return structuredClone(doc); const out = structuredClone(doc); const zero = Object.entries(p).filter(([, v]) => v === 0).map(([k]) => k); if (zero.length) { for (const k of zero) delete out[k]; return out; } const keep = { _id: out._id }; for (const k of Object.keys(p)) if (get(out, k) !== undefined) setPath(keep, k, get(out, k)); return keep; }
function memoryCollection() {
  const rows = [], uniques = [['_id']];
  const dup = d => uniques.some(keys => rows.some(r => r !== d && keys.every(k => get(r, k) !== undefined && eq(get(r, k), get(d, k)))));
  const fail = () => { const e = Error('E11000 duplicate key'); e.code = 11000; return e; };
  const c = {
    async createIndex(spec, o = {}) { if (o.unique) uniques.push(Object.keys(spec)); },
    async insertOne(d) { const doc = structuredClone(d); doc._id ??= crypto.randomUUID(); if (dup(doc)) throw fail(); rows.push(doc); return { insertedId: doc._id }; },
    async findOne(f, o = {}) { const r = rows.find(x => matches(x, f)); return r ? project(r, o.projection) : null; },
    find(f = {}, o = {}) { let list = rows.filter(x => matches(x, f)), lim = Infinity; const cur = { sort(s) { const [[k, dir]] = Object.entries(s); list = [...list].sort((a, b) => (get(a, k) > get(b, k) ? 1 : get(a, k) < get(b, k) ? -1 : 0) * dir); return cur; }, limit(n) { lim = n; return cur; }, async toArray() { return list.slice(0, lim).map(x => project(x, o.projection)); }, async next() { return list[0] ? project(list[0], o.projection) : null; } }; return cur; },
    async countDocuments(f = {}) { return rows.filter(x => matches(x, f)).length; },
    async updateOne(f, u, o = {}) { const r = rows.find(x => matches(x, f)); if (r) { const copy = structuredClone(r); apply(copy, u, false); if (dup(Object.assign(copy, { __self: 1 })) && false) throw fail(); delete copy.__self; Object.keys(r).forEach(k => delete r[k]); Object.assign(r, copy); return { matchedCount: 1, modifiedCount: 1 }; } if (o.upsert) { const doc = {}; for (const [k, v] of Object.entries(f)) if (k[0] !== '$' && (v === null || typeof v !== 'object' || Array.isArray(v))) setPath(doc, k, v); apply(doc, u, true); await c.insertOne(doc); return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }; } return { matchedCount: 0, modifiedCount: 0 }; },
    async updateMany(f, u) { let n = 0; for (const r of rows.filter(x => matches(x, f))) { apply(r, u, false); n++; } return { modifiedCount: n }; },
    async findOneAndUpdate(f, u, o = {}) { const r = rows.find(x => matches(x, f)); if (r) { apply(r, u, false); return structuredClone(r); } if (o.upsert) { const doc = {}; for (const [k, v] of Object.entries(f)) if (k[0] !== '$' && (v === null || typeof v !== 'object')) setPath(doc, k, v); apply(doc, u, true); await c.insertOne(doc); return structuredClone(doc); } return null; },
    async deleteOne(f) { const i = rows.findIndex(x => matches(x, f)); if (i >= 0) rows.splice(i, 1); },
    async drop() { rows.length = 0; },
  };
  return c;
}

async function database() {
  const uri = process.env.GROWTH_TEST_MONGO_URI;
  if (/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri || '')) {
    const { MongoClient } = require('mongodb'); const client = await new MongoClient(uri).connect(); const raw = client.db('growth_bulk_autonomy_local'), prefix = crypto.randomBytes(6).toString('hex') + '_', names = [];
    return { kind: 'mongodb', collection: n => { names.push(prefix + n); return raw.collection(prefix + n); }, close: async () => { for (const n of names) await raw.collection(n).drop().catch(() => {}); await client.close(); } };
  }
  const cols = {}; return { kind: 'memory', collection: n => (cols[n] ||= memoryCollection()), close: async () => {} };
}

test('APPROVE ALL & SEND and Autonomous Mode: owner-only, exact preview, one confirmation, holds, duplicates, limits, receipts, emergency stop, rollback, worker continuity', async () => {
  const store = await database();
  console.log('database:', store.kind);
  const owner = 'a'.repeat(24), stranger = 'b'.repeat(24);
  let time = new Date('2026-11-10T15:00:00Z'); // 10:00 Eastern, inside the send window
  const clock = () => time;
  const col = { drafts: store.collection('drafts'), settings: store.collection('settings'), audit: store.collection('audit'), ownerCampaignHolds: store.collection('holds') };
  const queue = store.collection('queue');
  const sent = []; let emailReply = () => ({ ok: true, receipt: { providerMessageId: 'msg-' + sent.length, status: 'accepted', delivered: false } });
  const email = { readiness: async () => ({ ready: true, provider: 'gmail-smtp', sender: 'contact@fantasymmadnesscom.com' }), send: async m => { sent.push(['email', m.recipient]); return emailReply(m); } };
  const meta = { readiness: async () => ({ facebook: { ready: true, destinationId: 'fb-page', name: 'FANTASY MMADNESS Page' }, instagram: { ready: true, destinationId: 'ig-acct', name: '@fantasymmadness' } }), publish: async p => { sent.push([p.channel, p.destinationId]); return { ok: true, receipt: { providerPostId: p.channel + '-post-' + sent.length, status: 'published' } }; } };
  const blocked = {}; const quality = async d => blocked[d.id] || [];
  const distribution = createProductionDistribution({ col, queue, quality, email, meta, owners: [owner], clock, enabled: true, reverifyMarketing: async () => ({ ok: true }) });
  await distribution.init();
  const review = createProductionReview({ col, quality, clock });
  const make = (released = true) => createBulkAutonomy({ db: { collection: n => store.collection('b_' + n) }, col, queue, distribution, review, owners: [owner], clock, autoApprovalReleased: released });
  const engine = make(); await engine.init();
  const mkt = (id, extra = {}) => ({ id, kind: 'marketing', genre: 'boxing', contestId: 'c-' + id, contestFingerprint: 'f1', contest: { id: 'c-' + id, sport: 'boxing' }, headline: 'Fight ' + id, text: 'Pick the winner ' + id, posts: { facebook: 'FB copy ' + id, instagram: 'IG copy ' + id, x: 'X copy ' + id }, channels: ['facebook', 'x'], platformCopy: { facebook: { ready: true }, instagram: { ready: true } }, copyVersion: 2, poster: { portrait: { url: 'https://img.example/' + id + '.jpg' } }, status: 'needs_owner_review', ownerApproved: false, sendPermitted: false, createdAt: time.toISOString(), ...extra });
  const pr = (id, extra = {}) => ({ id, kind: 'pr', genre: 'mma-ufc', recipient: id + '@show.example', subject: 'Story idea ' + id, text: 'Hello ' + id, html: '<p>Hello</p>', contactSource: 'https://show.example/feed', consentBasis: 'published_business_contact', emailQualityVersion: 2, listUnsubscribe: 'https://u.example/x', status: 'needs_owner_review', ownerApproved: false, sendPermitted: false, createdAt: time.toISOString(), ...extra });
  try {
    await col.drafts.insertOne(mkt('m1'));
    await col.drafts.insertOne(mkt('m2'));
    await col.drafts.insertOne(mkt('m-expired')); expired.add('m-expired');
    await col.drafts.insertOne(mkt('m-held')); await col.ownerCampaignHolds.insertOne({ _id: 'm-held', active: true });
    await col.drafts.insertOne(pr('p1'));
    await col.drafts.insertOne(pr('p-unverified')); blocked['p-unverified'] = ['verified_recipient_contact_required'];
    await col.drafts.insertOne(pr('p-edited', { editCount: 1 }));
    await col.drafts.insertOne({ ...pr('a1'), id: 'a1', kind: 'affiliate' });
    await col.drafts.insertOne(pr('p-rejected', { status: 'rejected' }));

    assert.equal(templateOf(await col.drafts.findOne({ id: 'p-edited' })), null, 'hand-edited campaigns never match a template');
    assert.equal(templateOf(await col.drafts.findOne({ id: 'm1' })), 'marketing/platform-copy-v2');

    // ---- owner-only ----
    assert.equal((await engine.bulkPreview(stranger)).ok, false);

    // ---- preview: exact content, destinations, schedules, totals; held items excluded ----
    const p = await engine.bulkPreview(owner);
    assert.equal(p.ok, true);
    const included = p.items.map(i => i.draftId + ':' + i.channel).sort();
    assert.deepEqual(included, ['m1:facebook', 'm1:instagram', 'm2:facebook', 'm2:instagram', 'p-edited:email', 'p1:email']);
    assert.equal(p.totals.campaigns, 4); assert.equal(p.totals.deliveries, 6);
    const reasonsFor = id => p.excluded.filter(x => x.draftId === id).flatMap(x => x.reasons);
    assert.ok(reasonsFor('m-expired').includes('expired_after_fight_entry_deadline'));
    assert.ok(reasonsFor('m-held').includes('owner_campaign_hold'));
    assert.ok(reasonsFor('p-unverified').includes('verified_recipient_contact_required'));
    assert.ok(reasonsFor('a1').includes('recipient_suitability_terms_and_attribution_verification_required'));
    assert.ok(reasonsFor('m1').includes('x_tweet_write_permission_not_granted'), 'X is reported, never used');
    assert.equal(p.excluded.some(x => x.draftId === 'p-rejected'), false);
    const fb = p.items.filter(i => i.channel === 'facebook').map(i => Date.parse(i.scheduledAt));
    assert.ok(Math.abs(fb[1] - fb[0]) >= 60 * 60000, 'social posts are spaced by the default limit');
    const m1fb = p.items.find(i => i.draftId === 'm1' && i.channel === 'facebook');
    assert.equal(m1fb.text, 'FB copy m1'); assert.equal(m1fb.destination, 'FANTASY MMADNESS Page'); assert.equal(m1fb.imageUrl, 'https://img.example/m1.jpg');
    assert.equal(p.items.find(i => i.draftId === 'p1').recipient, 'p1@show.example');
    assert.equal(sent.length, 0, 'preview sends nothing');
    assert.equal((await col.drafts.findOne({ id: 'm1' })).status, 'needs_owner_review', 'preview approves nothing');

    // ---- confirmation: required phrase, digest, owner; exactly once ----
    assert.equal((await engine.bulkConfirm(p.batchId, { digest: p.digest }, owner)).reason, 'explicit_owner_confirmation_required');
    assert.equal((await engine.bulkConfirm(p.batchId, { digest: 'x', confirmation: 'APPROVE ALL AND SEND' }, owner)).reason, 'batch_changed_preview_again');
    assert.equal((await engine.bulkConfirm(p.batchId, { digest: p.digest, confirmation: 'APPROVE ALL AND SEND' }, stranger)).ok, false);
    // A campaign edited after the preview is held, not sent with stale approval.
    await col.drafts.updateOne({ id: 'm2' }, { $set: { text: 'changed after preview' } });
    const [c1, c2] = await Promise.all([engine.bulkConfirm(p.batchId, { digest: p.digest, confirmation: 'APPROVE ALL AND SEND' }, owner), engine.bulkConfirm(p.batchId, { digest: p.digest, confirmation: 'APPROVE ALL AND SEND' }, owner)]);
    const confirmed = c1.ok ? c1 : c2, loser = c1.ok ? c2 : c1;
    assert.equal(confirmed.ok, true); assert.equal(loser.reason, 'batch_already_confirmed');
    assert.equal(confirmed.groups.queued.length, 4);
    assert.equal(confirmed.groups.succeeded.length, 0, 'queued is never success');
    assert.ok(confirmed.groups.held.some(x => x.draftId === 'm2' && x.reasons.includes('campaign_changed_since_preview')));
    assert.equal((await col.drafts.findOne({ id: 'm1' })).status, 'approved');
    assert.equal((await col.drafts.findOne({ id: 'm1' })).contentApproval.owner, owner);
    assert.equal(sent.length, 0);

    // ---- dispatch through the existing worker path, receipts recorded ----
    await distribution.pause(false, owner);
    time = new Date(+time + 3 * 3600000);
    await distribution.dispatch({ trigger: 'test' });
    let st = await engine.bulkStatus(p.batchId);
    assert.equal(st.groups.succeeded.length, 4);
    assert.ok(st.groups.succeeded.every(x => x.receipt && (x.receipt.providerPostId || x.receipt.providerMessageId)));
    assert.ok(st.groups.succeeded.find(x => x.channel === 'email').note.includes('not confirmed'));
    assert.equal(sent.length, 4);

    // ---- duplicates: a second batch never resends ----
    const p2 = await engine.bulkPreview(owner);
    assert.equal(p2.items.some(i => ['m1', 'p1', 'p-edited'].includes(i.draftId)), false);
    assert.ok(p2.excluded.some(x => x.draftId === 'p1' && x.reasons.includes('already_scheduled_or_sent')));

    // ---- failures are reported separately ----
    await col.drafts.insertOne(pr('p-fail', { createdAt: time.toISOString() }));
    emailReply = () => ({ ok: false, reason: 'smtp_rejected' });
    const p3 = await engine.bulkPreview(owner);
    const c3 = await engine.bulkConfirm(p3.batchId, { digest: p3.digest, confirmation: 'APPROVE ALL AND SEND' }, owner);
    assert.ok(c3.groups.queued.some(x => x.draftId === 'p-fail'));
    time = new Date(+time + 3 * 3600000); await distribution.dispatch();
    st = await engine.bulkStatus(p3.batchId);
    assert.ok(st.groups.failed.some(x => x.draftId === 'p-fail' && x.status === 'failed'));
    emailReply = () => ({ ok: true, receipt: { providerMessageId: 'msg-ok', status: 'accepted', delivered: false } });

    // ---- Autonomous Mode ----
    assert.equal((await engine.savePolicy({}, stranger, 'SAVE AUTONOMOUS POLICY')).ok, false);
    assert.equal((await engine.savePolicy({}, owner, 'nope')).ok, false);
    const policy = { kinds: { marketing: { enabled: true, channels: ['facebook', 'instagram', 'x'], templates: ['marketing/platform-copy-v2'] }, pr: { enabled: true, channels: ['email'], templates: ['pr/outreach-v2'], recontactDays: 30 }, affiliate: { enabled: false, channels: [], templates: [] } }, limits: { facebook: { maxPerDay: 99, minSpacingMinutes: 1 } } };
    let s = await engine.savePolicy(policy, owner, 'SAVE AUTONOMOUS POLICY');
    assert.equal(s.version, 1);
    assert.deepEqual(s.policy.kinds.marketing.channels, ['facebook', 'instagram'], 'X can never be authorized by policy');
    assert.equal(s.policy.limits.facebook.maxPerDay, 6, 'hard cap'); assert.equal(s.policy.limits.facebook.minSpacingMinutes, 30, 'hard spacing');
    assert.equal(s.policy.includePreviouslyApproved, false);
    // Release gate: no automatic approval until the owner approves the release.
    assert.equal((await make(false).setEnabled(true, owner, { confirmation: 'ENABLE AUTONOMOUS MODE', version: 1 })).reason, 'autonomous_mode_release_not_owner_approved');
    assert.equal((await engine.setEnabled(true, owner, { confirmation: 'ENABLE AUTONOMOUS MODE', version: 0 })).reason, 'review_current_policy_version_first');
    // Older held campaigns are never swept up by switching the mode on.
    const heldBefore = await col.drafts.countDocuments({ status: 'needs_owner_review' });
    time = new Date(+time + 60000);
    s = await engine.setEnabled(true, owner, { confirmation: 'ENABLE AUTONOMOUS MODE', version: 1 });
    assert.equal(s.enabled, true);
    let run = await engine.tick();
    assert.equal(run.approved, 0); assert.equal(run.queued, 0);
    assert.equal(await col.drafts.countDocuments({ status: 'needs_owner_review' }), heldBefore);

    // New campaigns that match the policy are approved and queued; others are held.
    time = new Date(+time + 60000);
    await col.drafts.insertOne(mkt('m-new', { createdAt: time.toISOString() }));
    await col.drafts.insertOne(pr('p-new', { createdAt: time.toISOString() }));
    await col.drafts.insertOne(pr('p-new-edited', { createdAt: time.toISOString(), editCount: 2 }));
    await col.drafts.insertOne(pr('p-new-blocked', { createdAt: time.toISOString() })); blocked['p-new-blocked'] = ['recipient_suppressed'];
    await col.drafts.insertOne(pr('p-again', { createdAt: time.toISOString(), recipient: 'p1@show.example' }));
    run = await engine.tick();
    assert.equal(run.approved, 2, JSON.stringify(run)); assert.equal(run.queued, 3);
    const auto = await engine.autonomousStatus();
    const dec = id => auto.recent.find(x => x.draftId === id);
    assert.equal(dec('m-new').state, 'distributed'); assert.equal(dec('m-new').autoApproved, true);
    assert.ok(dec('p-new-edited').reasons.includes('content_template_not_in_owner_policy'));
    assert.ok(dec('p-new-blocked').reasons.includes('recipient_suppressed'));
    assert.ok(dec('p-again').reasons.includes('recipient_contacted_recently'));
    assert.ok(await col.audit.findOne({ action: 'autonomous_policy_approval', draftId: 'm-new', policyVersion: 1 }));
    assert.equal((await col.drafts.findOne({ id: 'p-new-edited' })).status, 'needs_owner_review');
    // Running again (or concurrently) never duplicates.
    const again = await Promise.all([engine.tick(), make().tick()]);
    assert.equal(again.reduce((n, r) => n + (r.queued || 0), 0), 0);
    assert.equal(await queue.countDocuments({ draftId: 'm-new' }), 2);

    // Excessive posting: daily caps hold across runs.
    await engine.savePolicy({ ...policy, limits: { facebook: { maxPerDay: 1, minSpacingMinutes: 30 }, instagram: { maxPerDay: 1, minSpacingMinutes: 30 } } }, owner, 'SAVE AUTONOMOUS POLICY');
    time = new Date(+time + 60000);
    for (const id of ['m-a', 'm-b', 'm-c']) await col.drafts.insertOne(mkt(id, { createdAt: time.toISOString() }));
    await engine.tick();
    const next24 = await queue.countDocuments({ 'payload.channel': 'facebook', scheduledAt: { $gte: time.toISOString(), $lt: new Date(+time + 86400000).toISOString() } });
    assert.ok(next24 <= 1, 'at most one Facebook post in the next 24 hours, got ' + next24);

    // ---- emergency stop: autonomy off, distribution paused, worker untouched ----
    const before = sent.length;
    await col.settings.updateOne({ _id: 'production-preparation' }, { $set: { enabled: true, generation: 'gen-1' } }, { upsert: true });
    s = await engine.emergencyStop(owner);
    assert.equal(s.enabled, false); assert.equal(s.distributionPaused, true);
    time = new Date(+time + 7 * 86400000);
    assert.equal((await distribution.dispatch()).paused, true);
    assert.equal((await engine.tick()).skipped, 'autonomous_mode_off');
    assert.equal(sent.length, before, 'nothing sent after emergency stop');
    assert.equal((await col.settings.findOne({ _id: 'production-preparation' })).generation, 'gen-1', 'worker generation preserved');

    // ---- rollback keeps full history ----
    s = await engine.rollback(1, owner);
    assert.equal(s.version, 3); assert.equal(s.policy.limits.facebook.maxPerDay, 6);
    assert.ok(s.versions.find(v => v.version === 3).source === 'rollback_to_v1');
    assert.equal((await engine.rollback(99, owner)).reason, 'policy_version_not_found');
    assert.ok(await col.audit.findOne({ action: 'autonomous_emergency_stop' }));
    assert.ok(await col.audit.findOne({ action: 'bulk_approve_all_confirmed' }));

    // Normalization never trusts input.
    const n = normalizePolicy({ kinds: { marketing: { enabled: true, channels: ['tiktok'], templates: ['marketing/x'] } }, sendWindow: { startHour: 30, endHour: -1 } });
    assert.equal(n.kinds.marketing.enabled, false); assert.ok(n.sendWindow.endHour > n.sendWindow.startHour);
  } finally { await store.close(); }
});

test('emergency stop before any policy exists, then the first policy save still works; no distribution means no feature', async () => {
  const store = await database();
  const owner = 'c'.repeat(24), clock = () => new Date('2026-11-10T15:00:00Z');
  const col = { drafts: store.collection('d2'), settings: store.collection('s2'), audit: store.collection('a2'), ownerCampaignHolds: store.collection('h2') }, queue = store.collection('q2');
  const distribution = createProductionDistribution({ col, queue, quality: async () => [], owners: [owner], clock, enabled: true, email: { readiness: async () => ({ ready: false }) }, meta: { readiness: async () => ({}) } });
  await distribution.init();
  const engine = createBulkAutonomy({ db: { collection: n => store.collection('b2_' + n) }, col, queue, distribution, review: createProductionReview({ col, quality: async () => [], clock }), owners: [owner], clock, autoApprovalReleased: true });
  try {
    await engine.init();
    assert.equal((await engine.emergencyStop(owner)).ok, true);
    const s = await engine.savePolicy({}, owner, 'SAVE AUTONOMOUS POLICY');
    assert.equal(s.ok, true); assert.equal(s.version, 1); assert.equal(s.enabled, false);
    assert.equal((await engine.setEnabled(true, owner, { confirmation: 'ENABLE AUTONOMOUS MODE', version: 1 })).reason, 'policy_authorizes_nothing');
    const p = await engine.bulkPreview(owner);
    assert.equal(p.totals.deliveries, 0);
    assert.equal((await engine.bulkConfirm(p.batchId, { digest: p.digest, confirmation: 'APPROVE ALL AND SEND' }, owner)).reason, 'no_eligible_campaigns');
    assert.throws(() => createBulkAutonomy({ db: { collection: () => null }, col, queue, distribution: null, review: {}, owners: [owner] }));
  } finally { await store.close(); }
});

// HTTP surface: owner-only routes, single-use confirmation over HTTP, and the worker route
// running the Autonomous Mode check before dispatch. Needs the server packages (CI).
let httpDeps = true; try { require.resolve('express'); require.resolve('jsonwebtoken'); } catch { httpDeps = false; }
test('HTTP: owner-only bulk and autonomous routes; worker cron runs the autonomous check, then dispatch', { skip: !httpDeps && 'server packages not installed', timeout: 30000 }, async () => {
  const { createProductionPreparationApp } = require('./growth-production-preparation-http');
  const { resolvePreparationConfig, PROJECT } = require('./growth-production-preparation-config');
  const { signProductionSession } = require('./growth-production-session');
  const owner = 'a'.repeat(24), stranger = 'f'.repeat(24);
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const env = { VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40), GROWTH_PREPARATION_VERIFIED_SHA: 'a'.repeat(40), VERCEL_PROJECT_ID: PROJECT, VERCEL_DEPLOYMENT_ID: 'dpl_new', GROWTH_PREPARATION_MODE: 'production_preparation', GROWTH_PREPARATION_APPROVED: 'true', GROWTH_PREPARATION_MONGODB_URI: 'mongodb+srv://fixture@production.example.invalid/fmgrowthproduction', GROWTH_PREPARATION_ATLAS_HOST: 'production.example.invalid', GROWTH_PREPARATION_OWNER_IDS: owner, GROWTH_OUTBOUND_ENABLED: 'false', GROWTH_SOCIAL_PUBLISHING_APPROVED: 'false', GROWTH_AUTOMATION_LIVE_APPROVED: 'false', GROWTH_AUTOMATIC_APPROVAL_ENABLED: 'false', GROWTH_PAYMENT_MUTATIONS_ENABLED: 'false', GROWTH_DELIVERY_PROVIDER: 'none', GROWTH_SOCIAL_PROVIDER: 'none', JWT_SECRET_ADMIN: crypto.randomBytes(40).toString('hex'), GROWTH_UNSUBSCRIBE_SECRET: crypto.randomBytes(40).toString('hex'), CRON_SECRET: crypto.randomBytes(40).toString('hex'), GROWTH_SSO_SITE_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }), GROWTH_SSO_SITE_ORIGINS: 'https://fantasymmadness.com,https://www.fantasymmadness.com' };
  const resolved = resolvePreparationConfig(env);
  assert.equal(resolved.ok, true, JSON.stringify(resolved.errors));
  const token = adminId => signProductionSession(resolved.secrets.adminJwtSecret, { email: 'owner@example.test', adminId, sid: crypto.randomUUID(), iatMs: Date.now(), ttl: 600 }, resolved.config.sessionAudience);
  const store = await database();
  let time = new Date('2026-11-10T15:00:00Z'); const clock = () => time;
  const col = { drafts: store.collection('d3'), settings: store.collection('s3'), audit: store.collection('a3'), ownerCampaignHolds: store.collection('h3') }, queue = store.collection('q3');
  const sent = [];
  const distribution = createProductionDistribution({ col, queue, quality: async () => [], owners: [owner], clock, enabled: true, email: { readiness: async () => ({ ready: true, provider: 'gmail-smtp' }), send: async m => { sent.push(m.recipient); return { ok: true, receipt: { providerMessageId: 'm' + sent.length, status: 'accepted' } }; } }, meta: { readiness: async () => ({}) } });
  await distribution.init();
  const bulk = createBulkAutonomy({ db: { collection: n => store.collection('b3_' + n) }, col, queue, distribution, review: createProductionReview({ col, quality: async () => [], clock }), owners: [owner], clock, autoApprovalReleased: true });
  await bulk.init();
  let ticks = 0; const realTick = bulk.tick; bulk.tick = async o => { ticks++; return realTick(o); };
  const sessionCollections = { nonces: store.collection('n3'), revocations: store.collection('r3'), audit: store.collection('sa3') };
  const app = createProductionPreparationApp({ env, context: async () => ({ bulk, distribution, verifiedOwnerIds: [owner], sessionCollections, status: async () => ({ scheduler: { enabled: true, healthy: true, activeDeploymentId: 'dpl_new' } }), preparePosterAssets: async () => ({ ok: true }) }) });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/growth';
  const call = async (method, p, who, body) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: 'Bearer ' + token(who) } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    await col.drafts.insertOne({ id: 'h1', kind: 'pr', genre: 'mma-ufc', recipient: 'h1@show.example', subject: 'Story idea', text: 'Hello', html: '<p>Hello</p>', contactSource: 'https://show.example/feed', consentBasis: 'published_business_contact', emailQualityVersion: 2, listUnsubscribe: 'https://u.example/x', status: 'needs_owner_review', ownerApproved: false, sendPermitted: false, createdAt: time.toISOString() });
    for (const [m, p] of [['POST', '/admin/bulk/preview'], ['POST', '/admin/autonomous/emergency-stop'], ['POST', '/admin/autonomous/policy'], ['GET', '/admin/autonomous'], ['GET', '/admin/bulk']]) {
      assert.equal((await call(m, p, null, {})).status, 401, 'no session ' + p);
      assert.equal((await call(m, p, stranger, {})).status, 401, 'non-owner ' + p);
    }
    const prev = await call('POST', '/admin/bulk/preview', owner, {});
    assert.equal(prev.status, 200); assert.equal(prev.body.totals.deliveries, 1);
    assert.equal((await call('POST', '/admin/bulk/' + prev.body.batchId + '/confirm', owner, { digest: prev.body.digest })).status, 409);
    const ok = await call('POST', '/admin/bulk/' + prev.body.batchId + '/confirm', owner, { digest: prev.body.digest, confirmation: 'APPROVE ALL AND SEND' });
    assert.equal(ok.status, 200); assert.equal(ok.body.groups.queued.length, 1);
    assert.equal((await call('POST', '/admin/bulk/' + prev.body.batchId + '/confirm', owner, { digest: prev.body.digest, confirmation: 'APPROVE ALL AND SEND' })).body.reason, 'batch_already_confirmed');
    assert.equal((await call('GET', '/admin/bulk/' + prev.body.batchId, owner)).body.groups.queued.length, 1);
    assert.equal((await call('GET', '/admin/autonomous', owner)).body.enabled, false);
    // Worker route: cron secret required; runs the autonomous check, then dispatch.
    await distribution.pause(false, owner);
    time = new Date(+time + 3 * 3600000);
    assert.equal((await fetch(base + '/internal/distribution')).status, 401);
    const cron = await fetch(base + '/internal/distribution', { headers: { Authorization: 'Bearer ' + env.CRON_SECRET } });
    const cronBody = await cron.json();
    assert.equal(cron.status, 200, JSON.stringify(cronBody));
    assert.equal(ticks, 1); assert.equal(cronBody.autonomous.skipped, 'autonomous_mode_off');
    assert.deepEqual(sent, ['h1@show.example']);
    assert.equal((await call('GET', '/admin/bulk/' + prev.body.batchId, owner)).body.groups.succeeded.length, 1);
    // Preview-only sandbox route does not exist in production.
    assert.equal((await call('POST', '/admin/sandbox/run-worker', owner, {})).status, 404);
  } finally { server.close(); await store.close(); }
});
