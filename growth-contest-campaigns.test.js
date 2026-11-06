'use strict';
// Fight-marketing campaigns: verification rules, event-specific copy, final safeguard.
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyContest, fetchVerifiedContests, buildCampaign, checkCampaign, norm, sourceBase } = require('./growth-contest-campaigns');

const NOW = new Date('2026-11-01T18:00:00Z');
const day = (n) => new Date(NOW.getTime() + n * 86400000).toISOString().slice(0, 10);
const fight = (o = {}) => ({ __feed: 'prediction', _id: 'abc123def456', matchCategory: 'boxing', matchFighterA: 'Naoya Inoue', matchFighterB: 'Murodjon Akhmadaliev', matchStatus: 'Scheduled', matchDate: `${day(5)}T00:00:00Z`, matchDateKey: day(5), ...o });
const media = new Set(['mannix and mora', 'budocast'].map(norm));

test('a published, open, upcoming contest with real fighters is verified', () => {
  const v = verifyContest(fight({ venue: 'Ariake Arena', eventCity: 'Tokyo', maxRounds: 12, weightClass: 'Super Bantamweight' }), { now: NOW, mediaNames: media });
  assert.equal(v.ok, true, JSON.stringify(v.reasons));
  assert.equal(v.contest.sport, 'boxing');
  assert.equal(v.contest.contestUrl, 'https://www.fantasymmadness.com/fight/abc123def456?play=1');
});

test('podcast / media names are never treated as fights', () => {
  const a = verifyContest(fight({ matchFighterA: 'Mannix and Mora', matchFighterB: 'Budocast' }), { now: NOW, mediaNames: media });
  assert.equal(a.ok, false);
  assert.ok(a.reasons.some((r) => /looks_like_media/.test(r)));
  const b = verifyContest(fight({ matchFighterA: 'MMA Fighting Podcast show 1' }), { now: NOW });
  assert.equal(b.ok, false);
});

test('every unverifiable contest is rejected with a reason', () => {
  const cases = {
    past: fight({ matchDateKey: day(-1), matchDate: `${day(-1)}T00:00:00Z` }),
    far: fight({ matchDateKey: day(40), matchDate: `${day(40)}T00:00:00Z` }),
    noDate: fight({ matchDateKey: undefined, matchDate: undefined }),
    tba: fight({ matchFighterB: 'TBA' }),
    same: fight({ matchFighterB: 'Naoya Inoue' }),
    finished: fight({ matchStatus: 'Finished' }),
    draft: fight({ matchStatus: 'Draft' }),
    closed: fight({ matchShadowOpenStatus: 'closed' }),
    locked: fight({ lockAt: new Date(NOW.getTime() - 60000).toISOString() }),
    shadow: fight({ sourceType: 'shadow' }),
    autoDiscovered: fight({ autoDiscovered: true }),
    sport: fight({ matchCategory: 'chess boxing' }),
    voided: fight({ voidedAt: NOW.toISOString() }),
  };
  for (const [name, item] of Object.entries(cases)) assert.equal(verifyContest(item, { now: NOW }).ok, false, name);
});

test('published LIVE contest ignores legacy shadow closed field but still blocks actual closures', () => {
  const live = fight({ matchType: 'LIVE', sourceType: 'match', matchShadowOpenStatus: 'closed' });
  assert.equal(verifyContest(live, { now: NOW }).ok, true);
  const shadow = fight({ matchType: 'shadow', sourceType: 'shadow', matchShadowOpenStatus: 'closed' });
  assert.equal(verifyContest(shadow, { now: NOW }).ok, false);
  const nonLiveClosed = fight({ matchType: 'scheduled', sourceType: 'match', matchShadowOpenStatus: 'closed' });
  assert.equal(verifyContest(nonLiveClosed, { now: NOW }).ok, false);
  for (const closed of [
    { matchStatus: 'Finished' }, { matchStatus: 'Closed' },
    { entryClosedAt: NOW.toISOString() },
    { lockAt: new Date(NOW.getTime() - 1000).toISOString() },
  ]) {
    const result = verifyContest({ ...live, ...closed }, { now: NOW });
    assert.equal(result.ok, false, JSON.stringify(closed));
  }
});

test('all five sports map, including pro wrestling from its own feed', () => {
  assert.equal(verifyContest(fight({ matchCategory: 'MMA' }), { now: NOW }).contest.sport, 'mma-ufc');
  assert.equal(verifyContest(fight({ matchCategory: 'mma', matchCategoryTwo: 'Bare Knuckle' }), { now: NOW }).contest.sport, 'bare-knuckle');
  assert.equal(verifyContest(fight({ matchCategory: 'Kickboxing' }), { now: NOW }).contest.sport, 'kickboxing');
  const w = verifyContest({ __feed: 'pro-wrestling', id: 'wrest000111', status: 'OPEN', publicVisible: true, eventName: 'Saturday Night Clash', promotionName: 'AEW', competitorA: { displayName: 'Kenny Omega' }, competitorB: { displayName: 'Will Ospreay' }, matchDate: `${day(3)}T01:00:00Z` }, { now: NOW });
  assert.equal(w.ok, true, JSON.stringify(w.reasons)); assert.equal(w.contest.sport, 'pro-wrestling');
  assert.match(w.contest.contestUrl, /\/pro-wrestling\/play\/wrest000111$/);
  assert.equal(verifyContest({ __feed: 'pro-wrestling', id: 'wrest000222', status: 'LOCKED', competitorA: { displayName: 'A Wrestler' }, competitorB: { displayName: 'B Wrestler' }, matchDate: `${day(3)}T01:00:00Z` }, { now: NOW }).ok, false);
});

test('campaign copy is event-specific, factual, and passes the safeguard', () => {
  const c = verifyContest(fight({ venue: 'Ariake Arena', eventCity: 'Tokyo', maxRounds: 12, matchTime: '19:00', eventTimeZone: 'Asia/Tokyo',eventStartAt:day(5)+'T10:00:00Z',eventTimeVerified:true,eventTimeSourceUrl:'https://official.example/event' }), { now: NOW }).contest;
  const k = buildCampaign(c);
  for (const t of Object.values(k.posts)) { assert.match(t, /Naoya Inoue vs Murodjon Akhmadaliev/); assert.match(t, /round/i); assert.doesNotMatch(t, /prize|\$|podcast|title fight|main event/i); }
  assert.match(k.posts.instagram, /Ariake Arena, Tokyo/); assert.match(k.posts.instagram, /12 rounds/); assert.match(k.posts.instagram, /7:00 PM GMT\+9|7:00 PM JST/);
  assert.match(k.posts.x, /#Boxing #FANTASYMMADNESS/);
  const draft = { kind: 'marketing', genre: 'boxing', contestId: c.id, ...k,text: k.text, posts: k.posts };
  assert.deepEqual(checkCampaign(draft, c, { now: NOW, mediaNames: media }), []);
  // No venue/time given -> none invented
  const bare = buildCampaign(verifyContest(fight(), { now: NOW }).contest);
  assert.doesNotMatch(bare.posts.instagram, /📍|rounds|AM|PM/);
});

test('safeguard blocks wrong, invented or media-based campaigns', () => {
  const c = verifyContest(fight(), { now: NOW }).contest;
  const ok = buildCampaign(c);
  const base = { kind: 'marketing', genre: 'boxing', contestId: c.id, ...ok,text: ok.text, posts: ok.posts };
  const bad = (patch) => checkCampaign({ ...base, ...patch }, c, { now: NOW, mediaNames: media });
  assert.ok(bad({ text: 'Mannix and Mora: fight-week prediction challenge — make your picks' }).length);
  assert.ok(bad({ text: ok.text + ' Win a $500 prize!' }).some((r) => /money/.test(r)));
  assert.ok(bad({ text: ok.text + ' Huge title fight!' }).some((r) => /title/.test(r)));
  assert.ok(bad({ genre: 'mma-ufc' }).some((r) => /sport/.test(r)));
  assert.ok(bad({ contestId: 'other' }).some((r) => /contest_id/.test(r)));
  assert.deepEqual(checkCampaign(base, null), ['no_verified_contest']);
});

test('feed fetch: unreachable feeds are reported, nothing is invented', async () => {
  const down = await fetchVerifiedContests({ fetchImpl: async () => ({ ok: false, status: 503 }), now: NOW });
  assert.equal(down.contests.length, 0); assert.equal(down.sourceReachable, false); assert.equal(down.errors.length, 2);
  const up = await fetchVerifiedContests({ now: NOW, fetchImpl: async (u) => ({ ok: true, json: async () => (u.includes('pro-wrestling') ? { items: [] } : { items: [fight(), fight({ _id: 'zzz999yyy888', matchFighterA: 'Budocast', matchFighterB: 'Someone Real' })] }) }), mediaNames: media });
  assert.equal(up.contests.length, 1); assert.equal(up.rejected.length, 1);
});

test('contest source must be the FANTASY MMADNESS backend', () => {
  assert.equal(sourceBase({}), 'https://fantasymmadness-game-server-three-taupe.vercel.app');
  assert.throws(() => sourceBase({ GROWTH_CONTEST_SOURCE_URL: 'https://evil.example' }));
  assert.throws(() => sourceBase({ GROWTH_CONTEST_SOURCE_URL: 'http://fantasymmadness.com' }));
});

test('the reported bug: show names like "Mannix and Mora" / "Budocast" are rejected even when not yet known as prospects', () => {
  const v = verifyContest(fight({ matchFighterA: 'Mannix and Mora', matchFighterB: 'Budocast' }), { now: NOW });
  assert.equal(v.ok, false);
  assert.ok(v.reasons.includes('fighter_a_names_two_people_or_a_show'));
  assert.ok(v.reasons.includes('fighter_b_looks_like_media_not_a_fighter'));
  assert.equal(verifyContest(fight({ matchFighterA: 'Jake Paul' }), { now: NOW }).ok, true);
});


test('registry closure, cancellation and duplicate records cannot create campaigns', async () => {
  for (const flags of [{entryOpen:false},{cancelled:true},{canceledAt:NOW.toISOString()}]) {
    assert.equal(verifyContest(fight(flags), {now:NOW}).ok, false);
  }
  const result=await fetchVerifiedContests({now:NOW,fetchImpl:async u=>({ok:true,json:async()=>({items:u.includes('pro-wrestling')?[]:[fight(),fight({_id:'other000001'})]})})});
  assert.equal(result.contests.length,1);
  assert.ok(result.rejected.some(r=>r.reasons.includes('duplicate_registry_fight')));
  assert.equal(result.complete,true);
});

test('public contest entry availability is independent of a viewer prediction flag', () => {
  const v = verifyContest(fight({ matchType: 'LIVE', matchShadowOpenStatus: 'closed', entryOpen: true, canSubmitPrediction: false }), {now:NOW});
  assert.equal(v.ok, true, JSON.stringify(v.reasons));
  assert.equal(verifyContest(fight({matchDateKey:day(0),matchDate:day(0),matchTime:'01:00',eventTimeZone:'America/New_York'}),{now:NOW}).ok,false);
});

test('partial and malformed feeds are reported without claiming a complete registry check', async () => {
  const result=await fetchVerifiedContests({now:NOW,fetchImpl:async u=>({ok:true,json:async()=>u.includes('pro-wrestling')?{unexpected:[]}:{items:[fight()]}})});
  assert.equal(result.contests.length,1);
  assert.equal(result.sourceReachable,true);
  assert.equal(result.complete,false);
  assert.match(result.errors[0],/invalid listing/);
});

test('a campaign version changes when registry promoter, entry terms, venue or timezone changes', () => {
  const original=verifyContest(fight(),{now:NOW}).contest;
  for (const patch of [{promoterName:'Verified Promoter'},{entryFeeTokens:50},{venue:'Registry Arena'},{eventTimeZone:'Europe/London'}]) {
    const updated=verifyContest(fight(patch),{now:NOW}).contest;
    assert.notEqual(updated.fingerprint,original.fingerprint);
  }
});
