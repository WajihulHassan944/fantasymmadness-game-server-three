'use strict';
// Phase 1 growth-engine tests: fight-specific drafts, validation, review
// states, and proof that nothing outside the growth engine is written or sent.
const assert = require('assert');
const fs = require('fs');
const core = require('./fan-acquisition-fight-campaigns');
const { isFightOpenForEntry, getFightEntryLockTime } = require('./fight-entry-time');
const { affiliateLeagueFightLink, affiliatePaidFightLink } = require('./affiliate-custom-poster');

const NOW = Date.UTC(2026, 10, 1, 15); // 2026-11-01
const FIGHT_ID = '6a1b2c3d4e5f6a7b8c9d0e1f';
const AFF_ID = '5f0e1d2c3b4a5f6e7d8c9b0a';
const OTHER_AFF = '5f0e1d2c3b4a5f6e7d8c9b0b';
const POSTER = 'https://res.cloudinary.com/daflot6fo/image/upload/v1/fantasymmadness/fight-posters/main.png';

const fight = (over = {}) => ({
  _id: FIGHT_ID, matchFighterA: 'Alex Pereira', matchFighterB: 'Magomed Ankalaev', matchName: 'UFC 999',
  matchCategory: 'mma', matchCategoryTwo: 'UFC', matchStatus: 'Scheduled', matchType: 'LIVE',
  matchDate: new Date('2026-11-07T00:00:00Z'), matchDateKey: '2026-11-07', matchTime: '22:00', eventTimeZone: 'America/New_York',
  venue: 'T-Mobile Arena', eventCity: 'Las Vegas, NV', fightPosterImage: POSTER, matchBy: 'admin', ...over,
});
const affiliate = (over = {}) => ({ _id: AFF_ID, firstName: 'Kelly', lastName: 'Davis', leagueName: 'Kelly’s Fight Club', ...over });
const approvedPoster = (over = {}) => ({
  _id: '7a7a7a7a7a7a7a7a7a7a7a7a', fightId: FIGHT_ID, affiliateId: AFF_ID, status: 'approved', audience: 'one', qrTarget: 'league',
  qrLink: affiliateLeagueFightLink(AFF_ID, FIGHT_ID), imageUrl: 'https://res.cloudinary.com/daflot6fo/image/upload/v1/aff/qr.png', approvedAt: new Date(NOW - 1000), ...over,
});
const build = (over = {}) => core.buildFightCampaign({
  fight: fight(), source: 'match', isOpen: (f) => isFightOpenForEntry(f, NOW), isPublic: (f) => core.isPublicFight(f, 'match'),
  getLockTime: getFightEntryLockTime, affiliateLeagueFightLink, affiliatePaidFightLink, now: NOW, ...over,
});
const passAll = (campaign) => {
  let c = campaign;
  for (const [name, ch] of Object.entries(c.channels)) {
    if (!ch.enabled) continue;
    for (const check of core.REVIEW_CHECKS) {
      const r = core.applyReviewCheck(c, { channel: name, check, result: 'pass', reviewer: 'owner', now: NOW });
      assert.ok(!r.error, r.error); c = r.campaign;
    }
  }
  return c;
};
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log('ok -', name); };

// ---------------------------------------------------------------- content --
test('owner campaign has correct matchup, verified date, venue, links and four channel slots', () => {
  const { campaign, skipped } = build();
  assert.ok(!skipped);
  assert.strictEqual(campaign.matchup, 'Alex Pereira vs Magomed Ankalaev');
  assert.strictEqual(campaign.schedule.dateText, 'Saturday, November 7, 2026');
  assert.match(campaign.schedule.timeText, /^10:00\sPM EST$/);
  assert.strictEqual(campaign.schedule.startsAt, '2026-11-08T03:00:00.000Z');
  assert.strictEqual(campaign.venue, 'T-Mobile Arena, Las Vegas, NV');
  assert.strictEqual(campaign.state, 'draft');
  assert.deepStrictEqual(Object.keys(campaign.channels), ['instagram', 'facebook', 'x', 'affiliate_email']);
  assert.strictEqual(campaign.channels.affiliate_email.enabled, false);
  for (const name of ['instagram', 'facebook', 'x']) {
    const ch = campaign.channels[name];
    assert.ok(ch.text.includes('Alex Pereira') && ch.text.includes('Magomed Ankalaev'));
    assert.ok(ch.text.includes(ch.link));
    assert.ok(ch.text.includes('FANTASYMMADNESS.COM'));
    assert.ok(ch.link.startsWith(`https://www.fantasymmadness.com/fight/${FIGHT_ID}?play=1&utm_source=fan_acquisition&utm_medium=partner_outreach&utm_campaign=combat_fans_mma`));
    assert.strictEqual(core.validateCampaignUrl(ch.link, { fightId: FIGHT_ID }), '');
    assert.deepStrictEqual(ch.image, { url: POSTER, kind: 'fight_poster', hasQr: false, width: null, height: null });
    assert.deepStrictEqual(ch.blocking, []);
  }
  assert.ok(campaign.channels.x.characterCount <= 280);
  assert.notStrictEqual(campaign.channels.instagram.text, campaign.channels.facebook.text);
  assert.strictEqual(campaign.publishingEnabled, false);
  assert.strictEqual(campaign.sent, false);
});

test('owner link tags are exactly what the existing signup attribution accepts', () => {
  const link = new URL(build().campaign.channels.facebook.link);
  assert.strictEqual(link.searchParams.get('utm_source'), 'fan_acquisition');
  assert.strictEqual(link.searchParams.get('utm_medium'), 'partner_outreach');
  assert.match(link.searchParams.get('utm_campaign'), /^combat_fans_[a-z0-9_-]{1,60}$/);
  assert.ok(link.searchParams.get('utm_content').length <= 32);
});

test('no invented facts: venue omitted when unknown, no records or prize amounts', () => {
  const { campaign } = build({ fight: fight({ venue: '', eventCity: '', pot: 50000, matchTokens: 100 }) });
  assert.strictEqual(campaign.venue, null);
  for (const ch of Object.values(campaign.channels).filter((c) => c.enabled)) {
    assert.ok(!ch.text.includes('📍'));
    assert.ok(!/\b\d+-\d+(-\d+)?\b/.test(ch.text), 'no fight records');
    assert.ok(!/50,?000|\$/.test(ch.text), 'no prize or money claims');
  }
});

test('TIME TBA fights keep the verified date and say Time TBA', () => {
  const { campaign } = build({ fight: fight({ timeTba: true, matchTime: '' }) });
  assert.strictEqual(campaign.schedule.timeText, 'Time TBA');
  assert.ok(campaign.channels.facebook.text.includes('Saturday, November 7, 2026 · Time TBA'));
});

// ------------------------------------------------------- skipped fights --
test('missing date is skipped', () => {
  const r = build({ fight: fight({ matchDate: null, matchDateKey: '', lockAt: null }) });
  assert.ok(r.skipped);
  assert.ok(r.reasons.some((x) => /date is missing/i.test(x)));
});
test('TBA / placeholder fighters are skipped', () => {
  for (const b of ['TBA', 'Opponent TBD', 'tbd', '', 'Fighter B']) {
    const r = build({ fight: fight({ matchFighterB: b }) });
    assert.ok(r.skipped, `expected skip for "${b}"`);
  }
});
test('locked, closed, finished, draft and expired fights are skipped', () => {
  assert.ok(build({ fight: fight({ entryClosedAt: new Date(NOW - 1) }) }).skipped);
  assert.ok(build({ fight: fight({ matchStatus: 'Finished' }) }).skipped);
  assert.ok(build({ fight: fight({ matchStatus: 'Closed' }) }).skipped);
  assert.ok(build({ fight: fight({ matchStatus: 'Draft' }) }).skipped);
  assert.ok(build({ fight: fight({ lockAt: new Date(NOW - 60000) }) }).skipped);
  const past = build({ fight: fight({ matchDate: new Date('2026-10-20T00:00:00Z'), matchDateKey: '2026-10-20' }) });
  assert.ok(past.skipped && past.reasons.some((x) => /passed|no longer open/i.test(x)));
});
test('hidden auto-discovered calendar candidates are skipped until promoted', () => {
  assert.ok(build({ fight: fight({ autoDiscovered: true }) }).skipped);
  assert.ok(!build({ fight: fight({ autoDiscovered: true, homepagePromoted: true }) }).skipped);
});

// ------------------------------------------------------------- images --
test('missing poster: Instagram blocked, others warn, campaign needs review', () => {
  const { campaign } = build({ fight: fight({ fightPosterImage: '' }) });
  assert.strictEqual(campaign.state, 'needs_review');
  assert.ok(campaign.channels.instagram.blocking.some((x) => /needs an image/.test(x)));
  assert.ok(campaign.channels.facebook.warnings.length);
  assert.strictEqual(campaign.poster, null);
});
test('crop rules: in-range poster has no warnings; tall poster blocks Instagram and warns X/Facebook', () => {
  assert.strictEqual(core.cropCheck('instagram', 1080, 1350), null);
  assert.strictEqual(core.cropCheck('instagram', 1080, 1080), null);
  assert.strictEqual(core.cropCheck('affiliate_email', 500, 2000), null);
  const tall = approvedPoster({ width: 1080, height: 1920 });
  const { campaign } = build({ affiliate: affiliate(), affiliatePosters: [tall] });
  assert.ok(campaign.channels.instagram.blocking.some((x) => /4:5/.test(x)));
  assert.ok(campaign.channels.x.warnings.some((x) => /cropped preview/.test(x)));
  assert.ok(campaign.channels.facebook.warnings.some((x) => /trim/.test(x)));
  assert.deepStrictEqual(campaign.channels.affiliate_email.blocking, []);
  assert.strictEqual(campaign.channels.instagram.image.width, 1080);
});
test('posters outside the FANTASY MMADNESS image library are never used', () => {
  const { campaign } = build({ fight: fight({ fightPosterImage: 'http://evil.example.com/x.png' }) });
  assert.strictEqual(campaign.poster, null);
});

// ---------------------------------------------------------- affiliates --
test('affiliate campaign uses the approved QR poster and the exact QR link', () => {
  const { campaign } = build({ affiliate: affiliate(), affiliatePosters: [approvedPoster()] });
  const expected = affiliateLeagueFightLink(AFF_ID, FIGHT_ID);
  assert.strictEqual(campaign.poster.kind, 'affiliate_qr_poster');
  for (const ch of Object.values(campaign.channels)) {
    assert.strictEqual(ch.enabled, true);
    assert.strictEqual(ch.link, expected, 'post link must equal poster QR destination');
    assert.deepStrictEqual(ch.blocking, []);
  }
  assert.ok(campaign.channels.instagram.text.includes('may earn'));
  assert.ok(campaign.channels.x.text.includes('Affiliate link'));
  assert.match(campaign.channels.affiliate_email.subject, /Pereira vs Magomed Ankalaev/);
  assert.strictEqual(campaign.state, 'draft');
});
test('paid-fight QR poster: links switch to the paid fight link credited to the affiliate', () => {
  const paid = approvedPoster({ qrTarget: 'paid', qrLink: affiliatePaidFightLink(AFF_ID, FIGHT_ID) });
  const { campaign } = build({ affiliate: affiliate(), affiliatePosters: [paid] });
  assert.strictEqual(campaign.channels.facebook.link, affiliatePaidFightLink(AFF_ID, FIGHT_ID));
  assert.deepStrictEqual(campaign.channels.facebook.blocking, []);
});
test('affiliate isolation: another affiliate\'s poster is never used', () => {
  const { campaign } = build({ affiliate: affiliate(), affiliatePosters: [approvedPoster({ affiliateId: OTHER_AFF })] });
  assert.strictEqual(campaign.poster.kind, 'fight_poster');
  assert.ok(campaign.channels.facebook.warnings.some((w) => /personal QR poster/.test(w)));
  assert.strictEqual(campaign.state, 'needs_review');
});
test('affiliate isolation: an affiliate-created league fight cannot be promoted by others', () => {
  const owned = fight({ matchBy: 'affiliate', affiliateId: OTHER_AFF });
  assert.ok(build({ fight: owned }).skipped, 'owner cannot promote it');
  assert.ok(build({ fight: owned, affiliate: affiliate() }).skipped, 'other affiliate cannot promote it');
  assert.ok(!build({ fight: owned, affiliate: affiliate({ _id: OTHER_AFF }) }).skipped, 'its own affiliate can');
});
test('QR destination mismatch blocks the campaign', () => {
  const wrong = approvedPoster({ qrLink: affiliateLeagueFightLink(AFF_ID, '6a1b2c3d4e5f6a7b8c9d0eff') });
  const { campaign } = build({ affiliate: affiliate(), affiliatePosters: [wrong] });
  assert.ok(campaign.channels.instagram.blocking.some((x) => /QR code opens a different page/.test(x)));
});
test('suspended affiliates are skipped', () => {
  assert.ok(build({ affiliate: affiliate({ promoterSuspendedAt: new Date() }) }).skipped);
});

// ----------------------------------------------------------------- URLs --
test('bad URLs are rejected', () => {
  const ok = { fightId: FIGHT_ID };
  assert.ok(core.validateCampaignUrl('not a url', ok));
  assert.ok(core.validateCampaignUrl(`http://www.fantasymmadness.com/fight/${FIGHT_ID}?utm_source=fan_acquisition`, ok));
  assert.ok(core.validateCampaignUrl(`https://fantasymmadness.com.evil.io/fight/${FIGHT_ID}?utm_source=fan_acquisition`, ok));
  assert.ok(core.validateCampaignUrl(`https://user:pw@www.fantasymmadness.com/fight/${FIGHT_ID}?utm_source=fan_acquisition`, ok));
  assert.ok(core.validateCampaignUrl('https://www.fantasymmadness.com/fight/6a1b2c3d4e5f6a7b8c9d0eff?utm_source=fan_acquisition', ok), 'wrong fight');
  assert.ok(core.validateCampaignUrl(`https://www.fantasymmadness.com/fight/${FIGHT_ID}`, ok), 'owner link without tag');
  assert.ok(core.validateCampaignUrl(affiliateLeagueFightLink(OTHER_AFF, FIGHT_ID), { fightId: FIGHT_ID, affiliateId: AFF_ID }), 'credits wrong affiliate');
  assert.ok(core.validateCampaignUrl(`${affiliateLeagueFightLink(AFF_ID, FIGHT_ID)}&utm_source=x`, { fightId: FIGHT_ID, affiliateId: AFF_ID }), 'breaks QR parity');
  assert.strictEqual(core.validateCampaignUrl(affiliateLeagueFightLink(AFF_ID, FIGHT_ID), { fightId: FIGHT_ID, affiliateId: AFF_ID }), '');
});

// ------------------------------------------------------------- escaping --
test('names with HTML and control characters are cleaned and escaped', () => {
  const nasty = fight({ matchFighterA: 'Jon <script>alert(1)</script> Jones', matchFighterB: 'Tom\r\nBcc: x@y.z Aspinall', matchName: 'UFC "Night" & <b>Fights</b>' });
  const { campaign } = build({ fight: nasty, affiliate: affiliate(), affiliatePosters: [approvedPoster()] });
  const email = campaign.channels.affiliate_email;
  assert.ok(!email.html.includes('<script>'));
  assert.ok(email.html.includes('&lt;script&gt;'));
  assert.ok(!/[\r\n]/.test(email.subject), 'no header injection in subject');
  assert.ok(!campaign.fighterB.includes('\n'));
  assert.ok(email.html.includes('&amp;'));
});

// ------------------------------------------------------------- X length --
test('X post stays within 280 weighted characters even with long names', () => {
  const long = fight({ matchFighterA: 'Alexandre Pantoja de Oliveira Santos Junior', matchFighterB: 'Kai Kara-France Wellington Auckland', matchName: 'UFC Fight Night: Very Long Event Name Presented By A Sponsor' });
  const { campaign } = build({ fight: long });
  assert.ok(core.xLength(campaign.channels.x.text) <= 280);
  assert.deepStrictEqual(campaign.channels.x.blocking, []);
});

// ------------------------------------------------------------ duplicates --
test('same fight + same facts produce the same dedupe key; a changed fight does not', () => {
  const a = build().campaign; const b = build().campaign;
  assert.strictEqual(a.dedupeKey, b.dedupeKey);
  const c = build({ fight: fight({ matchTime: '21:00' }) }).campaign;
  assert.notStrictEqual(a.dedupeKey, c.dedupeKey);
  const d = build({ affiliate: affiliate(), affiliatePosters: [approvedPoster()] }).campaign;
  assert.notStrictEqual(a.dedupeKey, d.dedupeKey, 'owner and affiliate drafts are separate');
});

// --------------------------------------------------------------- states --
test('explicit states; queued/published/failed cannot be reached in Phase 1', () => {
  assert.deepStrictEqual(core.STATES, ['draft', 'needs_review', 'approved', 'queued', 'published', 'failed']);
  const c = build().campaign;
  for (const to of ['queued', 'published', 'failed']) assert.match(core.transition(c, { to, now: NOW }).error, /Publishing is not enabled/);
});
test('approval requires every human check on every channel', () => {
  const c = build().campaign;
  const refused = core.transition(c, { to: 'approved', current: build(), now: NOW });
  assert.ok(refused.error && refused.problems.length === 12);
  const checked = passAll(c);
  const ok = core.transition(checked, { to: 'approved', current: build(), reviewer: 'owner', now: NOW });
  assert.ok(!ok.error, JSON.stringify(ok));
  assert.strictEqual(ok.campaign.state, 'approved');
  assert.strictEqual(ok.campaign.approvedBy, 'owner');
});
test('a failed check records the reason and keeps the campaign in review', () => {
  const r = core.applyReviewCheck(build().campaign, { channel: 'instagram', check: 'image_fit', result: 'fail', note: 'Poster cropped', now: NOW });
  assert.strictEqual(r.campaign.state, 'needs_review');
  assert.ok(r.campaign.validation.reviewFailures[0].includes('Instagram'));
  assert.strictEqual(r.campaign.channels.instagram.checks.image_fit.note, 'Poster cropped');
});
test('approval is refused when the fight changed or locked since the draft', () => {
  const checked = passAll(build().campaign);
  assert.match(core.transition(checked, { to: 'approved', current: build({ fight: fight({ matchTime: '20:00' }) }), now: NOW }).problems.join(' '), /changed/);
  assert.match(core.transition(checked, { to: 'approved', current: build({ fight: fight({ entryClosedAt: new Date() }) }), now: NOW }).problems.join(' '), /no longer open/);
});
test('rejection: reason required, recorded, and a rejected draft can never be approved', () => {
  const c = passAll(build().campaign);
  assert.ok(core.reject(c, { reason: '' }).error);
  const r = core.reject(c, { reason: 'Wrong tone for this event', reviewer: 'owner', now: NOW }).campaign;
  assert.strictEqual(r.state, 'needs_review');
  assert.strictEqual(r.rejected, true);
  assert.strictEqual(r.rejectionReason, 'Wrong tone for this event');
  assert.strictEqual(r.history.at(-1).action, 'rejected');
  assert.match(core.transition(r, { to: 'approved', current: build(), now: NOW }).problems.join(' '), /rejected/);
  assert.ok(core.transition(r, { to: 'draft', now: NOW }).error);
  const approved = core.transition(c, { to: 'approved', current: build(), now: NOW }).campaign;
  const rejectedAfter = core.reject(approved, { reason: 'Changed my mind', now: NOW }).campaign;
  assert.strictEqual(rejectedAfter.approvedAt, null, 'rejecting an approved draft removes the approval');
});
test('blocked campaigns cannot be approved even with all checks passed', () => {
  const blocked = passAll(build({ fight: fight({ fightPosterImage: '' }) }).campaign);
  assert.ok(core.transition(blocked, { to: 'approved', current: build({ fight: fight({ fightPosterImage: '' }) }), now: NOW }).error);
});

// ------------------------------------------------- route layer (mocked) --
const routeTest = async () => {
  const writes = []; const outbound = [];
  const routes = {};
  const app = { locals: {}, get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); }, patch() {}, put() {}, delete() {} };
  const docs = new Map();
  const collection = (name) => ({
    createIndex: async () => writes.push({ name, op: 'createIndex' }),
    find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => (name === 'fan_acquisition_fight_campaigns' ? [...docs.values()] : []) }) }), limit: () => ({ toArray: async () => [] }) }),
    findOne: async (q) => [...docs.values()].find((d) => (q.dedupeKey ? d.dedupeKey === q.dedupeKey : String(d._id) === String(q._id))) || null,
    updateOne: async (filter, update, opts) => {
      writes.push({ name, op: 'updateOne' });
      if (name !== 'fan_acquisition_fight_campaigns') return { matchedCount: 0 };
      if (opts?.upsert) {
        if (docs.has(filter.dedupeKey)) return { upsertedCount: 0, matchedCount: 1 };
        docs.set(filter.dedupeKey, { _id: `id${docs.size}`, ...update.$setOnInsert }); return { upsertedCount: 1 };
      }
      return { matchedCount: 1 };
    },
    updateMany: async () => { writes.push({ name, op: 'updateMany' }); return { modifiedCount: 0 }; },
  });
  const chain = (rows) => ({ sort: () => ({ limit: () => ({ lean: () => ({ then: (f) => Promise.resolve(rows).then(f) }) }) }) });
  const readOnlyModel = (rows) => ({ find: () => chain(rows), findById: () => ({ select: () => ({ lean: async () => null }) }), updateOne: () => { throw new Error('registry write'); }, create: () => { throw new Error('registry write'); } });
  const soonKey = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const soon = { matchDateKey: soonKey, matchDate: new Date(`${soonKey}T00:00:00Z`) };
  const mongoose = {
    connection: { db: { collection } },
    Types: { ObjectId: function ObjectId(id) { return id; } },
    models: { Match: readOnlyModel([fight(soon), fight({ ...soon, _id: '6a1b2c3d4e5f6a7b8c9d0e20', matchFighterB: 'TBA' })]), Shadow: readOnlyModel([]), ProWrestlingMatch: readOnlyModel([]), Affiliate: readOnlyModel([]) },
  };
  const origFetch = global.fetch; global.fetch = (...a) => { outbound.push(a); throw new Error('no network in Phase 1'); };
  try {
    const registered = require('./fan-acquisition-fight-routes')({ app, mongoose, verifyAdminToken: () => {}, getLatestResearch: async () => ({ createdAt: new Date(), agents: [{ id: 'mma', status: 'research_ready', opportunities: [{ title: 'Pereira vs Ankalaev confirmed for UFC 999', url: 'https://news.example.com/a' }] }] }) });
    const first = await registered.generate({ now: new Date() });
    const again = await registered.generate({ now: new Date() });
    assert.strictEqual(first.created.length, 1);
    assert.strictEqual(first.skipped.length, 1, 'TBA fight skipped');
    assert.strictEqual(again.created.length, 0);
    assert.strictEqual(again.duplicates.length, 1, 'no duplicate campaign on rerun');
    const saved = [...docs.values()][0];
    assert.strictEqual(saved.research.matchingNews.length, 1, 'research leads linked to the real fight');
    assert.ok(writes.every((w) => w.name === 'fan_acquisition_fight_campaigns'), `unexpected write: ${JSON.stringify(writes)}`);
    assert.strictEqual(outbound.length, 0, 'no outbound requests');
    let status = 0; let body = null;
    const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; }, set() { return this; } };
    await routes['POST /api/admin/fan-acquisition/fight-campaigns/:id/status']({ params: { id: '6a1b2c3d4e5f6a7b8c9d0e1f' }, body: { status: 'published' }, admin: {} }, res);
    assert.strictEqual(status, 403); assert.strictEqual(body.publishingEnabled, false);
  } finally { global.fetch = origFetch; }
  passed += 1; console.log('ok - route layer writes only the growth-engine collection, dedupes reruns, refuses publishing, sends nothing');
};

// Preview deployments can inherit the production database connection. Even a
// manual Generate click or scheduled cron must fail before creating indexes.
test('Vercel preview refuses all campaign generation before any database write', async () => {
  const previous = process.env.VERCEL_ENV;
  const writes = [];
  const mongoose = {
    connection: { db: { collection: (name) => ({
      createIndex: async () => { writes.push('index:' + name); },
      updateOne: async () => { writes.push('update:' + name); },
      updateMany: async () => { writes.push('updateMany:' + name); },
    }) } },
    models: {},
  };
  const app = { locals: {}, get() {}, post() {} };
  const routes = require('./fan-acquisition-fight-routes');
  try {
    process.env.VERCEL_ENV = 'preview';
    const engine = routes({ app, mongoose, verifyAdminToken: () => {} });
    const manual = await engine.generate();
    const cron = await engine.generateForCron();
    assert.strictEqual(manual.status, 503);
    assert.strictEqual(cron.status, 503);
    assert.strictEqual(manual.isolationRequired, true);
    assert.deepStrictEqual(writes, [], 'preview must not create indexes or write drafts');
  } finally {
    if (previous === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previous;
  }
});

// ------------------------------------- guardrail: no out-of-scope code --
test('new growth-engine files never touch payments, email delivery, social APIs or fight writes', () => {
  for (const file of ['fan-acquisition-fight-campaigns.js', 'fan-acquisition-fight-routes.js']) {
    const src = fs.readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '');
    for (const banned of [/stripe/i, /authorize\.?net/i, /coinWallet/, /sendTransactionalMail|nodemailer|sendMail/, /graph\.facebook|api\.x\.com|instagram_content_publish/, /\.save\(/, /insertMany|deleteOne|deleteMany|findOneAndUpdate/, /Match\.(update|create|collection)/, /\baxios\b|\bfetch\(/]) {
      assert.ok(!banned.test(src), `${file} must not contain ${banned}`);
    }
  }
  const routes = fs.readFileSync('fan-acquisition-fight-routes.js', 'utf8');
  const targets = [...routes.matchAll(/(\w+)\(\)\.(updateOne|updateMany|createIndex)\(/g)].map((m) => m[1]);
  assert.ok(targets.length && targets.every((t) => t === 'store'), `writes must target the campaign store only: ${targets}`);
});


// ------------------------------------------- cron load and record growth --
const loadTest = async () => {
  const LATENCY = 15; // ms per database call (slow shared cluster)
  const wait = () => new Promise((r) => setTimeout(r, LATENCY));
  const docs = new Map(); const indexes = []; let dbCalls = 0;
  const collection = (name) => ({
    createIndex: async (spec, opts) => { await wait(); indexes.push({ name, spec, opts }); },
    find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => { dbCalls += 1; await wait(); return []; } }) }), limit: () => ({ toArray: async () => { dbCalls += 1; await wait(); return []; } }) }),
    findOne: async (q) => { dbCalls += 1; await wait(); return [...docs.values()].find((d) => d.dedupeKey === q.dedupeKey) || null; },
    updateOne: async (filter, update) => { dbCalls += 1; await wait(); if (docs.has(filter.dedupeKey)) return { upsertedCount: 0 }; docs.set(filter.dedupeKey, { _id: 'd' + docs.size, ...update.$setOnInsert }); return { upsertedCount: 1 }; },
    updateMany: async () => { dbCalls += 1; await wait(); return {}; },
  });
  const soon = (i) => { const k = new Date(Date.now() + (2 + (i % 50)) * 86400000).toISOString().slice(0, 10); return { matchDateKey: k, matchDate: new Date(`${k}T00:00:00Z`) }; };
  const many = Array.from({ length: 450 }, (_, i) => fight({ ...soon(i), _id: (0x6a1b2c3d4e5f6a7b8c9d0000 + 0).toString(16).slice(0, 18) + i.toString(16).padStart(6, '0'), matchFighterA: `Fighter A${i}`, matchFighterB: `Fighter B${i}` }));
  const chain = (rows) => ({ sort: () => ({ limit: (n) => ({ lean: () => ({ then: (f) => wait().then(() => rows.slice(0, n)).then(f) }) }) }) });
  const model = (rows) => ({ find: () => chain(rows) });
  const mongoose = { connection: { db: { collection } }, Types: { ObjectId: function ObjectId(id) { return id; } },
    models: { Match: model(many.slice(0, 150)), Shadow: model(many.slice(150, 300)), ProWrestlingMatch: model([]), Affiliate: model([]) } };
  const app = { locals: {}, get() {}, post() {} };
  delete require.cache[require.resolve('./fan-acquisition-fight-routes')];
  const engine = require('./fan-acquisition-fight-routes')({ app, mongoose, verifyAdminToken: () => {}, getLatestResearch: async () => null });
  const t0 = Date.now();
  const day1 = await engine.generateForCron();
  const elapsed = Date.now() - t0;
  assert.strictEqual(day1.inspected, engine.limits.CRON_MAX_FIGHTS, 'cron handles at most 40 fights per run');
  assert.ok(day1.partial && day1.remaining === 300 - 40, 'reports remaining fights instead of running long');
  assert.ok(elapsed < engine.limits.CRON_BUDGET_MS + 1500, `cron step took ${elapsed}ms`);
  assert.ok([...docs.values()].every((d) => d.purgeAfter instanceof Date && d.purgeAfter > new Date()), 'every draft has a delete date');
  assert.ok(indexes.some((i) => i.spec.purgeAfter === 1 && i.opts?.expireAfterSeconds === 0), 'TTL index created');
  const afterDay1 = docs.size;
  const day2 = await engine.generateForCron();
  assert.strictEqual(docs.size, afterDay1, 'unchanged fights create no new records on the next run');
  assert.strictEqual(day2.duplicates.length, 40);
  console.log(`ok - cron load: 300 eligible fights, slow DB (${LATENCY}ms/call): ${day1.inspected} handled in ${elapsed}ms, ${day1.created.length} drafts, rerun added 0 records`);
  passed += 1;
};

routeTest().then(loadTest).then(() => console.log(`\n${passed} fan-acquisition fight campaign tests passed`)).catch((e) => { console.error(e); process.exit(1); });
