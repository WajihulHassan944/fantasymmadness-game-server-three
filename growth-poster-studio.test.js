'use strict';
// Posters: rights rules, approved fighter-photo selection with provenance, unaltered images,
// accurate facts, agreed layout, and a QR code DECODED from the final image (jsQR).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const sharp = require('sharp');
const P = require('./growth-poster-studio');
const { contestPhotoCandidates, createArtworkLibrary } = require('./growth-fighter-artwork');

const CLOUD = 'https://res.cloudinary.com/daflot6fo/image/upload/v1';
const contest = (o = {}) => ({ id: 'bx0000000001', sport: 'boxing', fighterA: 'Naoya Inoue', fighterB: 'Murodjon Akhmadaliev', dateKey: '2026-11-08', timeTba: true, matchTime: null, timeZone: null,
  venue: 'Ariake Arena', city: 'Tokyo', weightClass: 'Super Bantamweight', maxRounds: 12, eventName: null, promotion: null,
  contestUrl: 'https://www.fantasymmadness.com/fight/bx0000000001?play=1', cleanUrl: null, posterUrl: `${CLOUD}/fights/bx1.jpg`, posterField: 'fightPosterImage', fingerprint: 'abc1234567', ...o });

// Synthetic test images only (never real fighter photos). Each has a distinctive band + corner block
// so any crop, recolour, overlay or stretch is detectable.
async function synth(w, h, base, band) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${base}"/><rect x="0" y="${h * 0.45}" width="${w}" height="${h * 0.1}" fill="${band}"/><rect x="${w - w / 5}" y="0" width="${w / 5}" height="${w / 5}" fill="#dc2626"/></svg>`;
  const buffer = await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer();
  return { buffer, width: w, height: h, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}
const imgResp = (buf) => ({ ok: true, status: 200, url: '', headers: new Headers({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => buf });
async function regionMad(poster, box, original) {
  const placed = await sharp(poster).extract({ left: box.left, top: box.top, width: box.width, height: box.height }).removeAlpha().raw().toBuffer();
  const expected = await sharp(original).resize(box.width, box.height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  let d = 0; for (let i = 0; i < placed.length; i++) d += Math.abs(placed[i] - expected[i]); return d / placed.length;
}
const overlaps = (a, b) => a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;

test('artwork rights: only FANTASY MMADNESS asset hosts', () => {
  const pol = P.artPolicy({ GROWTH_ART_CLOUDINARY_CLOUDS: 'daflot6fo,dqi6vk2vn' });
  assert.equal(P.checkArtSource(contest(), pol).ok, true);
  for (const [url, reason] of [[null, 'no_official_artwork_on_this_contest'], ['http://res.cloudinary.com/daflot6fo/image/upload/a.jpg', 'artwork_not_https'], ['https://images.example.com/inoue.jpg', 'artwork_host_not_a_fantasy_mmadness_asset_host'],
    ['https://res.cloudinary.com/someoneelse/image/upload/a.jpg', 'artwork_not_on_the_fantasy_mmadness_cloud'], ['https://fantasymmadness.com.evil.example/a.jpg', 'artwork_host_not_a_fantasy_mmadness_asset_host']]) {
    assert.equal(P.checkArtSource(contest({ posterUrl: url }), pol).reason, reason, String(url));
  }
});

test('contest photo candidates: contest uploads, linked library photos only on exact name match, wrestling competitors', () => {
  const item = { fighterAImage: `${CLOUD}/a-upload.jpg`, fighterAImageOverride: true, fighterA: { id: 'lib1', displayName: 'Naoya Inoue', primaryImage: `${CLOUD}/lib-inoue.jpg`, status: 'active' },
    fighterB: { id: 'lib2', displayName: 'Somebody Else', primaryImage: `${CLOUD}/lib-wrong.jpg`, status: 'active' }, fighterBImage: `${CLOUD}/lib-wrong.jpg` };
  const c = contestPhotoCandidates(item, 'Naoya Inoue', 'Murodjon Akhmadaliev', false);
  assert.deepEqual(c.a.map((x) => x.source), ['contest_upload', 'fmm_fighter_library']);
  assert.deepEqual(c.b, [], 'a library photo of a DIFFERENT name is never offered (and the feed copy of it is not a contest upload)');
  const inactive = contestPhotoCandidates({ fighterA: { displayName: 'Naoya Inoue', primaryImage: `${CLOUD}/x.jpg`, status: 'inactive' }, fighterAImage: `${CLOUD}/x.jpg` }, 'Naoya Inoue', 'B', false);
  assert.deepEqual(inactive.a, []);
  const w = contestPhotoCandidates({ competitorA: { displayName: 'Kenny Omega', image: `${CLOUD}/omega.jpg` }, competitorB: { displayName: 'Will Ospreay' } }, 'Kenny Omega', 'Will Ospreay', true);
  assert.equal(w.a[0].source, 'contest_upload'); assert.deepEqual(w.b, []);
});

test('poster with approved photos of both fighters: whole, unaltered, VS clear of both photos; QR decoded from the final JPEG', async () => {
  const A = await synth(700, 1000, '#1d4ed8', '#f5c518'); const B = await synth(800, 900, '#065f46', '#e5e7eb');
  const c = contest(); const qrUrl = P.qrLink(c);
  assert.equal(qrUrl, 'https://www.fantasymmadness.com/fight/bx0000000001?play=1&utm_source=fan_acquisition&utm_medium=partner_outreach&utm_campaign=combat_fans_gs_boxing&utm_content=poster_qr');
  const artwork = { mode: 'fighter_photos', fighters: [{ side: 'a', name: c.fighterA, ...A }, { side: 'b', name: c.fighterB, ...B }] };
  for (const format of ['portrait', 'story']) {
    const r = await P.renderPoster({ contest: c, format, artwork, qrUrl });
    const meta = await sharp(r.buffer).metadata();
    assert.deepEqual([meta.width, meta.height, meta.format], [P.FORMATS[format].width, P.FORMATS[format].height, 'jpeg']);
    assert.equal(r.layout.images.length, 2);
    for (const [im, src] of [[r.layout.images[0], A], [r.layout.images[1], B]]) {
      assert.ok(Math.abs(im.width / im.height - src.width / src.height) < 0.01, `${format} ${im.name}: aspect changed`);
      const mad = await regionMad(r.buffer, im, src.buffer);
      assert.ok(mad < 6, `${format} ${im.name}: photo altered (mean diff ${mad.toFixed(2)})`);
      assert.ok(!overlaps(im, { left: r.layout.vs.left, top: r.layout.vs.top, width: r.layout.vs.size, height: r.layout.vs.size }), 'VS badge covers a photo');
      assert.ok(!overlaps(im, { left: r.layout.qr.left, top: r.layout.qr.top, width: r.layout.qr.px, height: r.layout.qr.px }), 'QR covers a photo');
    }
    assert.equal(r.layout.images[0].name, 'Naoya Inoue'); assert.equal(r.layout.images[1].name, 'Murodjon Akhmadaliev');
    assert.ok(r.layout.images[0].left < r.layout.images[1].left, 'fighter A on the left, fighter B on the right');
    const dec = await P.decodeQr(r.buffer);
    assert.deepEqual(dec, { ok: true, text: qrUrl }, `${format}: QR decoded from the final image`);
  }
});

test('poster with the official contest artwork, and the text poster when there is no approved artwork', async () => {
  const art = await synth(1200, 800, '#7f1d1d', '#f5c518');
  const c = contest({ cleanUrl: 'https://www.fantasymmadness.com/fight/naoya-inoue-vs-murodjon-akhmadaliev' });
  const r = await P.renderPoster({ contest: c, format: 'portrait', artwork: { mode: 'contest_artwork', contestArt: art }, qrUrl: P.qrLink(c) });
  const im = r.layout.images[0]; assert.ok((await regionMad(r.buffer, im, art.buffer)) < 6);
  assert.equal((await P.decodeQr(r.buffer)).text, 'https://www.fantasymmadness.com/fight/naoya-inoue-vs-murodjon-akhmadaliev?utm_source=fan_acquisition&utm_medium=partner_outreach&utm_campaign=combat_fans_gs_boxing&utm_content=poster_qr');
  const t = contest({ posterUrl: null, timeTba: false, matchTime: '22:00', timeZone: 'America/Los_Angeles', eventName: 'UFC 323', sport: 'mma-ufc', fighterA: 'Superbon Singha Mawynn Banchamek', fighterB: 'Tawanchai PK Saenchai Muaythaigym' });
  const tr = await P.renderPoster({ contest: t, format: 'story', artwork: { mode: 'text' }, qrUrl: P.qrLink(t) });
  assert.equal(tr.layout.images.length, 0);
  assert.equal(tr.facts.time, '10:00 PM PST'); assert.equal(tr.facts.event, 'UFC 323');
  assert.ok((await P.decodeQr(tr.buffer)).ok);
  assert.deepEqual(P.posterFacts(contest(), 'q'), { sport: 'BOXING', fighterA: 'Naoya Inoue', fighterB: 'Murodjon Akhmadaliev', event: null, date: 'SUNDAY, NOVEMBER 8, 2026', time: null, where: 'Ariake Arena · Tokyo', detail: 'Super Bantamweight · 12 ROUNDS', qrUrl: 'q', shownUrl: 'www.fantasymmadness.com/fight/bx0000000001' });
});

test('destination check: the decoded link must open this fight on the live website', async () => {
  const c = contest({ cleanUrl: 'https://www.fantasymmadness.com/fight/naoya-inoue-vs-murodjon-akhmadaliev' });
  const ok = await P.verifyDestination(async (u) => ({ ok: true, status: 200, url: u }), P.qrLink(c), c);
  assert.equal(ok.ok, true); assert.equal(ok.finalUrl, 'https://www.fantasymmadness.com/fight/naoya-inoue-vs-murodjon-akhmadaliev');
  assert.equal((await P.verifyDestination(async (u) => ({ ok: true, status: 200, url: 'https://www.fantasymmadness.com/fight/bx0000000001' }), P.qrLink(c), c)).ok, true, 'site may redirect to the ID address of the same fight');
  assert.equal((await P.verifyDestination(async () => ({ ok: true, status: 200, url: 'https://www.fantasymmadness.com/' }), P.qrLink(c), c)).reason, 'destination_is_a_different_page');
  assert.equal((await P.verifyDestination(async () => ({ ok: false, status: 404 }), P.qrLink(c), c)).reason, 'destination_http_404');
  assert.match((await P.verifyDestination(async () => { throw Error('offline'); }, P.qrLink(c), c)).reason, /^destination_unreachable/);
});

// In-memory stand-in for the few collection operations used.
function mem(rows = []) {
  const match = (r, q) => Object.entries(q).every(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('$exists' in v) return (r[k] !== undefined) === v.$exists;
      if ('$ne' in v) return r[k] !== v.$ne;
      if ('$in' in v) return v.$in.includes(r[k]);
      if ('$nin' in v) return !v.$nin.includes(r[k]);
    }
    return r[k] === v;
  });
  const cursor = (list) => ({ sort: () => cursor(list), limit: (n) => cursor(list.slice(0, n)), toArray: async () => list });
  return { rows, createIndex: async () => {},
    findOne: async (q) => rows.find((r) => match(r, q)) || null,
    find: (q = {}) => cursor(rows.filter((r) => match(r, q))),
    updateOne: async (q, u, o) => { let r = rows.find((x) => match(x, q)); if (!r && o?.upsert) { r = { ...q, ...(u.$setOnInsert || {}), ...(u.$set || {}) }; rows.push(r); return { upsertedCount: 1, modifiedCount: 0 }; } if (r && u.$set) Object.assign(r, u.$set); return { upsertedCount: 0, modifiedCount: r ? 1 : 0 }; },
    updateMany: async (q, u) => { for (const r of rows.filter((x) => match(x, q))) Object.assign(r, u.$set); },
    deleteMany: async (q) => { for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i], q)) rows.splice(i, 1); } };
}

test('approved-artwork selection: exact fighter, provenance, no mixing, blocks, fail closed to NEEDS ARTWORK', async () => {
  const A = await synth(700, 1000, '#1d4ed8', '#f5c518'); const B = await synth(800, 900, '#065f46', '#e5e7eb'); const M = await synth(1200, 800, '#7f1d1d', '#f5c518');
  const files = { [`${CLOUD}/inoue.jpg`]: A.buffer, [`${CLOUD}/akhmadaliev.jpg`]: B.buffer, [`${CLOUD}/fights/bx1.jpg`]: M.buffer, [`${CLOUD}/other.jpg`]: A.buffer };
  const fetchImpl = async (u) => (files[u] ? imgResp(files[u]) : { ok: false, status: 404, headers: new Headers() });
  const col = { fighterAssets: mem() };
  const lib = createArtworkLibrary({ col, fetchImpl, env: { GROWTH_ART_CLOUDINARY_CLOUDS: 'daflot6fo' } });
  const withPhotos = contest({ fighterPhotos: { a: [{ url: `${CLOUD}/inoue.jpg`, source: 'contest_upload', field: 'fighterAImage' }], b: [{ url: `${CLOUD}/akhmadaliev.jpg`, source: 'contest_upload', field: 'fighterBImage' }] } });
  const s1 = await lib.select(withPhotos);
  assert.equal(s1.mode, 'fighter_photos'); assert.deepEqual(s1.fighters.map((f) => [f.side, f.name, f.source, f.sha256]), [['a', 'Naoya Inoue', 'contest_upload', A.sha256], ['b', 'Murodjon Akhmadaliev', 'contest_upload', B.sha256]]);
  // only one fighter has a photo -> official matchup artwork, not a half-photo poster
  const half = await lib.select(contest({ fighterPhotos: { a: withPhotos.fighterPhotos.a, b: [] } }));
  assert.equal(half.mode, 'contest_artwork'); assert.deepEqual(half.missing, ['Murodjon Akhmadaliev']);
  // nothing approved -> NEEDS ARTWORK (text)
  const none = await lib.select(contest({ posterUrl: null, fighterPhotos: { a: [], b: [] } }));
  assert.equal(none.mode, 'text'); assert.equal(none.needsArtwork, true); assert.deepEqual(none.missing, ['Naoya Inoue', 'Murodjon Akhmadaliev']);
  // the same image offered for both fighters is never used
  const same = await lib.select(contest({ posterUrl: null, fighterPhotos: { a: [{ url: `${CLOUD}/inoue.jpg`, source: 'contest_upload' }], b: [{ url: `${CLOUD}/other.jpg`, source: 'contest_upload' }] } }));
  assert.equal(same.mode, 'text'); assert.ok(same.problems.some((p) => /same image/.test(p)));
  // owner library: rights note required, FMM host only, one image = one fighter, exact name
  assert.equal((await lib.approve({ fighterName: 'Naoya Inoue', imageUrl: `${CLOUD}/inoue.jpg`, rightsNote: '', admin: 'owner' })).reason, 'rights_note_required');
  assert.equal((await lib.approve({ fighterName: 'Naoya Inoue', imageUrl: 'https://images.example.com/inoue.jpg', rightsNote: 'x', admin: 'owner' })).reason, 'artwork_host_not_a_fantasy_mmadness_asset_host');
  const ok = await lib.approve({ fighterName: 'Naoya Inoue', imageUrl: `${CLOUD}/inoue.jpg`, rightsNote: 'Official promotion photo', admin: 'owner' });
  assert.equal(ok.ok, true); assert.equal(ok.asset.sha256, A.sha256);
  assert.equal((await lib.approve({ fighterName: 'Petr Yan', imageUrl: `${CLOUD}/inoue.jpg`, rightsNote: 'x', admin: 'owner' })).reason, 'this_image_is_already_approved_for_another_fighter');
  await lib.approve({ fighterName: 'Murodjon Akhmadaliev', imageUrl: `${CLOUD}/akhmadaliev.jpg`, rightsNote: 'Official promotion photo', admin: 'owner' });
  const s2 = await lib.select(contest({ fighterPhotos: { a: [], b: [] } }));
  assert.equal(s2.mode, 'fighter_photos'); assert.deepEqual(s2.fighters.map((f) => f.source), ['owner_library', 'owner_library']); assert.equal(s2.fighters[0].approvedBy, 'owner');
  // a different fighter with a similar name never gets these photos
  assert.equal((await lib.select(contest({ fighterA: 'Takuma Inoue', posterUrl: null, fighterPhotos: { a: [], b: [] } }))).mode, 'text');
  // approved photo changed at the source after approval -> not used
  files[`${CLOUD}/akhmadaliev.jpg`] = M.buffer;
  const changed = await lib.select(contest({ posterUrl: null, fighterPhotos: { a: [], b: [] } }));
  assert.equal(changed.mode, 'text'); assert.ok(changed.problems.some((p) => /sha mismatch/.test(p)));
  files[`${CLOUD}/akhmadaliev.jpg`] = B.buffer;
  // owner blocks a photo by address -> skipped everywhere
  assert.equal((await lib.block({ url: `${CLOUD}/inoue.jpg`, note: '', admin: 'owner' })).reason, 'reason_required');
  await lib.block({ url: `${CLOUD}/inoue.jpg`, note: 'Promoter asked us not to use it', admin: 'owner' });
  const blocked = await lib.select(withPhotos);
  assert.equal(blocked.mode, 'contest_artwork'); assert.ok(blocked.problems.some((p) => /blocked by owner/.test(p)));
  // owner blocks the whole contest's imagery -> text
  assert.equal((await lib.select(withPhotos, { contestBlocked: { note: 'licence' } })).mode, 'text');
});

test('studio: renders, decodes the QR from the final image, checks the destination, HOLDs on any failure, serves current versions only', async () => {
  const A = await synth(700, 1000, '#1d4ed8', '#f5c518'); const B = await synth(800, 900, '#065f46', '#e5e7eb');
  const files = { [`${CLOUD}/inoue.jpg`]: A.buffer, [`${CLOUD}/akhmadaliev.jpg`]: B.buffer };
  let site = 200;
  const fetchImpl = async (u) => (files[u] ? imgResp(files[u]) : u.startsWith('https://www.fantasymmadness.com/fight/') ? { ok: site === 200, status: site, url: u.split('?')[0] } : { ok: false, status: 404, headers: new Headers() });
  const col = { posters: mem(), artRights: mem(), drafts: mem(), fighterAssets: mem() };
  const studio = P.createPosterStudio({ col, fetchImpl, publicOrigin: 'https://growth.test/', env: { GROWTH_ART_CLOUDINARY_CLOUDS: 'daflot6fo' } });
  const c = contest({ posterUrl: null, fighterPhotos: { a: [{ url: `${CLOUD}/inoue.jpg`, source: 'contest_upload' }], b: [{ url: `${CLOUD}/akhmadaliev.jpg`, source: 'contest_upload' }] } });
  const draft = { id: 'mkt-bx0000000001-abc1234567', contestFingerprint: 'abc1234567', contest: c };
  col.drafts.rows.push({ ...draft });
  const r = await studio.ensureForDraft(draft);
  assert.equal(r.poster.status, 'ready', JSON.stringify(r.poster.holdReasons));
  assert.equal(r.poster.art.mode, 'fighter_photos'); assert.equal(r.poster.needsArtwork, false);
  assert.equal(r.poster.qr.decodedPortrait, P.qrLink(c)); assert.equal(r.poster.qr.decodedStory, P.qrLink(c)); assert.equal(r.poster.qr.destination.ok, true);
  assert.ok(!JSON.stringify(r.poster).includes('"buffer"'), 'image bytes never stored on the campaign');
  assert.match(r.poster.portrait.url, /^https:\/\/growth\.test\/api\/growth\/posters\/[a-f0-9]{20}-portrait\.jpg$/);
  assert.equal(P.posterIsCurrent({ ...draft, poster: r.poster }), true);
  assert.equal(P.posterIsCurrent({ ...draft, contest: { ...c, fighterPhotos: { a: [], b: [] } }, poster: r.poster }), false, 'new images => regenerate');
  // the fight page stops resolving -> HOLD (never publishable)
  site = 404;
  const held = await studio.ensureForDraft(draft);
  assert.equal(held.poster.status, 'hold'); assert.deepEqual(held.poster.holdReasons, ['destination_http_404']);
  site = 200;
  // no approved photos -> NEEDS ARTWORK text poster, still a valid poster
  const noArt = await studio.ensureForDraft({ ...draft, contest: { ...c, fighterPhotos: { a: [], b: [] } } });
  assert.equal(noArt.poster.art.mode, 'text'); assert.equal(noArt.poster.needsArtwork, true); assert.equal(noArt.poster.status, 'ready');
  assert.equal(await studio.getImage(r.poster.portrait.id), null, 'older versions are withdrawn');
  assert.ok((await studio.getImage(noArt.poster.portrait.id)).buffer.length > 10000);
  assert.equal(await studio.getImage('../../etc/passwd'), null);
});

// ---- premium genre design system -------------------------------------------------------------
const { prepareFighter, STYLES } = require('./growth-poster-premium');
// synthetic standing figure (never a real person); bg=null => transparent cut-out
const figure = async (bg = null, w = 600, h = 1000) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : ''}<ellipse cx="300" cy="140" rx="80" ry="100" fill="#b07a5a"/><path d="M120 300 Q300 230 480 300 L500 640 L100 640 Z" fill="#a46c4c"/><rect x="110" y="640" width="380" height="200" fill="#151515"/><rect x="150" y="840" width="110" height="160" fill="#a46c4c"/><rect x="340" y="840" width="110" height="160" fill="#a46c4c"/></svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buffer, width: w, height: h, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
};

test('fighter photos: transparent cut-outs kept, plain studio backgrounds removed (fighter pixels untouched), anything else framed', async () => {
  const cut = await prepareFighter({ ...(await figure()), side: 'a', name: 'A' });
  assert.equal(cut.method, 'cutout_transparent');
  const studio = await figure('#f4f4f4');
  const removed = await prepareFighter({ ...studio, side: 'b', name: 'B' });
  assert.equal(removed.method, 'cutout_background_removed');
  assert.ok(removed.removed > 0.3 && removed.removed < 0.8, `removed ${removed.removed}`);
  // every remaining (opaque) pixel is exactly the original pixel at the same place
  const orig = await sharp(studio.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const got = await sharp(removed.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const t = removed.trimmed; let changed = 0; let opaque = 0;
  for (let y = 0; y < got.info.height; y++) for (let x = 0; x < got.info.width; x++) {
    const i = (y * got.info.width + x) * 4; if (got.data[i + 3] === 0) continue; opaque++;
    const j = ((y + t.top) * orig.info.width + (x + t.left)) * 4;
    if (got.data[i] !== orig.data[j] || got.data[i + 1] !== orig.data[j + 1] || got.data[i + 2] !== orig.data[j + 2]) changed++;
  }
  assert.ok(opaque > 100000); assert.equal(changed, 0, 'fighter pixels must not change');
  // the figure itself (legs touching the bottom edge) is not removed
  assert.ok(got.data[((got.info.height - 2) * got.info.width + Math.round(200 - t.left)) * 4 + 3] === 255, 'legs kept');
  const busy = await synth(800, 1000, '#1d4ed8', '#f5c518');
  assert.equal((await prepareFighter({ ...busy, side: 'a', name: 'A' })).method, 'framed');
});

test('premium posters: all five genres, both sizes, cut-outs and text fallback — QC passes, nothing over a fighter, QR decodes', async () => {
  const A = await figure(); const B = await figure('#f4f4f4');
  assert.deepEqual(Object.keys(STYLES).sort(), ['bare-knuckle', 'boxing', 'kickboxing', 'mma-ufc', 'pro-wrestling']);
  const seenVariants = new Set();
  for (const sport of Object.keys(STYLES)) {
    const c = contest({ sport, id: `${sport.slice(0, 2)}0000000001`, eventName: 'SAMPLE EVENT', timeTba: false, matchTime: '22:00', timeZone: 'America/New_York' });
    for (const [mode, artwork] of [['photos', { mode: 'fighter_photos', fighters: [{ side: 'a', name: c.fighterA, ...A }, { side: 'b', name: c.fighterB, ...B }] }], ['text', { mode: 'text' }]]) {
      for (const format of ['portrait', 'story']) {
        const r = await P.renderPoster({ contest: c, format, artwork, qrUrl: P.qrLink(c) });
        const md = await sharp(r.buffer).metadata();
        assert.deepEqual([md.width, md.height], [1080, format === 'portrait' ? 1350 : 1920]);
        assert.equal(r.layout.style, sport);
        assert.deepEqual(r.layout.qc.problems, [], `${sport} ${mode} ${format}`);
        const kinds = r.layout.text.map((x) => x.kind);
        for (const k of ['headline-predict', 'headline-thefight', 'cta', 'tagline', 'event', 'date']) assert.ok(kinds.includes(k), `${sport} ${format}: missing ${k}`);
        assert.ok(kinds.includes('name-a') && kinds.includes('name-b'), 'both names');
        for (const im of r.layout.images) for (const tx of r.layout.text) assert.ok(!(im.left < tx.left + tx.width && im.left + im.width > tx.left && im.top < tx.top + tx.height && im.top + im.height > tx.top), `${tx.kind} over ${im.name}`);
        if (mode === 'photos') { assert.deepEqual(r.layout.images.map((i) => i.method), ['framed', 'framed']); seenVariants.add(r.layout.variant); }
        assert.equal((await P.decodeQr(r.buffer)).text, P.qrLink(c), `${sport} ${format}: QR`);
      }
    }
  }
  assert.ok(seenVariants.size >= 1);
});

test('original-art mode preserves every source pixel, dimensions and background', async () => {
  const source = await figure('#f4f4f4');
  const kept = await prepareFighter(source, { preserveOriginal: true });
  assert.equal(kept.method, 'framed'); assert.equal(kept.removed, 0); assert.equal(kept.trimmed, null);
  const original = await sharp(source.buffer).rotate().ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const actual = await sharp(kept.png).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  assert.equal(actual.info.width, original.info.width); assert.equal(actual.info.height, original.info.height);
  assert.deepEqual(actual.data, original.data);
});
