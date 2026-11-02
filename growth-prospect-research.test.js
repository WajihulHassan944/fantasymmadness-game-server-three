'use strict';
// PR + affiliate research and personalized drafting. No network: growth-podcast-research.fixture.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProspectResearch, extractContact, contactProblems } = require('./growth-prospect-research');
const { compose, assignTrack } = require('./growth-outreach-composer');
const { researchWeb } = require('./growth-podcast-research.fixture');
const { MONEY_WORDS } = require('./growth-contest-campaigns');

const NOW = new Date();
const day = (d) => new Date(NOW.getTime() + d * 86400000).toISOString().slice(0, 10);
const contests = [
  { id: 'bx0000000001', sport: 'boxing', fighterA: 'Naoya Inoue', fighterB: 'Murodjon Akhmadaliev', dateKey: day(4), eventName: null },
  { id: 'mm0000000001', sport: 'mma-ufc', fighterA: 'Merab Dvalishvili', fighterB: 'Petr Yan', dateKey: day(6), eventName: 'UFC 323' },
];
async function setup() {
  const web = researchWeb();
  const fetchImpl = async (url, opts) => (await web(url, opts)) || { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  const search = await (await fetchImpl('https://itunes.apple.com/search?term=boxing+podcast')).json();
  const mma = await (await fetchImpl('https://itunes.apple.com/search?term=MMA+UFC+podcast')).json();
  const p = (r, genre, focus = 'fans') => ({ id: `p-${r.collectionId}`, name: r.collectionName, genre, focus, sourceUrl: r.collectionViewUrl });
  return { fetchImpl, boxing: search.results.map((r) => p(r, 'boxing')), mma: mma.results.map((r) => p(r, 'mma-ufc', 'partners')) };
}

test('research reads the show’s own feed: recent episodes, fight evidence, published business contact (MX checked)', async () => {
  const { fetchImpl, boxing } = await setup();
  const r = await createProspectResearch({ fetchImpl }).research(boxing[0], { contests, now: NOW });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.show.title, 'boxing podcast show 1');
  assert.equal(r.active, true);
  assert.match(r.recentEpisodes[0].title, /Inoue preview/);
  assert.ok(r.evidence.some((e) => e.kind === 'fight' && e.contestId === 'bx0000000001'), JSON.stringify(r.evidence));
  assert.equal(r.contact.email, 'bookings@boxing-podcast-1.example');
  assert.equal(r.contact.field, 'itunes:owner / itunes:email');
  assert.equal(r.contact.mailDomainChecked, true);
  assert.match(r.contact.basis, /published by the show in its public podcast feed/);
  assert.ok(r.score >= 60, `score ${r.score}`);
});

test('no guessed contacts: hosting-platform, no-reply, missing, opted-out and undeliverable addresses are refused', async () => {
  const { fetchImpl, boxing } = await setup();
  const rs = createProspectResearch({ fetchImpl });
  const r2 = await rs.research(boxing[1], { contests, now: NOW });
  assert.equal(r2.contact, null); assert.match(r2.contactProblems.join(), /hosting platform \(anchor\.fm\)/);
  const r3 = await rs.research(boxing[2], { contests, now: NOW });
  assert.equal(r3.contact, null); assert.match(r3.contactProblems.join(), /publishes no business email/);
  const opted = await createProspectResearch({ fetchImpl, isSuppressed: async (a) => a.startsWith('bookings@') }).research(boxing[0], { contests, now: NOW });
  assert.equal(opted.contact, null); assert.match(opted.contactProblems.join(), /opted out/);
  const noMx = await createProspectResearch({ fetchImpl: async (url, o) => (/cloudflare-dns/.test(url) ? { ok: true, status: 200, json: async () => ({ Status: 3 }) } : fetchImpl(url, o)) }).research(boxing[0], { contests, now: NOW });
  assert.equal(noMx.contact, null); assert.match(noMx.contactProblems.join(), /does not accept mail/);
  assert.deepEqual(contactProblems('noreply@show.example'), ['address is a no-reply/unmonitored mailbox']);
  assert.equal(extractContact({ managingEditor: 'editor@show.example (Pat Lee)' }).email, 'editor@show.example');
});

test('department by what the show is: news/interview -> PR, fan/picks -> affiliate (never both)', async () => {
  const { fetchImpl, boxing, mma } = await setup();
  const rs = createProspectResearch({ fetchImpl });
  assert.equal(assignTrack({ focuses: ['fans', 'partners'], research: await rs.research(boxing[0], { contests, now: NOW }) }), 'affiliate');
  assert.equal(assignTrack({ focuses: ['fans', 'partners'], research: await rs.research(mma[0], { contests, now: NOW }) }), 'pr');
});

test('personalized PR pitch and affiliate proposal: show, episode, fight evidence, letterhead; no money or invented terms', async () => {
  const { fetchImpl, boxing, mma } = await setup();
  const rs = createProspectResearch({ fetchImpl });
  const rb = await rs.research(boxing[0], { contests, now: NOW });
  const aff = compose({ prospect: boxing[0], research: rb, contests, track: 'affiliate' });
  assert.equal(aff.ok, true, aff.reason);
  assert.match(aff.subject, /boxing podcast show 1 fan league for Naoya Inoue vs Murodjon Akhmadaliev/);
  assert.match(aff.text, /^Hi Dana,/); assert.match(aff.text, /Inoue preview and boxing picks/); assert.match(aff.text, /Mentioned Naoya Inoue/);
  assert.match(aff.text, /affiliate-create-account\?utm_source=fan_acquisition&utm_medium=partner_outreach&utm_campaign=combat_fans_aff_/);
  assert.match(aff.html, /fantasy-mmadness-main-logo/); assert.match(aff.html, /contact@fantasymmadnesscom\.com/);
  assert.equal(aff.angle.kind, 'fight_mentioned'); assert.equal(aff.angle.contestId, 'bx0000000001');
  for (const m of [aff]) { assert.ok(!MONEY_WORDS.test(m.text.replace(/nothing to pay/gi, ''))); assert.ok(!/\d+\s*%|commission of|\$\d/.test(m.text)); }
  const rm = await rs.research(mma[0], { contests, now: NOW });
  const pr = compose({ prospect: mma[0], research: rm, contests, track: 'pr' });
  assert.equal(pr.ok, true, pr.reason);
  assert.match(pr.subject, /round-by-round angle on Merab Dvalishvili vs Petr Yan/);
  assert.match(pr.text, /Story ideas for MMA UFC podcast show 1/);
  assert.notEqual(pr.text, aff.text);
  // different shows never get the same email
  const other = compose({ prospect: { ...boxing[0], id: 'p-x', name: 'Other' }, research: { ...rb, show: { ...rb.show, title: 'Another Boxing Show' }, recentEpisodes: [{ title: 'Canelo talk', date: rb.recentEpisodes[0].date }] }, contests, track: 'affiliate' });
  assert.notEqual(other.text, aff.text);
});

test('no draft without a verified contact or without an evidence-based angle', async () => {
  const { fetchImpl, boxing } = await setup();
  const rs = createProspectResearch({ fetchImpl });
  assert.equal(compose({ prospect: boxing[2], research: await rs.research(boxing[2], { contests, now: NOW }), contests, track: 'affiliate' }).reason, 'no_verified_contact_route');
  const r = await rs.research(boxing[0], { contests, now: NOW });
  assert.equal(compose({ prospect: boxing[0], research: { ...r, evidence: [] }, contests, track: 'affiliate' }).reason, 'no_evidence_based_angle');
  assert.equal(compose({ prospect: boxing[0], research: { ok: false }, contests, track: 'pr' }).reason, 'research_failed');
});
