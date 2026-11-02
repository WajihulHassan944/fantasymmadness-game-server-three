'use strict';
// Renders sample posters (CI artifact for visual review). Uses a SYNTHETIC test artwork,
// never a real fighter image, and the fixture contests.
const fs = require('fs'); const path = require('path'); const sharp = require('sharp');
const P = require('../growth-poster-studio');
(async () => {
  const out = process.argv[2] || 'poster-samples'; fs.mkdirSync(out, { recursive: true });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#7f1d1d"/><stop offset="1" stop-color="#1e3a8a"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><rect y="380" width="1200" height="60" fill="#f5c518"/><text x="600" y="260" font-size="90" text-anchor="middle" fill="#fff" font-family="sans-serif">TEST ARTWORK</text></svg>';
  const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
  const art = { buffer: buf, width: 1200, height: 800, sha256: 'synthetic' };
  const base = { dateKey: '2026-11-14', timeTba: true, venue: null, city: null, weightClass: null, maxRounds: null, eventName: null, promotion: null, cleanUrl: null };
  const cases = [
    ['boxing-art', { ...base, id: 'bx0000000001', sport: 'boxing', fighterA: 'Naoya Inoue', fighterB: 'Murodjon Akhmadaliev', venue: 'Ariake Arena', city: 'Tokyo', weightClass: 'Super Bantamweight', maxRounds: 12, contestUrl: 'https://www.fantasymmadness.com/fight/bx0000000001?play=1' }, art],
    ['mma-text', { ...base, id: 'mm0000000001', sport: 'mma-ufc', fighterA: 'Merab Dvalishvili', fighterB: 'Petr Yan', eventName: 'UFC 323', timeTba: false, matchTime: '22:00', timeZone: 'America/Los_Angeles', venue: 'T-Mobile Arena', city: 'Las Vegas', maxRounds: 5, contestUrl: 'https://www.fantasymmadness.com/fight/mm0000000001?play=1', cleanUrl: 'https://www.fantasymmadness.com/fight/merab-dvalishvili-vs-petr-yan' }, null],
    ['wrestling-text', { ...base, id: 'pw0000000001', sport: 'pro-wrestling', fighterA: 'Kenny Omega', fighterB: 'Will Ospreay', eventName: 'Saturday Night Clash', promotion: 'AEW', contestUrl: 'https://www.fantasymmadness.com/pro-wrestling/play/pw0000000001' }, null],
    ['kickboxing-art-long', { ...base, id: 'kb0000000001', sport: 'kickboxing', fighterA: 'Superbon Singha Mawynn', fighterB: 'Masaaki Noiri', eventName: 'ONE Friday Fights', contestUrl: 'https://www.fantasymmadness.com/fight/kb0000000001?play=1' }, art],
  ];
  for (const [name, c, a] of cases) for (const format of ['portrait', 'story']) {
    const t0 = Date.now(); const r = await P.renderPoster({ contest: c, format, art: a, qrUrl: P.qrLink(c) });
    fs.writeFileSync(path.join(out, `${name}-${format}.jpg`), r.buffer);
    console.log(`${name}-${format}: ${r.buffer.length} bytes in ${Date.now() - t0} ms`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
