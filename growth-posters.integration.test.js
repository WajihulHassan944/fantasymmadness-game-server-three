'use strict';
// Verified fight -> FANTASY MMADNESS poster -> platform campaign -> sandbox publishing,
// end to end on a real (loopback) MongoDB through the real HTTP routes.
// Covers: discovery across the five sports, rights-safe artwork (official contest art
// only; text poster otherwise), poster serving + headers, QR destination, approval with
// poster, owner artwork block (re-review + queued posts cancelled), per-platform
// scheduling with the right poster format, sandbox receipts with the platform checks,
// duplicate prevention, retries, interrupted-publish recovery, and truthful capabilities.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const sharp = require('sharp');
const { MongoClient } = require('mongodb');
const { registerIsolatedGrowthRoutes } = require('./growth-isolated-routes');
const { hashPassword } = require('./growth-backoffice');
const { signConsoleToken, consolePasswordVersion } = require('./growth-console-token');
const { contestFeed } = require('./growth-contest-feed.fixture');
const { qrMatrix } = require('./growth-poster-studio');

const uri = process.env.GROWTH_TEST_MONGO_URI;
const skip = !uri || !/^mongodb:\/\/(127\.0\.0\.1|localhost)/.test(uri) ? 'needs loopback MongoDB' : false;
const SECRET = 's'.repeat(48);
const PASSWORD_HASH = hashPassword('poster integration test password');

test('fight posters and platform campaigns, sandbox only', { skip, timeout: 180000 }, async (t) => {
  // Synthetic test artwork (never a real fighter image).
  const art = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1100"><rect width="900" height="1100" fill="#1d4ed8"/><rect y="500" width="900" height="100" fill="#f5c518"/></svg>')).jpeg({ quality: 95 }).toBuffer();
  const feed = contestFeed();
  const artFetches = [];
  let origin = null;
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    if (origin && u.startsWith(origin)) return fetch(u, opts); // our own public poster address
    const f = feed(u); if (f) return f;
    if (/^https:\/\/res\.cloudinary\.com\/demo\/image\/upload\//.test(u)) { artFetches.push(u); return { ok: true, status: 200, headers: new Headers({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => art }; }
    if (u.startsWith('https://www.fantasymmadness.com/images/brand/')) return { ok: false, status: 404, headers: new Headers() }; // logo unavailable: wordmark is used
    const term = (() => { try { return new URL(u).searchParams.get('term') || 'x'; } catch { return 'x'; } })();
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ results: [{ collectionName: `${term} show`, collectionViewUrl: `https://podcasts.apple.com/us/podcast/x/id${term.length}` }] }) };
  };
  const client = await new MongoClient(uri).connect();
  const db = client.db('fmgrowthtest'); await db.dropDatabase();
  const app = express();
  const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  const env = { GROWTH_STAGING_MODE: 'isolated', GROWTH_OUTBOUND_ENABLED: 'false', GROWTH_TEST_MONGO_URI: uri, JWT_SECRET_ADMIN: SECRET, GROWTH_UNSUBSCRIBE_SECRET: SECRET, CRON_SECRET: 'cron-secret-for-tests-only',
    GROWTH_DELIVERY_PROVIDER: 'none', GROWTH_ADMIN_PASSWORD_HASH: PASSWORD_HASH, GROWTH_SOCIAL_PROVIDER: 'sandbox', GROWTH_POSTERS: 'on', GROWTH_POSTERS_PER_RUN: '20', GROWTH_PUBLIC_ORIGIN: origin, GROWTH_RESEARCH_PER_RUN: '0' };
  const m = registerIsolatedGrowthRoutes({ app, env, express, fetchImpl, connect: async () => client });
  assert.equal(m.mounted, true, JSON.stringify(m.errors));
  const rt = await m.getRuntime();
  const token = signConsoleToken(SECRET, { pwv: consolePasswordVersion(PASSWORD_HASH) });
  const call = async (method, path, body) => {
    const r = await fetch(`${origin}/api/growth${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };
  const drafts = db.collection('growth_drafts');
  try {
    let refresh;
    await t.test('verified fights across all five sports become campaigns with posters', async () => {
      const t0 = Date.now();
      refresh = await rt.refreshMarketing(new Date(), { trigger: 'test' });
      t.diagnostic(`refresh + posters took ${Date.now() - t0} ms`);
      assert.equal(refresh.sourceReachable, true);
      const sports = new Set(refresh.contests.map((c) => c.sport));
      assert.deepEqual([...sports].sort(), ['bare-knuckle', 'boxing', 'kickboxing', 'mma-ufc', 'pro-wrestling']);
      assert.ok(!refresh.contests.some((c) => /Mannix|Budocast|TBA|Mystery|Old Fighter|Not Published|Too Far/.test(`${c.fighterA} ${c.fighterB}`)), 'unverified fights must never become campaigns');
      assert.equal(refresh.posters.failed.length, 0, JSON.stringify(refresh.posters.failed));
      const open = await drafts.find({ kind: 'marketing', status: 'needs_owner_review' }).toArray();
      assert.equal(open.length, refresh.contests.length);
      for (const d of open) {
        assert.ok(d.poster?.portrait?.url && d.poster?.story?.url, `${d.id} has no poster`);
        assert.ok(d.poster.portrait.url.startsWith(`${origin}/api/growth/posters/`));
        assert.ok(['facebook', 'instagram', 'x', 'tiktok'].every((ch) => d.posts[ch]), `${d.id}: missing a platform caption`);
        assert.match(d.posts.instagram, /#FANTASYMMADNESS/); assert.match(d.posts.x, /#FANTASYMMADNESS/);
      }
    });

    let boxing; let noArt;
    await t.test('official contest artwork is used unaltered; contests without it get a text poster', async () => {
      boxing = await drafts.findOne({ contestId: 'bx0000000001' });
      noArt = await drafts.findOne({ contestId: 'mm0000000002' }); // fixture contest published without artwork
      const wrestling = await drafts.findOne({ contestId: 'pw0000000001' }); // wrestling feed has no artwork field
      assert.equal(boxing.poster.art.used, true); assert.match(boxing.poster.art.basis, /Official artwork published by FANTASY MMADNESS on this contest \(fightPosterImage\)/);
      assert.equal(noArt.poster.art.used, false); assert.equal(noArt.poster.art.reason, 'no_official_artwork_on_this_contest');
      assert.equal(wrestling.poster.art.used, false);
      assert.ok(artFetches.every((u) => u.startsWith('https://res.cloudinary.com/demo/image/upload/')), 'only official artwork addresses are fetched');
      const meta = (await call('GET', `/admin/posters?draftId=${encodeURIComponent(boxing.id)}`)).json.posters;
      assert.equal(meta.length, 2);
      const p = meta.find((x) => x.format === 'portrait');
      assert.equal(p.facts.fighterA, 'Naoya Inoue'); assert.equal(p.facts.fighterB, 'Murodjon Akhmadaliev'); assert.equal(p.facts.where, 'Ariake Arena · Tokyo'); assert.equal(p.facts.detail, 'Super Bantamweight · 12 ROUNDS');
      assert.ok(!('bytes' in p), 'admin metadata never includes the image bytes');
      assert.ok(Math.abs(p.layout.art.width / p.layout.art.height - 900 / 1100) < 0.01, 'artwork aspect ratio kept');
    });

    await t.test('posters are served publicly with the headers platforms need; QR scans to the campaign link', async () => {
      for (const fmt of ['portrait', 'story']) {
        const url = boxing.poster[fmt].url;
        const head = await fetch(url, { method: 'HEAD' });
        assert.equal(head.status, 200); assert.equal(head.headers.get('content-type'), 'image/jpeg');
        assert.equal(head.headers.get('x-image-width'), '1080'); assert.equal(head.headers.get('x-image-height'), fmt === 'portrait' ? '1350' : '1920');
        const body = Buffer.from(await (await fetch(url)).arrayBuffer());
        const md = await sharp(body).metadata(); assert.deepEqual([md.width, md.height], [1080, fmt === 'portrait' ? 1350 : 1920]);
        const doc = await db.collection('growth_posters').findOne({ id: boxing.poster[fmt].id });
        const L = doc.layout.qr;
        const { data, info } = await sharp(body).extract({ left: L.left, top: L.top, width: L.px, height: L.px }).greyscale().raw().toBuffer({ resolveWithObject: true });
        const q = qrMatrix(boxing.poster.qrUrl); let bad = 0;
        for (let r = 0; r < q.size; r++) for (let c = 0; c < q.size; c++) { const y = (r + L.quiet) * L.scale + (L.scale >> 1); const x = (c + L.quiet) * L.scale + (L.scale >> 1); if ((data[y * info.width + x] < 128) !== q.get(r, c)) bad++; }
        assert.equal(bad, 0, `${fmt}: QR differs from the campaign link`);
      }
      assert.match(boxing.poster.qrUrl, /^https:\/\/www\.fantasymmadness\.com\/fight\/bx0000000001\?play=1&utm_source=fan_acquisition&utm_medium=partner_outreach&utm_campaign=combat_fans_gs_boxing&utm_content=poster_qr$/);
      assert.equal((await fetch(`${origin}/api/growth/posters/0000000000000000000a-portrait.jpg`)).status, 404);
      assert.equal((await fetch(`${origin}/api/growth/posters/..%2F..%2Fsecret.jpg`)).status, 404);
      assert.equal((await fetch(`${origin}/api/growth/admin/posters`)).status, 401, 'poster admin needs the console sign-in');
    });

    await t.test('platform capabilities are truthful', async () => {
      const cap = (await call('GET', '/admin/social/capabilities')).json.capabilities;
      assert.deepEqual(Object.keys(cap).sort(), ['facebook', 'instagram', 'tiktok', 'x']);
      assert.equal(cap.instagram.clickableLinks, false); assert.equal(cap.tiktok.clickableLinks, false);
      assert.match(cap.x.media, /text and link only/); assert.match(cap.tiktok.requires.join(' '), /domain verified/);
    });

    await t.test('approve with poster -> schedule all four platforms -> sandbox publish with the right poster per platform', async () => {
      assert.equal((await call('POST', `/admin/drafts/${encodeURIComponent(boxing.id)}/approve`)).status, 200);
      const when = new Date(Date.now() + 2 * 60000).toISOString();
      const s = await call('POST', `/admin/drafts/${encodeURIComponent(boxing.id)}/schedule`, { channels: ['facebook', 'instagram', 'x', 'tiktok'], scheduledAt: when });
      assert.equal(s.status, 200, s.text); assert.equal(s.json.results.filter((r) => r.ok).length, 4, s.text);
      // the same campaign cannot be queued twice
      const again = await call('POST', `/admin/drafts/${encodeURIComponent(boxing.id)}/schedule`, { channels: ['instagram'], scheduledAt: when });
      assert.match(again.json.results[0].reason, /^already_scheduled/);
      const out = await rt.social.dispatch(new Date(Date.now() + 5 * 60000));
      assert.equal(out.published, 4, JSON.stringify(out));
      const posts = await db.collection('growth_social_posts').find({ draftId: boxing.id }).toArray();
      const by = Object.fromEntries(posts.map((p) => [p.channel, p]));
      assert.equal(by.instagram.imageUrl, boxing.poster.portrait.url); assert.equal(by.facebook.imageUrl, boxing.poster.portrait.url);
      assert.equal(by.tiktok.imageUrl, boxing.poster.story.url);
      for (const p of posts) { assert.equal(p.status, 'published'); assert.equal(p.sandbox, true, 'sandbox receipts only'); }
      const receipts = await db.collection('growth_social_sandbox').find({ postId: { $in: posts.map((p) => p.id) } }).toArray();
      assert.equal(receipts.length, 4);
      const ig = receipts.find((r) => r.channel === 'instagram');
      assert.ok(ig.preflight.notes.some((n) => /image checked \(image\/jpeg/.test(n)), JSON.stringify(ig.preflight));
      assert.ok(receipts.find((r) => r.channel === 'x').preflight.notes.some((n) => /poster is not attached/.test(n)));
      assert.ok(receipts.find((r) => r.channel === 'tiktok').preflight.notes.some((n) => /not clickable/.test(n)));
    });

    await t.test('owner blocks artwork: text poster, campaign back to review, queued posts cancelled', async () => {
      const d2 = await drafts.findOne({ contestId: 'bx0000000002' });
      assert.equal(d2.poster.art.used, true);
      assert.equal((await call('POST', `/admin/drafts/${encodeURIComponent(d2.id)}/approve`)).status, 200);
      const s = await call('POST', `/admin/drafts/${encodeURIComponent(d2.id)}/schedule`, { channels: ['facebook', 'instagram'], scheduledAt: new Date(Date.now() + 60 * 60000).toISOString() });
      assert.equal(s.status, 200, s.text);
      assert.equal((await call('POST', '/admin/art-rights/bx0000000002', { status: 'blocked', note: '' })).status, 422, 'a reason is required');
      assert.equal((await call('POST', '/admin/art-rights/bx0000000002', { status: 'blocked', note: 'Owner test: image licence not confirmed' })).status, 200);
      const after = await drafts.findOne({ id: d2.id });
      assert.equal(after.status, 'needs_owner_review'); assert.equal(after.poster.art.used, false); assert.equal(after.poster.art.reason, 'artwork_blocked_by_owner');
      assert.equal((await fetch(d2.poster.portrait.url)).status, 404, 'the old poster is no longer served');
      const queued = await db.collection('growth_social_posts').find({ draftId: d2.id }).toArray();
      assert.ok(queued.length === 2 && queued.every((p) => p.status === 'cancelled'));
      assert.equal((await call('POST', '/admin/art-rights/bx0000000002', { status: 'allowed' })).status, 200);
      assert.equal((await drafts.findOne({ id: d2.id })).poster.art.used, true);
    });

    await t.test('failure recovery: interrupted publish is flagged, never reposted; retries need confirmation', async () => {
      const d3 = await drafts.findOne({ contestId: 'kb0000000001' });
      assert.equal((await call('POST', `/admin/drafts/${encodeURIComponent(d3.id)}/approve`)).status, 200);
      await call('POST', `/admin/drafts/${encodeURIComponent(d3.id)}/schedule`, { channels: ['facebook'], scheduledAt: new Date(Date.now() + 60000).toISOString() });
      const id = `${d3.id}__facebook`;
      await db.collection('growth_social_posts').updateOne({ id }, { $set: { status: 'publishing', claimedAt: new Date(Date.now() - 3 * 3600000).toISOString() } });
      const out = await rt.social.dispatch(new Date());
      assert.equal(out.needsCheck, 1);
      assert.equal((await db.collection('growth_social_posts').findOne({ id })).status, 'needs_check');
      assert.equal((await call('POST', `/admin/social/${encodeURIComponent(id)}/retry`, {})).status, 409, 'cannot re-queue without confirming it is not live');
      assert.equal((await call('POST', `/admin/social/${encodeURIComponent(id)}/retry`, { confirmNotPublished: true })).status, 200);
    });

    await t.test('nothing real: no live posts, no posts outside the sandbox', async () => {
      assert.equal(await db.collection('growth_social_posts').countDocuments({ status: 'published', sandbox: { $ne: true } }), 0);
    });
  } finally {
    server.close(); await client.close();
  }
});
