'use strict';
// Renders the premium sample posters for all five genres (feed 1080x1350 + vertical 1080x1920),
// decodes every QR code from the final JPEG, and reports the quality checks.
// Uses SYNTHETIC test figures only (stylised mannequins labelled TEST), never real people.
// Fixture fights: the names/dates are sample data, not real events.
const fs = require('fs'); const path = require('path'); const sharp = require('sharp');
const P = require('../growth-poster-studio');

// A stylised standing figure (transparent background) - stands in for an approved cut-out photo.
const figure = async ({ skin = '#c08a6b', shorts = '#111111', trim = '#e10600', gloves = '#d0021b', label = 'TEST A', bg = null, w = 700, h = 1100 }) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs><linearGradient id="sk" x1="0" x2="1"><stop offset="0" stop-color="${skin}" stop-opacity="0.75"/><stop offset="0.5" stop-color="${skin}"/><stop offset="1" stop-color="#3b2418"/></linearGradient>
  <linearGradient id="sh" x1="0" x2="1"><stop offset="0" stop-color="${shorts}"/><stop offset="0.6" stop-color="#3a3a3a"/><stop offset="1" stop-color="${shorts}"/></linearGradient></defs>
  ${bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : ''}
  <ellipse cx="350" cy="150" rx="88" ry="108" fill="url(#sk)"/>
  <rect x="300" y="240" width="100" height="70" fill="url(#sk)"/>
  <path d="M150 330 Q350 260 550 330 L585 640 Q350 700 115 640 Z" fill="url(#sk)"/>
  <path d="M150 330 Q95 470 120 640 L170 640 Q175 480 205 380 Z" fill="url(#sk)"/>
  <path d="M550 330 Q605 470 580 640 L530 640 Q525 480 495 380 Z" fill="url(#sk)"/>
  <ellipse cx="140" cy="690" rx="62" ry="74" fill="${gloves}"/><ellipse cx="560" cy="690" rx="62" ry="74" fill="${gloves}"/>
  <path d="M175 640 L525 640 L545 880 L370 880 L350 800 L330 880 L155 880 Z" fill="url(#sh)"/>
  <rect x="175" y="640" width="350" height="34" fill="${trim}"/>
  <path d="M190 880 L330 880 L320 1100 L215 1100 Z M370 880 L510 880 L485 1100 L380 1100 Z" fill="url(#sk)"/>
  <text x="350" y="520" font-size="58" text-anchor="middle" fill="#ffffff" fill-opacity="0.85" font-family="sans-serif" font-weight="bold">${label}</text></svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buffer, width: w, height: h, sha256: 'synthetic' };
};
const framedPhoto = async (label) => { const b = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b3a55"/><stop offset="1" stop-color="#0d1320"/></linearGradient></defs><rect width="800" height="1000" fill="url(#g)"/><circle cx="400" cy="330" r="150" fill="#9b7a64"/><rect x="190" y="520" width="420" height="480" rx="80" fill="#9b7a64"/><text x="400" y="560" font-size="64" text-anchor="middle" fill="#fff" font-family="sans-serif">${label}</text></svg>`)).jpeg({ quality: 92 }).toBuffer(); return { buffer: b, width: 800, height: 1000, sha256: 'synthetic' }; };

(async () => {
  const out = process.argv[2] || 'poster-samples'; fs.mkdirSync(out, { recursive: true });
  const base = { timeTba: false, matchTime: '22:00', timeZone: 'America/New_York', venue: null, city: null, weightClass: null, maxRounds: null, promotion: null, cleanUrl: null, fingerprint: 'sample' };
  const genres = [
    ['mma', { ...base, id: 'mm0000000001', sport: 'mma-ufc', fighterA: 'Sample Fighter One', fighterB: 'Sample Fighter Two', eventName: 'SAMPLE FIGHT NIGHT 1', dateKey: '2026-11-14', maxRounds: 5, contestUrl: 'https://www.fantasymmadness.com/fight/mm0000000001?play=1' }, ['#c58c68', '#151515', '#e10600', '#c4161c'], ['#8d5a3b', '#f2f2f2', '#1d4ed8', '#c4161c']],
    ['boxing', { ...base, id: 'bx0000000007', sport: 'boxing', fighterA: 'Sample Boxer Gold', fighterB: 'Sample Boxer Silver', eventName: 'SAMPLE TITLE NIGHT', dateKey: '2026-11-21', maxRounds: 12, weightClass: 'Middleweight', venue: 'Sample Arena', contestUrl: 'https://www.fantasymmadness.com/fight/bx0000000007?play=1' }, ['#b98463', '#1a1a1a', '#d4af37', '#7a0c0c'], ['#7a4a2e', '#ffffff', '#d4af37', '#0d2a6b']],
    ['bare-knuckle', { ...base, id: 'bk0000000004', sport: 'bare-knuckle', fighterA: 'Sample Brawler One', fighterB: 'Sample Brawler Two', eventName: 'SAMPLE KNUCKLE NIGHT', dateKey: '2026-11-28', maxRounds: 5, contestUrl: 'https://www.fantasymmadness.com/fight/bk0000000004?play=1' }, ['#c79574', '#2b1b12', '#ff5a1f', '#e8d6c0'], ['#9c6b4c', '#111111', '#b5471b', '#e8d6c0']],
    ['kickboxing', { ...base, id: 'kb0000000003', sport: 'kickboxing', fighterA: 'Sample Striker One', fighterB: 'Sample Striker Two', eventName: 'SAMPLE STRIKE SERIES', dateKey: '2026-12-05', maxRounds: 3, contestUrl: 'https://www.fantasymmadness.com/fight/kb0000000003?play=1' }, ['#d39b7a', '#0b1e4a', '#1e90ff', '#1e90ff'], ['#7d5038', '#4a0b0b', '#e10600', '#e10600']],
    ['pro-wrestling', { ...base, id: 'pw0000000009', sport: 'pro-wrestling', fighterA: 'Sample Champion', fighterB: 'Sample Challenger', eventName: 'SAMPLE SHOWDOWN', promotion: 'SAMPLE', dateKey: '2026-12-12', contestUrl: 'https://www.fantasymmadness.com/pro-wrestling/play/pw0000000009' }, ['#c58c68', '#3b0a57', '#ffcc33', '#ffcc33'], ['#8d5a3b', '#111111', '#a020f0', '#a020f0']],
  ];
  const cases = [];
  for (const [g, c, a, b] of genres) {
    const fa = await figure({ skin: a[0], shorts: a[1], trim: a[2], gloves: a[3], label: 'TEST A' });
    // fighter B arrives on a plain studio background (exercises the background-only cut-out)
    const fb = await figure({ skin: b[0], shorts: b[1], trim: b[2], gloves: b[3], label: 'TEST B', bg: '#f4f4f4' });
    cases.push([`${g}-photos`, c, { mode: 'fighter_photos', fighters: [{ side: 'a', name: c.fighterA, ...fa }, { side: 'b', name: c.fighterB, ...fb }] }]);
  }
  cases.push(['mma-text-fallback', { ...genres[0][1], id: 'mm0000000002', fighterA: 'Sample Fighter Three', fighterB: 'Sample Fighter Four' }, { mode: 'text' }]);
  cases.push(['boxing-framed-photos', { ...genres[1][1], id: 'bx0000000008' }, { mode: 'fighter_photos', fighters: [{ side: 'a', name: genres[1][1].fighterA, ...(await framedPhoto('TEST PHOTO A')) }, { side: 'b', name: genres[1][1].fighterB, ...(await framedPhoto('TEST PHOTO B')) }] }]);
  let bad = 0;
  for (const [name, c, artwork] of cases) for (const format of ['portrait', 'story']) {
    const t0 = Date.now(); const want = P.qrLink(c);
    const r = await P.renderPoster({ contest: c, format, artwork, qrUrl: want });
    const dec = await P.decodeQr(r.buffer);
    fs.writeFileSync(path.join(out, `${name}-${format}.jpg`), r.buffer);
    const ok = dec.ok && dec.text === want && r.layout.qc.passed; if (!ok) bad++;
    console.log(`${name}-${format}: style=${r.layout.style} layout=${r.layout.variant} images=${r.layout.images.map((i) => i.method).join('+') || 'none'} ${r.buffer.length} bytes ${Date.now() - t0} ms; QR ${dec.ok && dec.text === want ? 'DECODED=link' : 'FAIL ' + (dec.text || dec.reason)}; QC ${r.layout.qc.passed ? 'pass' : r.layout.qc.problems.join(',')}`);
  }
  if (bad) { console.error(`${bad} poster(s) failed QR decoding or quality checks`); process.exitCode = 1; }
})().catch((e) => { console.error(e); process.exit(1); });
