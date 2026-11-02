'use strict';
// Renders sample posters (CI artifact + log print for visual review) and decodes each QR code
// from the final JPEG. Uses SYNTHETIC test images only (labelled TEST PHOTO / TEST ARTWORK),
// never real fighter photos, and fixture contests.
const fs = require('fs'); const path = require('path'); const sharp = require('sharp');
const P = require('../growth-poster-studio');
const synth = async (w, h, a, b, label) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w / 2}" cy="${h * 0.32}" r="${w * 0.2}" fill="#d6d3d1"/><rect x="${w * 0.22}" y="${h * 0.55}" width="${w * 0.56}" height="${h * 0.45}" rx="40" fill="#d6d3d1"/><text x="${w / 2}" y="${h * 0.5}" font-size="${w / 11}" text-anchor="middle" fill="#fff" font-family="sans-serif">${label}</text></svg>`;
  const buffer = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer(); return { buffer, width: w, height: h, sha256: 'synthetic' };
};
(async () => {
  const out = process.argv[2] || 'poster-samples'; fs.mkdirSync(out, { recursive: true });
  const A = await synth(700, 1000, '#1e3a8a', '#0b1020', 'TEST PHOTO A'); const B = await synth(760, 980, '#7f1d1d', '#140a0a', 'TEST PHOTO B');
  const M = await synth(1200, 800, '#3f3f46', '#111827', 'TEST ARTWORK');
  const base = { dateKey: '2026-11-14', timeTba: true, venue: null, city: null, weightClass: null, maxRounds: null, eventName: null, promotion: null, cleanUrl: null };
  const ufc = { ...base, id: 'mm0000000001', sport: 'mma-ufc', fighterA: 'Sample Fighter One', fighterB: 'Sample Fighter Two', eventName: 'SAMPLE EVENT', timeTba: false, matchTime: '22:00', timeZone: 'America/New_York', maxRounds: 3, contestUrl: 'https://www.fantasymmadness.com/fight/mm0000000001?play=1', cleanUrl: 'https://www.fantasymmadness.com/fight/sample-fighter-one-vs-sample-fighter-two' };
  const cases = [
    ['photos-ufc', ufc, { mode: 'fighter_photos', fighters: [{ side: 'a', name: ufc.fighterA, ...A }, { side: 'b', name: ufc.fighterB, ...B }] }],
    ['artwork-boxing', { ...base, id: 'bx0000000001', sport: 'boxing', fighterA: 'Naoya Inoue', fighterB: 'Murodjon Akhmadaliev', venue: 'Ariake Arena', city: 'Tokyo', weightClass: 'Super Bantamweight', maxRounds: 12, contestUrl: 'https://www.fantasymmadness.com/fight/bx0000000001?play=1' }, { mode: 'contest_artwork', contestArt: M }],
    ['text-wrestling', { ...base, id: 'pw0000000001', sport: 'pro-wrestling', fighterA: 'Kenny Omega', fighterB: 'Will Ospreay', eventName: 'Saturday Night Clash', promotion: 'AEW', contestUrl: 'https://www.fantasymmadness.com/pro-wrestling/play/pw0000000001' }, { mode: 'text' }],
  ];
  let bad = 0;
  for (const [name, c, artwork] of cases) for (const format of ['portrait', 'story']) {
    const t0 = Date.now(); const want = P.qrLink(c);
    const r = await P.renderPoster({ contest: c, format, artwork, qrUrl: want });
    const dec = await P.decodeQr(r.buffer);
    fs.writeFileSync(path.join(out, `${name}-${format}.jpg`), r.buffer);
    const ok = dec.ok && dec.text === want; if (!ok) bad++;
    console.log(`${name}-${format}: ${r.buffer.length} bytes in ${Date.now() - t0} ms; QR decoded from final image: ${dec.ok ? dec.text : dec.reason} ${ok ? 'MATCHES' : 'MISMATCH'}`);
  }
  if (bad) { console.error(`${bad} poster(s) failed QR decoding`); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
