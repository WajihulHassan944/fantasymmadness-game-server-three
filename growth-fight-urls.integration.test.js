'use strict';
// Fighter-name URLs end to end on a real (loopback) MongoDB: campaigns start on the ID
// address (website without clean URLs, as today), switch automatically when the website
// starts redirecting to fighter-name addresses, update already-approved and already-scheduled
// posts at send time, keep affiliate ref + campaign tags, and fall back to the ID address if
// the clean address stops working. The website is a stand-in; nothing leaves the machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { MongoClient } = require('mongodb');
const { registerIsolatedGrowthRoutes } = require('./growth-isolated-routes');
const { hashPassword } = require('./growth-backoffice');
const { signConsoleToken, consolePasswordVersion } = require('./growth-console-token');
const { contestFeed } = require('./growth-contest-feed.fixture');

const uri = process.env.GROWTH_TEST_MONGO_URI;
const skip = !uri || !/^mongodb:\/\/(127\.0\.0\.1|localhost)/.test(uri) ? 'needs loopback MongoDB' : false;
const SITE = 'https://www.fantasymmadness.com';
const NAMES = {
  bx0000000001: 'naoya-inoue-vs-murodjon-akhmadaliev', bx0000000002: 'shakur-stevenson-vs-william-zepeda', mm0000000001: 'merab-dvalishvili-vs-petr-yan', mm0000000002: 'alexandre-pantoja-vs-joshua-van',
  kb0000000001: 'superbon-singha-mawynn-vs-masaaki-noiri', kb0000000002: 'tawanchai-pk-saenchai-vs-jo-nattawut', bk0000000001: 'mike-perry-vs-jeremy-stephens', bk0000000002: 'luis-palomino-vs-austin-trout',
};
const feed = contestFeed();

test('fighter-name URLs in every campaign, with the ID address as fallback', { skip, timeout: 120000 }, async (t) => {
  let mode = 'none'; const siteCalls = [];
  const page = (status, html = '', headers = {}) => ({ ok: status < 300, status, headers: { get: (k) => headers[String(k).toLowerCase()] || null }, text: async () => html, json: async () => ({}) });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(String(url));
    if (u.origin === SITE) {
      siteCalls.push({ url: String(url), method: opts.method || 'GET' });
      const id = u.pathname.match(/^\/fight\/([a-z0-9]{12})$/)?.[1];
      if (id) return NAMES[id] && mode === 'redirect' ? page(308, '', { location: `/fight/${NAMES[id]}` }) : page(200, '<head><title>Fight</title></head>');
      const slug = u.pathname.match(/^\/fight\/([a-z0-9-]+-vs-[a-z0-9-]+)$/)?.[1];
      if (slug) return mode === 'broken' ? page(404) : page(200, '<html>fight</html>');
      return page(200);
    }
    if (opts.method === 'HEAD') return page(200, '', { 'content-type': 'image/jpeg', 'content-length': '1000' });
    const f = feed(String(url)); if (f) return f;
    return { ok: true, status: 200, json: async () => ({ results: [] }) };
  };
  const client = await new MongoClient(uri).connect();
  await client.db('fmgrowthtest').dropDatabase();
  const app = express();
  const SECRET = 's'.repeat(48); const HASH = hashPassword('fight url test');
  const env = { GROWTH_STAGING_MODE: 'isolated', GROWTH_OUTBOUND_ENABLED: 'false', GROWTH_TEST_MONGO_URI: uri, JWT_SECRET_ADMIN: SECRET, GROWTH_UNSUBSCRIBE_SECRET: SECRET, CRON_SECRET: 'cron-secret-for-tests-only', GROWTH_DELIVERY_PROVIDER: 'none', GROWTH_ADMIN_PASSWORD_HASH: HASH, GROWTH_SOCIAL_PROVIDER: 'sandbox' };
  const m = registerIsolatedGrowthRoutes({ app, env, express, fetchImpl, connect: async () => client });
  const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/growth`;
  const token = signConsoleToken(SECRET, { pwv: consolePasswordVersion(HASH) });
  const call = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const rt = await m.getRuntime();
  const drafts = client.db('fmgrowthtest').collection('growth_drafts');
  const expire = () => client.db('fmgrowthtest').collection('growth_fight_urls').updateMany({}, { $set: { checkedAt: new Date(0).toISOString() } });
  const BX = 'bx0000000001';
  let approvedId,scheduledPostId;
  try {
    await t.test('website without clean URLs (today): campaigns use the working ID address', async () => {
      await rt.refreshMarketing(new Date());
      const d = await drafts.findOne({ contestId: BX });
      assert.ok(d, 'campaign created');
      for (const ch of ['facebook','x']) assert.ok(d.posts[ch].includes(`${SITE}/fight/${BX}?play=1&utm_source=fan_acquisition`), ch);
      assert.equal(d.contest.urlSource, 'id'); assert.equal(d.contest.cleanUrl, null);
      assert.ok(siteCalls.some((c) => c.url === `${SITE}/fight/${BX}`), 'the website was asked');
    });

    await t.test('campaigns made before this change get their address source recorded (text unchanged)', async () => {
      const d = await drafts.findOne({ contestId: 'kb0000000001' });
      await drafts.updateOne({ id: d.id }, { $unset: { 'contest.urlSource': '', 'contest.idUrl': '', 'contest.idBase': '', 'contest.cleanUrl': '' } });
      await rt.refreshMarketing(new Date());
      const after = await drafts.findOne({ id: d.id });
      assert.equal(after.contest.urlSource, 'id'); assert.ok(after.contest.idUrl.endsWith('/fight/kb0000000001?play=1'));
      assert.equal(after.posts.facebook, d.posts.facebook); assert.equal((after.linkHistory || []).length, 0);
    });

    await t.test('platform editing restores tracking; refresh never overwrites owner work',async()=>{
      const d=await drafts.findOne({contestId:'kb0000000002'}),bare=d.posts.facebook.replace(/\?play=1&\S+/,'');
      const r=await call('POST',`/admin/drafts/${encodeURIComponent(d.id)}/edit`,{text:bare,channel:'facebook'});assert.equal(r.status,200,JSON.stringify(r.json));
      const after=await drafts.findOne({id:d.id});assert.match(after.posts.facebook,/utm_content=facebook/);assert.equal(after.posts.instagram,d.posts.instagram);
      await drafts.updateOne({id:d.id},{$set:{'posts.facebook':bare,editedAt:new Date().toISOString()}});await rt.refreshMarketing(new Date());assert.equal((await drafts.findOne({id:d.id})).posts.facebook,bare);
      assert.equal((await rt.approveDraft(d.id,{admin:'owner@fixture.invalid'})).ok,false,'owner work with broken attribution must await correction');
    });

    await t.test('an approved campaign is scheduled while only the ID address exists', async () => {
      const d = await drafts.findOne({ contestId: BX });
      approvedId = d.id;
      assert.equal((await call('POST', `/admin/drafts/${encodeURIComponent(d.id)}/approve`)).status, 200);
      const s = await call('POST', `/admin/drafts/${encodeURIComponent(d.id)}/schedule`, { channels: ['facebook', 'x'], scheduledAt: new Date(Date.now() + 30 * 60000).toISOString() });
      assert.equal(s.json.results.filter((r) => r.ok).length, 2, JSON.stringify(s.json));
      scheduledPostId = s.json.results.find((r) => r.channel === 'facebook').id;
      const p = await client.db('fmgrowthtest').collection('growth_social_posts').findOne({ id: scheduledPostId });
      assert.ok(p.text.includes(`${SITE}/fight/${BX}?play=1&`));
    });

    await t.test('the website starts redirecting to fighter-name URLs: every open campaign switches automatically', async () => {
      mode = 'redirect'; await expire();
      await rt.refreshMarketing(new Date());
      const all = await drafts.find({ kind: 'marketing', contestId: { $in: Object.keys(NAMES) }, status: { $in: ['needs_owner_review', 'approved'] } }).toArray();
      assert.ok(all.length >= 6);
      for (const d of all) {
        const clean = `${SITE}/fight/${NAMES[d.contestId]}`;
        if(d.status==='approved'||d.editedBy){assert.ok(d.posts.facebook.includes('/fight/'));continue;}assert.equal(d.contest.cleanUrl, clean, d.id); assert.equal(d.contest.urlSource, 'redirect');
        for (const ch of ['facebook','x']) {
          assert.ok(d.posts[ch].includes(`${clean}?play=1&utm_source=fan_acquisition&utm_medium=partner_outreach&utm_campaign=combat_fans_gs_`), `${d.id} ${ch}`);
          assert.ok(!d.posts[ch].includes(`/fight/${d.contestId}`), `${d.id} ${ch} still has the ID address`);
          assert.match(d.posts[ch], new RegExp(`utm_content=${ch}`));
        }
        assert.ok(!/Link in bio|https?:\/\//.test(d.posts.tiktok));
        assert.ok((d.contentHistory||[]).some(h=>h.reason==='verified_address_changed'));
      }
      // nothing was withdrawn by the safeguard because of the new address
      assert.equal(await drafts.countDocuments({ contestId: { $in: Object.keys(NAMES) }, status: 'rejected' }), 0);
      assert.equal((await drafts.findOne({ id: approvedId })).status, 'approved', 'approval kept');
    });

    await t.test('a post scheduled with the ID address goes out with the fighter-name URL (tags kept, logged)', async () => {
      const out = await rt.social.dispatch(new Date(Date.now() + 31 * 60000));
      assert.equal(out.published, 2, JSON.stringify(out));
      const p = await client.db('fmgrowthtest').collection('growth_social_posts').findOne({ id: scheduledPostId });
      assert.equal(p.status, 'published'); assert.equal(p.sandbox, true);
      assert.ok(p.text.includes(`${SITE}/fight/${NAMES[BX]}?play=1&utm_source=fan_acquisition&utm_medium=partner_outreach&utm_campaign=combat_fans_gs_boxing&utm_content=facebook`), p.text);
      assert.ok(p.history.some((h) => /fighter-name address/.test(h.note || '')));
    });

    await t.test('affiliate scheduling fails closed when no personalized approved poster is available', async () => {
      const d2 = await drafts.findOne({ contestId: 'bx0000000002' });
      await call('POST', `/admin/drafts/${encodeURIComponent(d2.id)}/approve`);
      await client.db('fmgrowthtest').collection('growth_affiliates').insertOne({ id: 'aff-1', name: 'Coach Rivera', genre: 'boxing', code: 'aff_coach_rivera_ab12', status: 'active', liveAffiliateId: 'b'.repeat(24), createdAt: new Date().toISOString(), history: [] });
      const s = await call('POST', `/admin/drafts/${encodeURIComponent(d2.id)}/schedule`, { channels: ['facebook'], scheduledAt: new Date(Date.now() + 60000).toISOString(), affiliateId: 'aff-1' });
      assert.equal(s.json.results[0].ok, false, JSON.stringify(s.json));
      assert.equal(s.json.results[0].reason, 'affiliate_identity_or_approved_poster_unavailable');
      assert.equal(await client.db('fmgrowthtest').collection('growth_social_posts').countDocuments({ 'affiliate.id': 'aff-1' }), 0);
    });

    await t.test('if the fighter-name URL stops working, campaigns fall back to the ID address', async () => {
      mode = 'broken'; await expire();
      await rt.refreshMarketing(new Date());
      const d = await drafts.findOne({ contestId: 'mm0000000001' });
      assert.equal(d.contest.cleanUrl, null); assert.equal(d.contest.urlSource, 'id');
      assert.ok(d.posts.facebook.includes(`${SITE}/fight/mm0000000001?play=1&utm_source=fan_acquisition`));
      assert.ok(!d.posts.tiktok.includes('🔗'));
      assert.equal(d.status, 'needs_owner_review');
    });

    await t.test('the console API shows which address each campaign uses', async () => {
      const r = await call('GET', '/admin/drafts?kind=marketing&limit=50');
      const d = r.json.drafts.find((x) => x.contestId === 'mm0000000001');
      assert.equal(d.contest.urlSource, 'id'); assert.ok(d.contest.idUrl.endsWith('/fight/mm0000000001?play=1'));
    });
  } finally {
    server.close(); await client.close();
  }
});
