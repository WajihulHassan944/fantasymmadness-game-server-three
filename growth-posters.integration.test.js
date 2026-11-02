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
  const synth = (w, h, a, b) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${a}"/><rect y="${h * 0.45}" width="${w}" height="${h * 0.1}" fill="${b}"/></svg>`)).jpeg({ quality: 95 }).toBuffer();
  const art = await synth(900, 1100, '#1d4ed8', '#f5c518');      // official matchup artwork (synthetic)
  const photoA = await synth(700, 1000, '#0f766e', '#fde68a');   // synthetic stand-ins for approved fighter photos
  const photoB = await synth(760, 980, '#7c2d12', '#e5e7eb');
  const photoC = await synth(720, 990, '#312e81', '#fca5a5');
  const photoD = await synth(740, 1010, '#3f6212', '#fef08a');
  const PHOTOS = { 'https://res.cloudinary.com/daflot6fo/image/upload/v1/fighters/inoue.jpg': photoA, 'https://res.cloudinary.com/daflot6fo/image/upload/v1/fighters/akhmadaliev.jpg': photoB,
    'https://res.cloudinary.com/daflot6fo/image/upload/v1/fighters/dvalishvili.jpg': photoC, 'https://res.cloudinary.com/daflot6fo/image/upload/v1/fighters/yan.jpg': photoD };
  // The fixture feed, with photos FANTASY MMADNESS attached to one contest (both fighters).
  const baseFeed = contestFeed();
  const feed = (u) => {
    const f = baseFeed(u); if (!f || !u.includes('/api/public/prediction-fights')) return f;
    return { ...f, json: async () => { const j = await f.json(); for (const it of j.items) if (it._id === 'bx0000000001') Object.assign(it, { fighterAImage: 'https://res.cloudinary.com/daflot6fo/image/upload/v1/fighters/inoue.jpg', fighterAImageOverride: true, fighterBImage: 'https://res.cloudinary.com/daflot6fo/image/upload/v1/fighters/akhmadaliev.jpg', fighterBImageOverride: true }); return j; } };
  };
  let brokenFightPage = null; const siteHits = [];
  const artFetches = [];
  let origin = null;
  const PUBLIC = 'https://growth-staging.test';
  const local = (u) => u.replace(PUBLIC, origin);
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    if (u.startsWith(PUBLIC)) return fetch(local(u), opts); // our own public poster address (https, as on staging)
    const f = feed(u); if (f) return f;
    if (PHOTOS[u]) { artFetches.push(u); return { ok: true, status: 200, headers: new Headers({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => PHOTOS[u] }; }
    if (/^https:\/\/res\.cloudinary\.com\/demo\/image\/upload\//.test(u)) { artFetches.push(u); return { ok: true, status: 200, headers: new Headers({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => art }; }
    if (u.startsWith('https://www.fantasymmadness.com/fight/') || u.startsWith('https://www.fantasymmadness.com/pro-wrestling/')) { siteHits.push(u); const path = u.split('?')[0]; return brokenFightPage && path.includes(brokenFightPage) ? { ok: false, status: 404, url: path } : { ok: true, status: 200, url: path }; }
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
    GROWTH_DELIVERY_PROVIDER: 'none', GROWTH_ADMIN_PASSWORD_HASH: PASSWORD_HASH, GROWTH_SOCIAL_PROVIDER: 'sandbox', GROWTH_POSTERS: 'on', GROWTH_POSTERS_PER_RUN: '20', GROWTH_PUBLIC_ORIGIN: PUBLIC, GROWTH_RESEARCH_PER_RUN: '0', GROWTH_ART_CLOUDINARY_CLOUDS: 'daflot6fo,demo' };
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
        assert.ok(d.poster.portrait.url.startsWith(`${PUBLIC}/api/growth/posters/`));
        assert.ok(['facebook', 'instagram', 'x', 'tiktok'].every((ch) => d.posts[ch]), `${d.id}: missing a platform caption`);
        assert.match(d.posts.instagram, /#FANTASYMMADNESS/); assert.match(d.posts.x, /#FANTASYMMADNESS/);
      }
    });

    let boxing; let noArt;
    await t.test('artwork: approved photos of both fighters, else official contest artwork, else NEEDS ARTWORK; full provenance', async () => {
      boxing = await drafts.findOne({ contestId: 'bx0000000001' });
      noArt = await drafts.findOne({ contestId: 'mm0000000002' }); // fixture contest published without any artwork
      const contestArt = await drafts.findOne({ contestId: 'bx0000000002' });
      assert.equal(boxing.poster.art.mode, 'fighter_photos', JSON.stringify(boxing.poster.art.problems));
      assert.deepEqual(boxing.poster.art.fighters.map((f) => [f.side, f.name, f.source]), [['a', 'Naoya Inoue', 'contest_upload'], ['b', 'Murodjon Akhmadaliev', 'contest_upload']]);
      for (const f of boxing.poster.art.fighters) { assert.match(f.sha256, /^[a-f0-9]{64}$/); assert.match(f.basis, /attached to this contest/); }
      assert.equal(contestArt.poster.art.mode, 'contest_artwork'); assert.deepEqual(contestArt.poster.art.missing, ['Shakur Stevenson', 'William Zepeda']);
      assert.equal(noArt.poster.art.mode, 'text'); assert.equal(noArt.poster.needsArtwork, true); assert.deepEqual(noArt.poster.art.missing, ['Alexandre Pantoja', 'Joshua Van']);
      for (const d of [boxing, contestArt, noArt]) { assert.equal(d.poster.status, 'ready', JSON.stringify(d.poster.holdReasons)); assert.equal(d.poster.qr.decodedPortrait, d.poster.qrUrl); assert.equal(d.poster.qr.decodedStory, d.poster.qrUrl); assert.equal(d.poster.qr.destination.ok, true); }
      assert.ok(artFetches.every((u) => /^https:\/\/res\.cloudinary\.com\/(daflot6fo|demo)\/image\/upload\//.test(u)), 'only FMM asset addresses are fetched');
      const meta = (await call('GET', `/admin/posters?draftId=${encodeURIComponent(boxing.id)}`)).json.posters;
      assert.equal(meta.length, 2);
      const p = meta.find((x) => x.format === 'portrait');
      assert.equal(p.facts.fighterA, 'Naoya Inoue'); assert.equal(p.facts.fighterB, 'Murodjon Akhmadaliev'); assert.equal(p.facts.where, 'Ariake Arena · Tokyo');
      assert.ok(!('bytes' in p), 'admin metadata never includes the image bytes');
      assert.equal(p.layout.images.length, 2);
      for (const im of p.layout.images) assert.ok(Math.abs(im.width / im.height - im.sourceWidth / im.sourceHeight) < 0.01, 'photo aspect ratio kept');
    });

    await t.test('owner photo library: exact fighter, rights note, one image per fighter, regenerates the poster', async () => {
      const mm1 = await drafts.findOne({ contestId: 'mm0000000001' });
      assert.equal(mm1.poster.art.mode, 'contest_artwork');
      assert.equal((await call('POST', '/admin/fighter-assets', { fighterName: 'Merab Dvalishvili', imageUrl: 'https://res.cloudinary.com/daflot6fo/image/upload/v1/fighters/dvalishvili.jpg', rightsNote: '' })).json.reason, 'rights_note_required');
      assert.equal((await call('POST', '/admin/fighter-assets', { fighterName: 'Merab Dvalishvili', imageUrl: 'https://images.example.com/merab.jpg', rightsNote: 'x' })).json.reason, 'artwork_host_not_a_fantasy_mmadness_asset_host');
      assert.equal((await call('POST', '/admin/fighter-assets', { fighterName: 'Merab Dvalishvili', imageUrl: 'https://res.cloudinary.com/daflot6fo/image/upload/v1/fighters/dvalishvili.jpg', rightsNote: 'Official UFC promotion photo supplied to FMM' })).status, 201);
      assert.equal((await call('POST', '/admin/fighter-assets', { fighterName: 'Petr Yan', imageUrl: 'https://res.cloudinary.com/daflot6fo/image/upload/v1/fighters/dvalishvili.jpg', rightsNote: 'x' })).json.reason, 'this_image_is_already_approved_for_another_fighter');
      assert.equal((await drafts.findOne({ id: mm1.id })).poster.art.mode, 'contest_artwork', 'one approved photo is not enough for a photo poster');
      const r = await call('POST', '/admin/fighter-assets', { fighterName: 'Petr Yan', imageUrl: 'https://res.cloudinary.com/daflot6fo/image/upload/v1/fighters/yan.jpg', rightsNote: 'Official UFC promotion photo supplied to FMM' });
      assert.equal(r.status, 201); assert.ok(r.json.posters.generated >= 1);
      const after = await drafts.findOne({ id: mm1.id });
      assert.equal(after.poster.art.mode, 'fighter_photos');
      assert.deepEqual(after.poster.art.fighters.map((f) => [f.name, f.source]), [['Merab Dvalishvili', 'owner_library'], ['Petr Yan', 'owner_library']]);
      assert.ok(after.poster.art.fighters.every((f) => f.approvedBy && f.rightsNote && /^[a-f0-9]{64}$/.test(f.sha256)), 'provenance recorded');
      const lib = (await call('GET', '/admin/fighter-assets')).json.assets;
      assert.equal(lib.length, 2);
      // revoking a photo drops the poster back to the matchup artwork
      assert.equal((await call('POST', `/admin/fighter-assets/${lib.find((a) => a.fighterName === 'Petr Yan').id}/revoke`)).status, 200);
      assert.equal((await drafts.findOne({ id: mm1.id })).poster.art.mode, 'contest_artwork');
    });

    await t.test('NEEDS ARTWORK needs an explicit text-poster approval; a fight page that does not open puts the poster ON HOLD', async () => {
      const r1 = await call('POST', `/admin/drafts/${encodeURIComponent(noArt.id)}/approve`);
      assert.equal(r1.status, 409); assert.equal(r1.json.reason, 'needs_artwork_confirm_text_poster');
      assert.equal((await call('POST', `/admin/drafts/${encodeURIComponent(noArt.id)}/approve`, { acceptTextPoster: true })).status, 200);
      brokenFightPage = 'kb0000000002';
      const kb2 = await drafts.findOne({ contestId: 'kb0000000002' });
      const r2 = await call('POST', `/admin/drafts/${encodeURIComponent(kb2.id)}/approve`);
      assert.equal(r2.status, 409); assert.equal(r2.json.reason, 'poster_on_hold'); assert.deepEqual(r2.json.details, ['destination_http_404']);
      brokenFightPage = null;
    });

    await t.test('posters are served publicly with the headers platforms need; QR scans to the campaign link', async () => {
      for (const fmt of ['portrait', 'story']) {
        const url = boxing.poster[fmt].url;
        const head = await fetch(local(url), { method: 'HEAD' });
        assert.equal(head.status, 200); assert.equal(head.headers.get('content-type'), 'image/jpeg');
        assert.equal(head.headers.get('x-image-width'), '1080'); assert.equal(head.headers.get('x-image-height'), fmt === 'portrait' ? '1350' : '1920');
        const body = Buffer.from(await (await fetch(local(url))).arrayBuffer());
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
      if (out.published !== 4) assert.fail(JSON.stringify((await db.collection('growth_social_posts').find({ draftId: boxing.id }).toArray()).map((p) => [p.channel, p.status, p.lastError])));
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
      assert.equal((await fetch(local(d2.poster.portrait.url))).status, 404, 'the old poster is no longer served');
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
