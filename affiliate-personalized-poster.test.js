'use strict';

// Issue #185: personalized affiliate poster helpers (no database needed).
const assert = require('assert');
const sharp = require('sharp');
const QRCode = require('qrcode');
const register = require('./affiliate-custom-poster');
const { affiliateFromLink, readQr, affiliateLeagueFightLink, affiliatePaidFightLink } = register;

const kelise = '65a1b2c3d4e5f60718293a4b';
const other = '65a1b2c3d4e5f60718293a4c';
const fight = '65f0e1d2c3b4a59687706152';

(async () => {
  // Link parsing: league, named league, paid fight, foreign hosts.
  assert.deepStrictEqual(affiliateFromLink(affiliateLeagueFightLink(kelise, fight)), { affiliateId: kelise, fightId: fight });
  assert.deepStrictEqual(affiliateFromLink(affiliatePaidFightLink(kelise, fight)), { affiliateId: kelise, fightId: fight });
  assert.deepStrictEqual(affiliateFromLink(`https://www.fantasymmadness.com/league/kelise-davis?ref=${kelise}&fightId=${fight}`), { affiliateId: kelise, fightId: fight });
  assert.strictEqual(affiliateFromLink(`https://fantasymmadness.com.evil.example/league/${kelise}?fightId=${fight}`), null);
  assert.strictEqual(affiliateFromLink('not a link'), null);

  // Build helpers with a stub app/database (routes are registered but unused).
  const routes = [];
  const app = { locals: {}, get: (route) => routes.push(route), post: (route) => routes.push(route) };
  function Schema() {}
  const mongoose = { models: {}, Schema, model: () => ({}) };
  const helpers = register({ app, mongoose, verifyAdminToken: () => {}, verifyToken: () => {}, requireScope: () => () => {}, cloudinary: null, sharp, QRCode, upload: null });
  assert(routes.includes('/api/affiliates/me/promotions/:fightId/custom-poster'), 'kit poster route registered');
  assert(routes.includes('/api/affiliates/me/promotions/:fightId/custom-poster/image'), 'kit poster image route registered');
  assert(routes.includes('/api/public/affiliate-posters/:fightId/:affiliateId/image'), 'public poster image route registered');
  assert.strictEqual(typeof app.locals.affiliateCustomPoster.posterForAffiliateEmail, 'function');
  assert.strictEqual(typeof app.locals.affiliateCustomPoster.approvedForAffiliate, 'function');

  // A poster that already carries an affiliate's QR: the QR is found.
  const art = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: '#5a1033' } }).png().toBuffer();
  const printed = await QRCode.toBuffer(affiliateLeagueFightLink(kelise, fight), { type: 'png', margin: 2, width: 300 });
  const poster = await sharp(art).composite([{ input: printed, left: 720, top: 980 }]).png().toBuffer();
  const embedded = await readQr(sharp, poster);
  assert.strictEqual(embedded.data, affiliateLeagueFightLink(kelise, fight));
  assert(embedded.box.x > 0.6 && embedded.box.y > 0.65, 'QR position reported');

  // Composing the QR and reading it back from the finished image.
  for (const [qrLink, qr] of [[affiliateLeagueFightLink(kelise, fight), { x: 0.65, y: 0.7, scale: 0.3 }], [affiliatePaidFightLink(other, fight), { x: 0.05, y: 0.05, scale: 0.12 }]]) {
    const built = await helpers.compose({ source: poster, qrLink, qr });
    const margin = Math.round(built.qr.size * 0.15);
    const read = await readQr(sharp, built.output, { left: built.qr.left - margin, top: built.qr.top - margin, size: built.qr.size + margin * 2 });
    assert.strictEqual(read && read.data, qrLink, `composed QR reads back as ${qrLink}`);
  }

  // kitPoster exposes only what the kit needs, with cache-busting paths.
  const kit = helpers.kitPoster({ _id: 'abc', fightId: fight, affiliateId: kelise, sha256: 'f'.repeat(64), contentType: 'image/png', qrLink: 'x', qrTarget: 'league' });
  assert(kit.imagePath.startsWith(`/api/affiliates/me/promotions/${fight}/custom-poster/image?v=`));
  assert(kit.publicImagePath.startsWith(`/api/public/affiliate-posters/${fight}/${kelise}/image?v=`));
  assert.strictEqual(helpers.kitPoster(null), null);

  console.log('affiliate personalized poster tests passed');
})().catch((error) => { console.error(error); process.exit(1); });
