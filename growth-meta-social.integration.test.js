'use strict';
// Facebook Page + Instagram integration, end to end on a real (loopback) MongoDB against a
// loopback stand-in for Meta (growth-acceptance/fake-meta.js). Covers: app setup, Meta
// sign-in (state, replay, expiry, cancel), permission checks, Page/Instagram selection and
// verification, encrypted storage (no token in the database or any API response), health
// monitoring + renewal + alerts, sandbox publishing with Meta's checks (nothing sent to Meta),
// fight image posts + captions + affiliate links, approval gates, duplicate prevention,
// publishing logs, live mode through the connection, the owner-authorized controlled live
// test, and disconnect.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const { MongoClient } = require('mongodb');
const { registerIsolatedGrowthRoutes } = require('./growth-isolated-routes');
const { hashPassword } = require('./growth-backoffice');
const { signConsoleToken, consolePasswordVersion } = require('./growth-console-token');
const { contestFeed } = require('./growth-contest-feed.fixture');
const { createFakeMeta } = require('./growth-acceptance/fake-meta');
const { instagramImageUrl } = require('./growth-social-publishing');

const uri = process.env.GROWTH_TEST_MONGO_URI;
const skip = !uri || !/^mongodb:\/\/(127\.0\.0\.1|localhost)/.test(uri) ? 'needs loopback MongoDB' : false;
const SECRET = 's'.repeat(48);
const KEY = crypto.randomBytes(32).toString('base64');
const PASSWORD_HASH = hashPassword('meta integration test password');
const feed = contestFeed();
const imageHead = { ok: true, status: 200, headers: { get: (k) => ({ 'content-type': 'image/jpeg', 'content-length': '245000' }[String(k).toLowerCase()] || null) }, json: async () => ({}) };

test('Facebook & Instagram connection and publishing (sandbox first)', { skip, timeout: 120000 }, async (t) => {
  const meta = createFakeMeta();
  const META = await meta.listen();
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    if (u.startsWith(META)) return fetch(u, opts);
    if (/res\.cloudinary\.com/.test(u) && opts?.method === 'HEAD') return imageHead;
    const f = feed(u); if (f) return f;
    const term = new URL(u).searchParams.get('term') || 'x';
    return { ok: true, status: 200, json: async () => ({ results: [{ collectionName: `${term} show`, collectionViewUrl: `https://podcasts.apple.com/us/podcast/x/id${term.length}` }] }) };
  };
  const client = await new MongoClient(uri).connect();
  await client.db('fmgrowthtest').dropDatabase();
  const baseEnv = { GROWTH_STAGING_MODE: 'isolated', GROWTH_OUTBOUND_ENABLED: 'false', GROWTH_TEST_MONGO_URI: uri, JWT_SECRET_ADMIN: SECRET, GROWTH_UNSUBSCRIBE_SECRET: SECRET, CRON_SECRET: 'cron-secret-for-tests-only', GROWTH_DELIVERY_PROVIDER: 'none', GROWTH_ADMIN_PASSWORD_HASH: PASSWORD_HASH, GROWTH_SOCIAL_PROVIDER: 'sandbox', GROWTH_META_GRAPH_BASE: META, GROWTH_META_DIALOG_BASE: META, GROWTH_TOKEN_ENCRYPTION_KEY: KEY };
  const servers = [];
  const mount = async (envOverrides = {}) => {
    const app = express();
    const env = { ...baseEnv, ...envOverrides };
    const m = registerIsolatedGrowthRoutes({ app, env, express, fetchImpl, connect: async () => client });
    assert.equal(m.mounted, true);
    const server = app.listen(0, '127.0.0.1'); servers.push(server);
    await new Promise((r) => server.once('listening', r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const rt = await m.getRuntime();
    const token = signConsoleToken(SECRET, { pwv: consolePasswordVersion(PASSWORD_HASH) });
    const call = async (method, path, body) => {
      const r = await fetch(`${origin}/api/growth${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ }
      return { status: r.status, json, text, headers: r.headers };
    };
    return { origin, rt, call };
  };
  const leaksToken = (text) => meta.allTokens().some((tk) => String(text).includes(tk)) || String(text).includes(meta.state.appSecret);
  // Follow Meta's dialog the way a browser does (auto mode redirects straight to the callback).
  const signIn = async (callFn) => {
    const c = await callFn('POST', '/admin/meta/connect');
    assert.equal(c.status, 200, c.text);
    const d = await fetch(`${c.json.authorizeUrl}&auto=1`, { redirect: 'manual' });
    const cb = d.headers.get('location');
    return { connect: c.json, callbackUrl: cb, page: await fetch(cb, { redirect: 'manual' }) };
  };

  try {
    // ---------- sandbox engine (as on staging) ----------
    const S = await mount();
    await S.rt.tick({ now: new Date(Date.now() - 60 * 60000) });

    await t.test('not set up: encryption + Meta app needed; statuses shown', async () => {
      const r = (await S.call('GET', '/admin/meta')).json.meta;
      assert.equal(r.state, 'not_set_up'); assert.equal(r.connectionLabel, 'Not set up');
      assert.equal(r.setup[0].done, true); assert.equal(r.setup[1].done, false);
      assert.equal(r.publishing.facebook, 'sandbox'); assert.equal(r.publishing.instagram, 'sandbox');
      assert.match(r.redirectUri, /\/api\/growth\/meta\/callback$/);
      assert.equal((await S.call('POST', '/admin/meta/connect')).json.reason, 'meta_app_not_set_up');
    });

    await t.test('Meta app: wrong secret refused by Meta; correct one stored encrypted', async () => {
      assert.equal((await S.call('POST', '/admin/meta/app', { appId: 'abc', appSecret: 'x' })).json.reason, 'app_id_must_be_digits');
      assert.equal((await S.call('POST', '/admin/meta/app', { appId: meta.state.appId, appSecret: 'b'.repeat(32) })).json.reason, 'meta_rejected_app_id_or_secret');
      const ok = await S.call('POST', '/admin/meta/app', { appId: meta.state.appId, appSecret: meta.state.appSecret });
      assert.equal(ok.status, 200); assert.equal(ok.json.appName, meta.state.appName);
      const doc = await client.db('fmgrowthtest').collection('growth_connections').findOne({ key: 'meta' });
      assert.ok(!JSON.stringify(doc).includes(meta.state.appSecret), 'app secret stored in plain text');
      const st = (await S.call('GET', '/admin/meta')).json.meta;
      assert.equal(st.state, 'authorization_needed'); assert.equal(st.connectionLabel, 'Authorization needed');
      assert.ok(!leaksToken(JSON.stringify(st)));
    });

    await t.test('sign-in link: Meta dialog with app ID, exact redirect, required scopes and a one-time state', async () => {
      const c = (await S.call('POST', '/admin/meta/connect')).json;
      const u = new URL(c.authorizeUrl);
      assert.equal(u.origin, META); assert.match(u.pathname, /\/v\d+\.\d\/dialog\/oauth$/);
      assert.equal(u.searchParams.get('client_id'), meta.state.appId);
      assert.equal(u.searchParams.get('redirect_uri'), c.redirectUri);
      for (const s of ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list', 'instagram_basic', 'instagram_content_publish']) assert.ok(u.searchParams.get('scope').split(',').includes(s), s);
      assert.ok(u.searchParams.get('state').length >= 40);
      // state never stored in clear
      const states = await client.db('fmgrowthtest').collection('growth_oauth_states').find({}).toArray();
      assert.ok(states.every((x) => !JSON.stringify(x).includes(u.searchParams.get('state'))));
    });

    await t.test('callback is protected: forged, replayed, expired and cancelled sign-ins are refused', async () => {
      const forged = await fetch(`${S.origin}/api/growth/meta/callback?code=x&state=forged`);
      assert.equal(forged.status, 400);
      meta.state.denyNext = true;
      const denied = await signIn(S.call);
      assert.equal(denied.page.status, 400); assert.match(await denied.page.text(), /Nothing was connected/);
      // expired state
      const c = (await S.call('POST', '/admin/meta/connect')).json;
      const state = new URL(c.authorizeUrl).searchParams.get('state');
      await client.db('fmgrowthtest').collection('growth_oauth_states').updateOne({ stateHash: crypto.createHash('sha256').update(state).digest('hex') }, { $set: { expiresAt: new Date(Date.now() - 1000).toISOString() } });
      const exp = await fetch(`${S.origin}/api/growth/meta/callback?code=x&state=${encodeURIComponent(state)}`);
      assert.equal(exp.status, 400); assert.match(await exp.text(), /expired/);
    });

    await t.test('missing permissions -> Authorization needed (lists what to allow)', async () => {
      meta.state.granted = ['pages_show_list', 'pages_read_engagement', 'instagram_basic'];
      const s = await signIn(S.call);
      assert.equal(s.page.status, 200);
      const st = (await S.call('GET', '/admin/meta')).json.meta;
      assert.equal(st.state, 'authorization_needed');
      assert.deepEqual(st.missingPermissions.sort(), ['instagram_content_publish', 'pages_manage_posts']);
      meta.state.granted = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish', 'business_management'];
    });

    let cbUrl;
    await t.test('full sign-in: long-lived token, Pages + linked Instagram listed, then choose the Page', async () => {
      const s = await signIn(S.call); cbUrl = s.callbackUrl;
      assert.equal(s.page.status, 200);
      assert.equal(s.page.headers.get('cache-control'), 'no-store'); assert.equal(s.page.headers.get('referrer-policy'), 'no-referrer');
      assert.match(s.page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      assert.match(await s.page.text(), /choose your FANTASY MMADNESS Page/);
      assert.ok(meta.state.calls.some((c) => c.query.grant_type === 'fb_exchange_token'), 'no long-lived exchange');
      const st = (await S.call('GET', '/admin/meta')).json.meta;
      assert.equal(st.state, 'selection_needed'); assert.equal(st.connectionLabel, 'Choose your Page');
      assert.equal(st.pages.length, 3);
      const fmm = st.pages.find((p) => p.name === 'FANTASY MMADNESS');
      assert.equal(fmm.ig.username, 'fantasymmadness'); assert.equal(fmm.canPost, true);
      assert.ok(!leaksToken(JSON.stringify(st)), 'token in status response');
      // replaying the same callback (same state) is refused
      const replay = await fetch(cbUrl);
      assert.equal(replay.status, 400);
    });

    await t.test('Page selection is verified: confirmation, posting rights and a linked Instagram account are required', async () => {
      assert.equal((await S.call('POST', '/admin/meta/select', { pageId: '111000111000111' })).json.reason, 'confirm_this_is_the_business_page');
      assert.equal((await S.call('POST', '/admin/meta/select', { pageId: '222000222000222', confirm: true })).json.reason, 'no_instagram_professional_account_is_linked_to_this_page');
      assert.equal((await S.call('POST', '/admin/meta/select', { pageId: '333000333000333', confirm: true })).json.reason, 'you_cannot_post_on_this_page');
      assert.equal((await S.call('POST', '/admin/meta/select', { pageId: '999', confirm: true })).json.reason, 'page_not_in_your_authorized_list');
      const ok = await S.call('POST', '/admin/meta/select', { pageId: '111000111000111', confirm: true });
      assert.equal(ok.status, 200, ok.text);
      const st = ok.json.meta;
      assert.equal(st.state, 'connected'); assert.equal(st.connectionLabel, 'Connected');
      assert.equal(st.selected.pageName, 'FANTASY MMADNESS'); assert.equal(st.selected.igUsername, 'fantasymmadness');
      assert.equal(st.health.ok, true);
      assert.equal(st.publishing.facebook, 'sandbox'); assert.equal(st.publishing.instagram, 'sandbox');
      // Instagram link re-verified live with Meta using the Page token
      assert.ok(meta.state.calls.some((c) => c.method === 'GET' && c.path.endsWith('/111000111000111') && /instagram_business_account/.test(c.query.fields)));
    });

    await t.test('no token or secret is stored in plain text or returned by any API', async () => {
      const db = client.db('fmgrowthtest');
      const dump = JSON.stringify(await Promise.all(['growth_connections', 'growth_oauth_states', 'growth_audit_log', 'growth_alerts', 'growth_settings'].map((c) => db.collection(c).find({}).toArray())));
      assert.equal(leaksToken(dump), false, 'token found in the database');
      for (const p of ['/admin/meta', '/admin/connections', '/admin/social', '/admin/status', '/admin/audit']) assert.equal(leaksToken((await S.call('GET', p)).text), false, p);
    });

    let draft; let draft2;
    await t.test('approval gate: only approved, verified fight campaigns can be scheduled', async () => {
      const list = (await S.call('GET', '/admin/drafts?kind=marketing&status=needs_owner_review&limit=50')).json.drafts;
      draft = list.find((d) => d.contest?.posterUrl && /cloudinary/.test(d.contest.posterUrl));
      draft2 = list.find((d) => d.id !== draft.id && d.contest?.posterUrl);
      assert.ok(draft && draft2, 'fixture campaigns with posters');
      const early = await S.call('POST', `/admin/drafts/${encodeURIComponent(draft.id)}/schedule`, { channels: ['facebook', 'instagram'], scheduledAt: new Date().toISOString() });
      assert.equal(early.json.reason, 'approve_the_campaign_before_scheduling');
      assert.equal((await S.call('POST', `/admin/drafts/${encodeURIComponent(draft.id)}/approve`)).status, 200);
      assert.equal((await S.call('POST', `/admin/drafts/${encodeURIComponent(draft2.id)}/approve`)).status, 200);
    });

    await t.test('sandbox: fight image posts are checked like Meta would and simulated; nothing is sent to Meta', async () => {
      const before = meta.publishCalls().length;
      const r = await S.call('POST', `/admin/drafts/${encodeURIComponent(draft.id)}/schedule`, { channels: ['facebook', 'instagram'], scheduledAt: new Date().toISOString() });
      assert.equal(r.status, 200, r.text); assert.equal(r.json.results.filter((x) => x.ok).length, 2);
      const out = await S.rt.social.dispatch(new Date(Date.now() + 1000));
      assert.equal(out.published, 2, JSON.stringify(out));
      assert.equal(meta.publishCalls().length, before, 'sandbox sent something to Meta');
      const posts = (await S.call('GET', '/admin/social')).json.posts.filter((p) => p.draftId === draft.id);
      for (const p of posts) {
        assert.equal(p.status, 'published'); assert.equal(p.sandbox, true);
        assert.ok(p.text.includes(draft.contest.fighterA) && p.text.includes(draft.contest.fighterB), 'caption names both fighters');
        assert.match(p.text, /utm_source=fan_acquisition/);
        assert.ok(p.history.some((h) => /sandbox \(simulated; nothing sent/.test(h.note || '')), 'publishing log');
        assert.ok((p.preflight || []).some((n) => /image checked \(image\/jpeg/.test(n)), 'image checked');
      }
      const sb = await client.db('fmgrowthtest').collection('growth_social_sandbox').find({ postId: { $in: posts.map((p) => p.id) } }).toArray();
      const ig = sb.find((x) => x.channel === 'instagram');
      assert.equal(ig.imageUrl, instagramImageUrl(draft.contest.posterUrl)); assert.match(ig.imageUrl, /\/upload\/f_jpg,q_auto\//);
      assert.equal(ig.connectedAccount, true);
      // Publishing counts never treat sandbox posts as real
      assert.equal((await S.call('GET', '/admin/funnel')).json.funnel.stages.find((s) => s.key === 'published').detail.sandboxSimulated >= 2, true);
    });

    await t.test('duplicate prevention: same campaign/channel twice, and identical content from another post', async () => {
      const again = await S.call('POST', `/admin/drafts/${encodeURIComponent(draft.id)}/schedule`, { channels: ['facebook'], scheduledAt: new Date().toISOString() });
      assert.equal(again.json.results[0].reason, 'already_published');
      // A different campaign whose caption + image equal an already published post is refused.
      const p = await client.db('fmgrowthtest').collection('growth_social_posts').findOne({ draftId: draft.id, channel: 'facebook' });
      const drafts = client.db('fmgrowthtest').collection('growth_drafts');
      const orig = await drafts.findOne({ id: draft2.id });
      await drafts.updateOne({ id: draft2.id }, { $set: { 'posts.facebook': p.text, 'contest.posterUrl': p.imageUrl } });
      const dup = await S.call('POST', `/admin/drafts/${encodeURIComponent(draft2.id)}/schedule`, { channels: ['facebook'], scheduledAt: new Date().toISOString() });
      assert.match(dup.json.results[0].reason, /^duplicate_of_published_post$/);
      await drafts.updateOne({ id: draft2.id }, { $set: { 'posts.facebook': orig.posts.facebook, 'contest.posterUrl': orig.contest.posterUrl } });
    });

    await t.test('affiliate-credited post: the fight link becomes the active affiliate’s player link', async () => {
      const affs = client.db('fmgrowthtest').collection('growth_affiliates');
      await affs.insertOne({ id: 'aff-test-1', name: 'Coach Rivera', genre: draft2.genre, code: 'aff_coach_rivera_ab12', status: 'invited', liveAffiliateId: null, createdAt: new Date().toISOString(), history: [] });
      assert.equal((await S.call('POST', `/admin/drafts/${encodeURIComponent(draft2.id)}/schedule`, { channels: ['instagram'], scheduledAt: new Date().toISOString(), affiliateId: 'aff-test-1' })).json.reason, 'affiliate_is_not_active_with_a_live_affiliate_id');
      await affs.updateOne({ id: 'aff-test-1' }, { $set: { status: 'active', liveAffiliateId: 'a'.repeat(24) } });
      const r = await S.call('POST', `/admin/drafts/${encodeURIComponent(draft2.id)}/schedule`, { channels: ['instagram'], scheduledAt: new Date().toISOString(), affiliateId: 'aff-test-1' });
      assert.equal(r.json.results[0].ok, true, r.text);
      const post = (await S.call('GET', '/admin/social')).json.posts.find((x) => x.id === r.json.results[0].id);
      assert.match(post.text, new RegExp(`ref=${'a'.repeat(24)}`)); assert.match(post.text, /utm_campaign=combat_fans_aff_coach_rivera_ab12/); assert.match(post.text, /utm_term=instagram/);
      assert.equal(post.affiliate.code, 'aff_coach_rivera_ab12');
      const out = await S.rt.social.dispatch(new Date(Date.now() + 2000));
      assert.equal(out.published, 1);
    });

    await t.test('health monitoring: invalid sign-in -> Authorization needed, alert, posts held; reconnect restores', async () => {
      meta.state.userTokenValid = false;
      const chk = (await S.call('POST', '/admin/meta/check')).json;
      assert.equal(chk.check.ok, false); assert.equal(chk.meta.state, 'authorization_needed');
      assert.ok((await S.call('GET', '/admin/alerts')).json.alerts.some((a) => a.alertKey === 'meta:connection'));
      meta.state.userTokenValid = true;
      const s = await signIn(S.call);
      assert.equal(s.page.status, 200);
      const st = (await S.call('GET', '/admin/meta')).json.meta;
      assert.equal(st.state, 'connected', 'kept the confirmed Page after reconnecting'); assert.equal(st.selected.pageName, 'FANTASY MMADNESS');
    });

    await t.test('renewal: Page tokens refreshed, user sign-in re-exchanged before expiry, re-authorization warned', async () => {
      meta.state.expiresIn = 5 * 86400; meta.state.dataAccessExpiresIn = 6 * 86400;
      const exchangesBefore = meta.state.calls.filter((c) => c.query.grant_type === 'fb_exchange_token').length;
      const chk = (await S.call('POST', '/admin/meta/check')).json;
      assert.equal(chk.check.ok, true);
      assert.ok(meta.state.calls.filter((c) => c.query.grant_type === 'fb_exchange_token').length > exchangesBefore, 'no renewal attempt');
      assert.ok(chk.meta.pageTokensRenewedAt);
      assert.ok(chk.check.warnings.some((w) => /sign in again by/.test(w)));
      assert.ok((await S.call('GET', '/admin/alerts')).json.alerts.some((a) => a.alertKey === 'meta:reauthorize-soon'));
      meta.state.expiresIn = 60 * 86400; meta.state.dataAccessExpiresIn = 90 * 86400;
    });

    await t.test('health monitoring: Instagram unlinked from the Page is detected', async () => {
      const page = meta.state.pages[0]; const ig = page.ig; page.ig = null;
      const chk = (await S.call('POST', '/admin/meta/check')).json;
      assert.equal(chk.check.ok, false); assert.ok(chk.check.problems.some((p) => /Instagram account linked/.test(p)));
      page.ig = ig;
      assert.equal((await S.call('POST', '/admin/meta/check')).json.check.ok, true);
    });

    await t.test('controlled live test is refused until the owner authorizes it', async () => {
      const r = await S.call('POST', '/admin/social/live-test', { draftId: draft2.id, channel: 'facebook', confirmText: 'POST LIVE' });
      assert.equal(r.json.reason, 'live_test_not_authorized_by_owner');
      assert.equal((await S.call('GET', '/admin/social')).json.liveTestApproved, false);
    });

    // ---------- owner-authorized controlled live test (against the Meta stand-in) ----------
    const L = await mount({ GROWTH_SOCIAL_LIVE_TEST_APPROVED: 'true' });
    await t.test('live test: typed confirmation, one real post per channel, logged; failures do not use it up', async () => {
      assert.equal((await L.call('POST', '/admin/social/live-test', { draftId: draft2.id, channel: 'facebook', confirmText: 'yes' })).json.reason, 'type_POST_LIVE_to_confirm');
      meta.state.failPublish = { status: 400, message: 'Invalid parameter' };
      const failed = await L.call('POST', '/admin/social/live-test', { draftId: draft2.id, channel: 'facebook', confirmText: 'POST LIVE' });
      assert.equal(failed.json.reason, 'meta_did_not_publish');
      meta.state.failPublish = null;
      const fb = await L.call('POST', '/admin/social/live-test', { draftId: draft2.id, channel: 'facebook', confirmText: 'post live' });
      assert.equal(fb.status, 200, fb.text);
      assert.equal(fb.json.post.status, 'published'); assert.equal(fb.json.post.sandbox, false); assert.equal(fb.json.post.liveTest, true);
      const fbPost = meta.state.posts.find((p) => p.kind === 'fb_photo');
      assert.equal(fbPost.pageId, '111000111000111'); assert.ok(fbPost.caption.includes(draft2.contest.fighterA));
      assert.equal((await L.call('POST', '/admin/social/live-test', { draftId: draft2.id, channel: 'facebook', confirmText: 'POST LIVE' })).json.reason, 'the_live_test_for_this_channel_was_already_used');
      const ig = await L.call('POST', '/admin/social/live-test', { draftId: draft2.id, channel: 'instagram', confirmText: 'POST LIVE' });
      assert.equal(ig.status, 200, ig.text);
      const igPost = meta.state.posts.find((p) => p.kind === 'ig');
      assert.equal(igPost.igId, '178400000000001'); assert.match(igPost.image, /f_jpg/);
      assert.match(ig.json.post.url, /instagram\.com\/p\//);
      const audit = (await L.call('GET', '/admin/audit')).json;
      const actions = JSON.stringify(audit);
      assert.match(actions, /live_test_published/); assert.match(actions, /live_test_failed/);
    });

    // ---------- live provider through the connection (what "Live" will mean after approval) ----------
    const P = await mount({ GROWTH_SOCIAL_PROVIDER: 'live', GROWTH_SOCIAL_PUBLISHING_APPROVED: 'true', GROWTH_SOCIAL_CHANNELS_ENABLED: 'facebook,instagram' });
    await t.test('live mode uses the connected Page/Instagram; statuses show Live; a broken connection holds posts', async () => {
      const st = (await P.call('GET', '/admin/meta')).json.meta;
      assert.equal(st.publishing.facebook, 'live'); assert.equal(st.publishing.instagram, 'live');
      const d3 = (await P.call('GET', '/admin/drafts?kind=marketing&status=needs_owner_review&limit=50')).json.drafts.find((d) => d.contest?.posterUrl);
      await P.call('POST', `/admin/drafts/${encodeURIComponent(d3.id)}/approve`);
      const sch = await P.call('POST', `/admin/drafts/${encodeURIComponent(d3.id)}/schedule`, { channels: ['facebook'], scheduledAt: new Date().toISOString() });
      assert.equal(sch.json.results[0].ok, true, sch.text);
      meta.state.userTokenValid = false; await P.call('POST', '/admin/meta/check');
      const held = await P.rt.social.dispatch(new Date(Date.now() + 3000));
      assert.equal(held.held, 1, JSON.stringify(held));
      const heldPost = (await P.call('GET', '/admin/social')).json.posts.find((p) => p.draftId === d3.id);
      assert.equal(heldPost.status, 'held'); assert.match(heldPost.heldReason, /Connect Facebook & Instagram/);
      meta.state.userTokenValid = true; await P.call('POST', '/admin/meta/check');
      assert.equal((await P.call('POST', `/admin/social/${encodeURIComponent(heldPost.id)}/retry`, {})).status, 200);
      const before = meta.state.posts.length;
      const out = await P.rt.social.dispatch(new Date(Date.now() + 120000));
      assert.equal(out.published, 1, JSON.stringify(out));
      assert.equal(meta.state.posts.length, before + 1);
    });

    await t.test('disconnect: Meta access revoked, sign-in forgotten, channels need authorization again', async () => {
      const r = await S.call('POST', '/admin/meta/disconnect');
      assert.equal(r.json.meta.state, 'authorization_needed');
      assert.ok(meta.state.calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/me/permissions')));
      const doc = await client.db('fmgrowthtest').collection('growth_connections').findOne({ key: 'meta' });
      assert.equal(doc.userTokenSealed, undefined); assert.equal(doc.pages, undefined);
      assert.equal((await P.call('GET', '/admin/meta')).json.meta.publishing.facebook, 'off');
    });
  } finally {
    for (const s of servers) s.close();
    await meta.close(); await client.close();
  }
});
