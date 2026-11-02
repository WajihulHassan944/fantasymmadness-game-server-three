'use strict';
// Poster generation: rights rules, unaltered artwork, accurate facts, scannable QR.
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const QRCode = require('qrcode');
const P = require('./growth-poster-studio');

const contest = (o = {}) => ({ id: 'bx0000000001', sport: 'boxing', fighterA: 'Naoya Inoue', fighterB: 'Murodjon Akhmadaliev', dateKey: '2026-11-08', timeTba: true, matchTime: null, timeZone: null,
  venue: 'Ariake Arena', city: 'Tokyo', weightClass: 'Super Bantamweight', maxRounds: 12, eventName: null, promotion: null,
  contestUrl: 'https://www.fantasymmadness.com/fight/bx0000000001?play=1', cleanUrl: null, posterUrl: 'https://res.cloudinary.com/fmm/image/upload/v1/fights/bx1.jpg', posterField: 'fightPosterImage', fingerprint: 'abc1234567', ...o });

// A synthetic test artwork (never a real fighter image): a blue field with a gold "belt" band
// and a red block in one corner, so any crop, recolour or distortion is detectable.
async function testArt(w = 800, h = 1000) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#1d4ed8"/><rect x="0" y="${h * 0.45}" width="${w}" height="${h * 0.1}" fill="#f5c518"/><rect x="${w - 160}" y="0" width="160" height="160" fill="#dc2626"/><circle cx="${w * 0.3}" cy="${h * 0.25}" r="${w * 0.12}" fill="#ffffff"/></svg>`;
  const buffer = await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer();
  return { buffer, width: w, height: h, sha256: require('crypto').createHash('sha256').update(buffer).digest('hex') };
}
// Reads the QR modules back out of the poster pixels and compares them with the
// matrix the URL must produce: a scanner sees exactly this URL.
async function qrMatches(poster, layout, url) {
  const { data, info } = await sharp(poster).extract({ left: layout.qr.left, top: layout.qr.top, width: layout.qr.px, height: layout.qr.px }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const m = P.qrMatrix(url); let bad = 0;
  for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) {
    const y = (r + layout.qr.quiet) * layout.qr.scale + Math.floor(layout.qr.scale / 2); const x = (c + layout.qr.quiet) * layout.qr.scale + Math.floor(layout.qr.scale / 2);
    const dark = data[y * info.width + x] < 128; if (dark !== m.get(r, c)) bad++;
  }
  return { bad, modules: m.size };
}

test('artwork rights: only official FANTASY MMADNESS contest artwork on FMM asset hosts', () => {
  const pol = P.artPolicy({});
  assert.equal(P.checkArtSource(contest(), pol).ok, true);
  assert.match(P.checkArtSource(contest(), pol).basis, /Official artwork published by FANTASY MMADNESS on this contest \(fightPosterImage\)/);
  assert.equal(P.checkArtSource(contest({ posterUrl: 'https://www.fantasymmadness.com/images/x.png' }), pol).ok, true);
  for (const [url, reason] of [[null, 'no_official_artwork_on_this_contest'], ['http://res.cloudinary.com/fmm/image/upload/a.jpg', 'artwork_not_https'], ['https://images.example.com/inoue.jpg', 'artwork_host_not_a_fantasy_mmadness_asset_host'],
    ['https://res.cloudinary.com/fmm/video/upload/a.mp4', 'artwork_not_an_uploaded_image'], ['https://fantasymmadness.com.evil.example/a.jpg', 'artwork_host_not_a_fantasy_mmadness_asset_host']]) {
    assert.equal(P.checkArtSource(contest({ posterUrl: url }), pol).reason, reason, String(url));
  }
  assert.equal(P.checkArtSource(contest(), pol, { status: 'blocked', note: 'licence expired' }).reason, 'artwork_blocked_by_owner');
  const narrow = P.artPolicy({ GROWTH_ART_CLOUDINARY_CLOUDS: 'daflot6fo' });
  assert.equal(P.checkArtSource(contest(), narrow).reason, 'artwork_not_on_the_fantasy_mmadness_cloud');
  assert.equal(P.checkArtSource(contest({ posterUrl: 'https://res.cloudinary.com/daflot6fo/image/upload/v1/a.jpg' }), narrow).ok, true);
});

test('fetchImage refuses non-images, tiny images and redirects', async () => {
  const art = await testArt();
  const resp = (body, type, status = 200) => ({ ok: status < 400, status, headers: new Headers({ 'content-type': type }), arrayBuffer: async () => body });
  assert.equal((await P.fetchImage(async () => resp(art.buffer, 'image/jpeg'), 'https://x')).ok, true);
  assert.match((await P.fetchImage(async () => resp(Buffer.from('<html>'), 'text/html'), 'https://x')).reason, /artwork_not_an_image/);
  assert.equal((await P.fetchImage(async () => resp(Buffer.alloc(0), 'image/jpeg', 404), 'https://x')).reason, 'artwork_http_404');
  const tiny = await sharp({ create: { width: 120, height: 120, channels: 3, background: '#fff' } }).jpeg().toBuffer();
  assert.equal((await P.fetchImage(async () => resp(tiny, 'image/jpeg'), 'https://x')).reason, 'artwork_too_small');
  let opts; await P.fetchImage(async (u, o) => { opts = o; return resp(art.buffer, 'image/jpeg'); }, 'https://x');
  assert.equal(opts.redirect, 'error');
});

test('poster: whole artwork, uniformly scaled, pixels unaltered; facts from the contest; QR scans to the campaign link', async () => {
  const art = await testArt(800, 1000);
  const c = contest();
  const qrUrl = P.qrLink(c);
  assert.equal(qrUrl, 'https://www.fantasymmadness.com/fight/bx0000000001?play=1&utm_source=fan_acquisition&utm_medium=partner_outreach&utm_campaign=combat_fans_gs_boxing&utm_content=poster_qr');
  for (const format of ['portrait', 'story']) {
    const r = await P.renderPoster({ contest: c, format, art, qrUrl });
    const meta = await sharp(r.buffer).metadata();
    assert.deepEqual([meta.width, meta.height, meta.format], [P.FORMATS[format].width, P.FORMATS[format].height, 'jpeg']);
    const a = r.layout.art;
    // aspect ratio kept (no stretch), nothing cut off (inside its box)
    assert.ok(Math.abs(a.width / a.height - 800 / 1000) < 0.01, `${format} aspect ${a.width}x${a.height}`);
    const box = r.layout.artBox;
    assert.ok(a.left >= box.left && a.top >= box.top && a.left + a.width <= box.left + box.width && a.top + a.height <= box.top + box.height, 'art inside its box');
    // the artwork region equals the original scaled to that size: no crop, recolour or overlay
    const placed = await sharp(r.buffer).extract({ left: a.left, top: a.top, width: a.width, height: a.height }).removeAlpha().raw().toBuffer();
    const expected = await sharp(art.buffer).resize(a.width, a.height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    let diff = 0; for (let i = 0; i < placed.length; i++) diff += Math.abs(placed[i] - expected[i]);
    const mad = diff / placed.length;
    assert.ok(mad < 6, `${format}: mean pixel difference ${mad.toFixed(2)} (artwork altered?)`);
    // the gold "belt" band is still exactly where it was, at full width
    const band = await sharp(r.buffer).extract({ left: a.left + 4, top: a.top + Math.round(a.height * 0.5), width: a.width - 8, height: 2 }).removeAlpha().raw().toBuffer();
    for (let i = 0; i < band.length; i += 3) assert.ok(band[i] > 200 && band[i + 1] > 160 && band[i + 2] < 90, 'belt band colour changed');
    const q = await qrMatches(r.buffer, r.layout, qrUrl);
    assert.equal(q.bad, 0, `${format}: ${q.bad} QR modules differ`);
    assert.deepEqual(r.facts, { sport: 'BOXING', fighterA: 'Naoya Inoue', fighterB: 'Murodjon Akhmadaliev', event: null, date: 'SUNDAY, NOVEMBER 8, 2026', time: null, where: 'Ariake Arena · Tokyo', detail: 'Super Bantamweight · 12 ROUNDS', qrUrl, shownUrl: 'www.fantasymmadness.com/fight/bx0000000001' });
  }
  // QR prefers the fighter-name address when the website serves it
  assert.match(P.qrLink(contest({ cleanUrl: 'https://www.fantasymmadness.com/fight/naoya-inoue-vs-murodjon-akhmadaliev' })), /^https:\/\/www\.fantasymmadness\.com\/fight\/naoya-inoue-vs-murodjon-akhmadaliev\?utm_source=fan_acquisition.*utm_content=poster_qr$/);
});

test('poster without approved artwork: typographic only, no fighter imagery; time shown only when verified', async () => {
  const c = contest({ posterUrl: null, timeTba: false, matchTime: '22:00', timeZone: 'America/Los_Angeles', eventName: 'UFC 323', sport: 'mma-ufc', venue: null, city: null, weightClass: null, maxRounds: null });
  const r = await P.renderPoster({ contest: c, format: 'portrait', art: null, qrUrl: P.qrLink(c) });
  assert.equal(r.layout.art, null);
  assert.equal(r.facts.time, '10:00 PM PST');
  assert.equal(r.facts.where, null); assert.equal(r.facts.detail, null); assert.equal(r.facts.event, 'UFC 323');
  assert.equal((await qrMatches(r.buffer, r.layout, P.qrLink(c))).bad, 0);
  // very long names still fit
  const long = contest({ fighterA: 'Superbon Singha Mawynn Banchamek', fighterB: 'Tawanchai PK Saenchai Muaythaigym', sport: 'kickboxing' });
  const r2 = await P.renderPoster({ contest: long, format: 'story', art: null, qrUrl: P.qrLink(long) });
  assert.equal((await sharp(r2.buffer).metadata()).height, 1920);
});

test('studio: stores posters once per campaign version, serves them, withdraws old versions, honours blocks', async () => {
  const art = await testArt();
  const mem = (rows = []) => ({ rows,
    findOne: async (q) => rows.find((r) => Object.entries(q).every(([k, v]) => (v && v.$exists === false ? r[k] === undefined : r[k] === v))) || null,
    updateOne: async (q, u, o) => { let r = rows.find((x) => Object.entries(q).every(([k, v]) => x[k] === v)); if (!r && o?.upsert) { r = { ...q, ...(u.$setOnInsert || {}), ...(u.$set || {}) }; rows.push(r); return { upsertedCount: 1 }; } if (r && u.$set) Object.assign(r, u.$set); return { upsertedCount: 0 }; },
    updateMany: async (q, u) => { for (const r of rows) if (r.draftId === q.draftId && !q.id.$nin.includes(r.id) && r.withdrawnAt === undefined) Object.assign(r, u.$set); },
    deleteMany: async (q) => { for (let i = rows.length - 1; i >= 0; i--) if (rows[i].contestId === q.contestId) rows.splice(i, 1); } });
  const col = { posters: mem(), artRights: mem(), drafts: mem([]) };
  let fetches = 0;
  const fetchImpl = async (url) => { fetches++; if (url.startsWith('https://res.cloudinary.com/fmm/')) return { ok: true, status: 200, headers: new Headers({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => art.buffer }; return { ok: false, status: 404, headers: new Headers() }; };
  const studio = P.createPosterStudio({ col, fetchImpl, publicOrigin: 'https://growth.test/' });
  const draft = { id: 'mkt-bx0000000001-abc1234567', contestFingerprint: 'abc1234567', contest: contest() };
  col.drafts.rows.push({ ...draft });
  const r = await studio.ensureForDraft(draft);
  assert.equal(r.ok, true); assert.equal(r.poster.art.used, true); assert.match(r.poster.art.basis, /Official artwork/);
  assert.match(r.poster.portrait.url, /^https:\/\/growth\.test\/api\/growth\/posters\/[a-f0-9]{20}-portrait\.jpg$/);
  assert.equal(col.posters.rows.length, 2);
  const img = await studio.getImage(r.poster.portrait.id);
  assert.equal((await sharp(img.buffer).metadata()).width, 1080);
  assert.equal(await studio.getImage('../../etc/passwd'), null);
  // same version again: nothing re-rendered
  const before = col.posters.rows.length; await studio.ensureForDraft(draft); assert.equal(col.posters.rows.length, before);
  // owner blocks the artwork: typographic poster, old version withdrawn (no longer served)
  assert.equal((await studio.setArtRights(draft.contest.id, { status: 'blocked', note: '', admin: 'owner' })).reason, 'reason_required');
  await studio.setArtRights(draft.contest.id, { status: 'blocked', note: 'Promoter asked us not to use this image', admin: 'owner' });
  const b = await studio.ensureForDraft(draft);
  assert.equal(b.poster.art.used, false); assert.equal(b.poster.art.reason, 'artwork_blocked_by_owner');
  assert.notEqual(b.poster.portrait.id, r.poster.portrait.id);
  assert.equal(await studio.getImage(r.poster.portrait.id), null);
  // artwork on a non-FMM host is never fetched
  fetches = 0; const other = { ...draft, id: 'mkt-x-1', contest: contest({ id: 'x1', posterUrl: 'https://images.example.com/inoue.jpg' }) };
  const o = await studio.ensureForDraft(other);
  assert.equal(o.poster.art.reason, 'artwork_host_not_a_fantasy_mmadness_asset_host');
  assert.equal(fetches, 0, 'artwork on a foreign host is never fetched');
});

test('QR helper encodes exactly the requested URL', () => {
  const url = 'https://www.fantasymmadness.com/fight/x?utm_content=poster_qr';
  const a = P.qrMatrix(url); const b = QRCode.create(url, { errorCorrectionLevel: 'M' });
  assert.equal(a.size, b.modules.size);
});
