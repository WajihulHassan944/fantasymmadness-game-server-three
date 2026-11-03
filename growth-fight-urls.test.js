'use strict';
// Fighter-name fight URLs come from the website (redirect / canonical / feed), are verified,
// keep every query parameter, and fall back to the ID address. No network: a stand-in website.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFightUrlResolver, relink, relinkCampaign, tiktokLine, normalizeCandidate, idBaseFor } = require('./growth-fight-urls');
const { buildCampaign, checkCampaign } = require('./growth-contest-campaigns');
const { playerLink } = require('./growth-affiliate-program');

const SITE = 'https://www.fantasymmadness.com';
const fight = { id: '6650f0c2a1b2c3d4e5f60718', sport: 'boxing', fighterA: 'Naoya Inoue', fighterB: 'Murodjon Akhmadaliev', dateKey: '2027-01-10', timeTba: true, timeZone: 'America/New_York', contestUrl: `${SITE}/fight/6650f0c2a1b2c3d4e5f60718?play=1`, venue: null, city: null, weightClass: null, maxRounds: 12, promotion: null, eventName: null, status: 'ongoing', posterUrl: null, fingerprint: 'abc' };
const wrestling = { ...fight, id: 'pw0000000001', sport: 'pro-wrestling', fighterA: 'Kenny Omega', fighterB: 'Will Ospreay', contestUrl: `${SITE}/pro-wrestling/play/pw0000000001` };
const CLEAN = `${SITE}/fight/naoya-inoue-vs-murodjon-akhmadaliev`;

// Stand-in for the website's routing (what Codex's repair is expected to provide).
function site(mode, calls = []) {
  return async (url, opts = {}) => {
    calls.push({ url, opts });
    const u = new URL(url);
    const page = (status, html = '<html></html>', headers = {}) => ({ ok: status < 300, status, headers: { get: (k) => headers[String(k).toLowerCase()] || null }, text: async () => html });
    if (u.pathname === `/fight/${fight.id}`) {
      if (mode === 'redirect') return page(308, '', { location: '/fight/naoya-inoue-vs-murodjon-akhmadaliev' });
      if (mode === 'canonical') return page(200, `<head><link rel="canonical" href="${CLEAN}"/></head>`);
      if (mode === 'foreign') return page(301, '', { location: 'https://evil.example/fight/naoya' });
      if (mode === 'league') return page(302, '', { location: '/league/kelly?fightId=1' });
      if (mode === 'broken') return page(308, '', { location: '/fight/naoya-inoue-vs-murodjon-akhmadaliev' });
      if (mode === 'down') throw new Error('ECONNRESET');
      return page(200, '<head><title>Fight</title></head>');
    }
    if (u.pathname === '/fight/naoya-inoue-vs-murodjon-akhmadaliev') {
      if (mode === 'broken') return page(404);
      return u.searchParams.get('play') === '1' ? page(200) : page(200);
    }
    if (u.pathname === '/pro-wrestling/play/pw0000000001') return mode === 'redirect' ? page(308, '', { location: '/pro-wrestling/kenny-omega-vs-will-ospreay' }) : page(200);
    if (u.pathname === '/pro-wrestling/kenny-omega-vs-will-ospreay') return page(200);
    return page(404);
  };
}
const memCol = () => { const rows = new Map(); return { rows, createIndex: async () => {}, findOne: async (q) => rows.get(q.contestId) || null, updateOne: async (q, u) => { rows.set(q.contestId, { ...(rows.get(q.contestId) || {}), ...u.$set }); } }; };

test('redirect from the ID address: clean fighter-name URL, verified with ?play=1', async () => {
  const calls = [];
  const [c] = await createFightUrlResolver({ col: memCol(), fetchImpl: site('redirect', calls) }).enrich([fight]);
  assert.equal(c.cleanUrl, CLEAN); assert.equal(c.urlSource, 'redirect');
  assert.equal(c.contestUrl, `${CLEAN}?play=1`); assert.equal(c.idUrl, `${SITE}/fight/${fight.id}?play=1`);
  assert.ok(calls.some((x) => x.url === `${CLEAN}?play=1`), 'clean address was not verified');
  assert.ok(calls.every((x) => x.opts.redirect === 'manual'));
});

test('canonical link on the ID page is used; pro-wrestling keeps its own (no play=1) form', async () => {
  const [c] = await createFightUrlResolver({ col: memCol(), fetchImpl: site('canonical') }).enrich([fight]);
  assert.equal(c.cleanUrl, CLEAN); assert.equal(c.urlSource, 'canonical');
  const [w] = await createFightUrlResolver({ col: memCol(), fetchImpl: site('redirect') }).enrich([wrestling]);
  assert.equal(w.contestUrl, `${SITE}/pro-wrestling/kenny-omega-vs-will-ospreay`);
});

test('fallback to the ID address: no clean URL, broken clean URL, foreign host, league page, site down, switched off', async () => {
  for (const mode of ['none', 'broken', 'foreign', 'league', 'down']) {
    const [c] = await createFightUrlResolver({ col: memCol(), fetchImpl: site(mode) }).enrich([fight]);
    assert.equal(c.cleanUrl, null, mode); assert.equal(c.urlSource, 'id', mode); assert.equal(c.contestUrl, `${SITE}/fight/${fight.id}?play=1`, mode);
  }
  const off = []; const [c] = await createFightUrlResolver({ col: memCol(), fetchImpl: site('redirect', off), enabled: false }).enrich([fight]);
  assert.equal(c.cleanUrl, null); assert.equal(off.length, 0);
  assert.equal(normalizeCandidate('http://www.fantasymmadness.com/fight/x', fight), null, 'http refused');
  assert.equal(normalizeCandidate(`/fight/${fight.id}`, fight), null, 'the ID address is not a clean address');
  assert.equal(normalizeCandidate('https://fantasymmadness.com/fight/a-vs-b/', fight), `${SITE}/fight/a-vs-b`);
});

test('cache: re-checked after expiry; a site outage keeps the last known address', async () => {
  const col = memCol(); const calls = [];
  const r = createFightUrlResolver({ col, fetchImpl: site('redirect', calls), ttlMs: 1000 });
  await r.enrich([fight], new Date(0));
  const n = calls.length;
  await r.enrich([fight], new Date(500)); assert.equal(calls.length, n, 'fresh cache must not refetch');
  const down = createFightUrlResolver({ col, fetchImpl: site('down'), ttlMs: 1000 });
  const [c] = await down.enrich([fight], new Date(5000));
  assert.equal(c.cleanUrl, CLEAN, 'outage dropped the known clean address');
});

test('campaigns use the clean address, keep play=1 + campaign tags, and pass the safeguard; TikTok shows it readably', async () => {
  const [c] = await createFightUrlResolver({ col: memCol(), fetchImpl: site('redirect') }).enrich([fight]);
  const k = buildCampaign(c);
  for (const ch of ['instagram', 'facebook', 'x']) {
    assert.ok(k.posts[ch].includes(`${CLEAN}?play=1&utm_source=fan_acquisition&utm_medium=partner_outreach&utm_campaign=combat_fans_gs_boxing&utm_content=${ch}`), ch);
    assert.ok(!k.posts[ch].includes(fight.id), `${ch} still has the fight ID`);
  }
  assert.match(k.posts.tiktok, /🔗 fantasymmadness\.com\/fight\/naoya-inoue-vs-murodjon-akhmadaliev/);
  const draft = { id: 'mkt-1', kind: 'marketing', genre: 'boxing', contestId: c.id, contestFingerprint: c.fingerprint, contest: c, headline: k.headline, text: k.text, posts: k.posts, link: k.link };
  assert.deepEqual(checkCampaign(draft, c, { now: new Date('2027-01-01T12:00:00Z') }), []);
  // a campaign written with the ID address still passes against the clean-address contest (fallback stays valid)
  const old = buildCampaign(fight);
  assert.deepEqual(checkCampaign({ ...draft, text: old.text, posts: old.posts }, c, { now: new Date('2027-01-01T12:00:00Z') }), []);
});

test('existing campaigns are relinked both ways without touching tags or text', async () => {
  const [clean] = await createFightUrlResolver({ col: memCol(), fetchImpl: site('redirect') }).enrich([fight]);
  const [plain] = await createFightUrlResolver({ col: memCol(), fetchImpl: site('none') }).enrich([fight]);
  const old = buildCampaign(plain);
  const up = relinkCampaign({ text: old.text, posts: old.posts, link: old.link, contest: plain }, clean);
  assert.equal(up.posts.facebook, old.posts.facebook.split(`${SITE}/fight/${fight.id}`).join(CLEAN));
  assert.match(up.posts.tiktok, /🔗 fantasymmadness\.com/);
  const down = relinkCampaign({ ...up, contest: clean }, plain);
  assert.equal(down.posts.facebook, old.posts.facebook); assert.equal(down.posts.tiktok, old.posts.tiktok);
  // relink only swaps whole addresses (a longer path that merely starts the same is untouched)
  assert.equal(relink(`${SITE}/fight/ab?x=1 ${SITE}/fight/abc`, `${SITE}/fight/ab`, `${SITE}/fight/new`), `${SITE}/fight/new?x=1 ${SITE}/fight/abc`);
  assert.equal(tiktokLine(`${up.posts.tiktok}`, plain), old.posts.tiktok);
});

test('affiliate links keep ref= and the affiliate campaign tag on the clean address; ID form otherwise', async () => {
  const [c] = await createFightUrlResolver({ col: memCol(), fetchImpl: site('redirect') }).enrich([fight]);
  const a = { status: 'active', liveAffiliateId: 'a'.repeat(24), code: 'aff_coach_ab12' };
  assert.equal(playerLink(a, c), `${CLEAN}?play=1&ref=${'a'.repeat(24)}&utm_source=fan_acquisition&utm_medium=partner_outreach&utm_campaign=combat_fans_aff_coach_ab12&utm_content=boxing`);
  assert.equal(playerLink(a, fight), `${idBaseFor(fight)}?play=1&ref=${'a'.repeat(24)}&utm_source=fan_acquisition&utm_medium=partner_outreach&utm_campaign=combat_fans_aff_coach_ab12&utm_content=boxing`);
});

test('campaign tags are restored on a fight link after an edit; generated links stay identical', async () => {
  const { tagCampaignLinks } = require('./growth-contest-campaigns');
  const [c] = await createFightUrlResolver({ col: memCol(), fetchImpl: site('redirect') }).enrich([fight]);
  const k = buildCampaign(c);
  for (const ch of ['facebook', 'instagram', 'x']) assert.equal(tagCampaignLinks(k.posts[ch], c, ch), k.posts[ch], `${ch} changed`);
  const tags = 'utm_source=fan_acquisition&utm_medium=partner_outreach&utm_campaign=combat_fans_gs_boxing';
  assert.equal(tagCampaignLinks(`Picks: ${CLEAN}.`, c, 'facebook'), `Picks: ${CLEAN}?play=1&${tags}&utm_content=facebook.`);
  assert.equal(tagCampaignLinks(`Picks ${SITE}/fight/${fight.id}`, c, 'instagram'), `Picks ${SITE}/fight/${fight.id}?play=1&${tags}&utm_content=instagram`);
  // a copy of the Instagram caption pasted for Facebook gets Facebook's tag
  assert.match(tagCampaignLinks(k.posts.instagram, c, 'facebook'), /utm_content=facebook/);
  // affiliate ref and affiliate campaign are kept
  const aff = `${CLEAN}?play=1&ref=${'a'.repeat(24)}&utm_source=fan_acquisition&utm_medium=partner_outreach&utm_campaign=combat_fans_aff_x_ab12&utm_content=boxing`;
  assert.equal(tagCampaignLinks(aff, c, 'facebook'), aff);
  // other pages are untouched
  assert.equal(tagCampaignLinks(`${SITE}/how-to-play and ${SITE}/fight/other-fight`, c, 'x'), `${SITE}/how-to-play and ${SITE}/fight/other-fight`);
});
