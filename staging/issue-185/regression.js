'use strict';

// Isolated regression checks run after the Issue #185 E2E on the combined
// test branch: login (player, affiliate, owner), token boundaries, payment
// safety (no gateway reachable, nothing can be charged), the FM COIN paid-entry
// flow with affiliate attribution, idempotency, insufficient funds, the general
// fight-poster upload and image conversion. Staging database and loopback only.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const sharp = require('sharp');
const { MongoClient, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');

const API = process.env.STAGING_API || 'http://127.0.0.1:5055';
const OUT = path.resolve(process.env.STAGING_OUT_DIR || path.join(__dirname, 'out'));
const ctx = JSON.parse(fs.readFileSync(path.join(OUT, 'e2e-context.json'), 'utf8'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name: `[regression] ${name}`, ok: Boolean(ok), detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function api(method, route, { token, json, form, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let body;
  if (json) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const response = await fetch(`${API}${route}`, { method, headers: h, body });
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await response.json().catch(() => ({})) : Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, body: payload };
}

async function main() {
  if (!/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(process.env.MONGODB_URI || '')) throw new Error('Refusing: staging database must be local.');
  const client = await MongoClient.connect(process.env.MONGODB_URI);
  const db = client.db();
  const password = 'Staging-Regression-185!';
  const hash = await bcrypt.hash(password, 10);
  const stamp = Date.now();

  // ---- Login --------------------------------------------------------------
  const player = { _id: new ObjectId(), firstName: 'Reg', lastName: 'Player', playerName: `regplayer${stamp}`, email: `reg.player.${stamp}@fmm-staging.test`, password: hash, verified: true, tokens: '500', dateOfBirth: new Date('1990-05-05'), residenceState: 'NV', createdAt: new Date() };
  const broke = { ...player, _id: new ObjectId(), playerName: `regbroke${stamp}`, email: `reg.broke.${stamp}@fmm-staging.test`, tokens: '0' };
  const unverified = { ...player, _id: new ObjectId(), playerName: `regunver${stamp}`, email: `reg.unverified.${stamp}@fmm-staging.test`, verified: false };
  await db.collection('users').insertMany([player, broke, unverified]);
  await db.collection('affiliates').updateOne({ _id: new ObjectId(ctx.kelise) }, { $set: { password: hash } });
  await db.collection('admins').insertOne({ email: `owner.${stamp}@fmm-staging.test`, password: hash, createdAt: new Date() });

  const login = await api('POST', '/login', { json: { email: player.email, password } });
  const playerToken = login.body?.token;
  check('Player login succeeds with the right password', login.status === 200 && playerToken && jwt.decode(playerToken)?.scope === 'player', `HTTP ${login.status}`);
  const badLogin = await api('POST', '/login', { json: { email: player.email, password: 'wrong-password' } });
  check('Player login refused with a wrong password', badLogin.status === 400, `HTTP ${badLogin.status}`);
  const unverifiedLogin = await api('POST', '/login', { json: { email: unverified.email, password } });
  check('Unverified player cannot log in', unverifiedLogin.status === 403, `HTTP ${unverifiedLogin.status}`);
  const injection = await api('POST', '/login', { json: { email: { $ne: null }, password } });
  check('Login rejects NoSQL operator injection', injection.status !== 200, `HTTP ${injection.status}`);
  const affLogin = await api('POST', '/loginAffiliate', { json: { email: `kelise.davis@fmm-staging.test`, password } });
  check('Affiliate (Kelise) login succeeds', affLogin.status === 200 && jwt.decode(affLogin.body?.token)?.scope === 'affiliate', `HTTP ${affLogin.status}`);
  const adminLogin = await api('POST', '/admin/login', { json: { email: `owner.${stamp}@fmm-staging.test`, password } });
  check('Owner/admin login succeeds', adminLogin.status === 200 && adminLogin.body?.token, `HTTP ${adminLogin.status}`);

  // Token boundaries.
  const kitWithPlayer = await api('GET', `/api/affiliates/me/promotions/${ctx.fightId}/share`, { token: playerToken });
  check('Player token cannot open an affiliate kit', kitWithPlayer.status === 403, `HTTP ${kitWithPlayer.status}`);
  const adminWithPlayer = await api('GET', `/api/admin/affiliate-posters/${ctx.approvedPosterId}`, { token: playerToken });
  check('Player token cannot use owner routes', adminWithPlayer.status === 401, `HTTP ${adminWithPlayer.status}`);
  const adminWithReal = await api('GET', `/api/admin/affiliate-posters/${ctx.approvedPosterId}`, { token: adminLogin.body?.token });
  check('Logged-in owner token works on owner routes', adminWithReal.status === 200 && adminWithReal.body?.poster?.status === 'approved', `HTTP ${adminWithReal.status}`);
  const kitWithLoginToken = await api('GET', `/api/affiliates/me/promotions/${ctx.fightId}/share`, { token: affLogin.body?.token });
  check('Kelise\'s real login token shows her personalized poster', kitWithLoginToken.body?.creative?.personalizedPoster?.sha256 === ctx.approvedSha256, kitWithLoginToken.body?.creative?.personalizedPoster?.sha256);

  // ---- Payment safety (no real gateway in staging) -------------------------
  const acceptJs = await api('GET', '/api/checkout/accept-js-config');
  check('Card checkout reports the gateway as not configured (no live gateway reachable)', acceptJs.status === 503 && acceptJs.body?.code === 'AUTHORIZE_NET_NOT_CONFIGURED', `HTTP ${acceptJs.status} ${acceptJs.body?.code}`);
  const coinOrder = await api('POST', '/api/checkout/coin-orders', { token: playerToken, json: { packageId: 'starter', email: player.email } });
  check('Coin purchase is refused safely (nothing charged)', [403, 503].includes(coinOrder.status), `HTTP ${coinOrder.status} ${coinOrder.body?.code || ''}`);

  // ---- Paid FM COIN entry with affiliate attribution ------------------------
  const predictions = [{ round: 1, fighterOneEstimate: 'HP', fighterTwoEstimate: 'LP' }];
  const entry = await api('POST', `/api/fights/${ctx.fightId}/entries`, { token: playerToken, json: { predictions, referralAffiliateId: ctx.kelise }, headers: { 'Idempotency-Key': `reg-${stamp}` } });
  check('Paid entry (100 FM COINS) succeeds', entry.status === 201 && entry.body?.entryFeeCharged === 100, `HTTP ${entry.status} ${JSON.stringify(entry.body).slice(0, 200)}`);
  const after = await db.collection('users').findOne({ _id: player._id });
  check('Wallet charged exactly once: 500 -> 400', Number(after.tokens) === 400, String(after.tokens));
  const repeat = await api('POST', `/api/fights/${ctx.fightId}/entries`, { token: playerToken, json: { predictions, referralAffiliateId: ctx.kelise }, headers: { 'Idempotency-Key': `reg-${stamp}` } });
  const afterRepeat = await db.collection('users').findOne({ _id: player._id });
  check('Repeated entry is not charged twice', repeat.status === 200 && Number(afterRepeat.tokens) === 400, `HTTP ${repeat.status} balance ${afterRepeat.tokens}`);
  let ledgerRow = null;
  for (const { name } of await db.listCollections().toArray()) {
    ledgerRow = await db.collection(name).findOne({ userId: player._id, type: 'FIGHT_ENTRY' });
    if (ledgerRow) break;
  }
  check('Coin ledger records the entry fee', ledgerRow && ledgerRow.amount === -100 && ledgerRow.balanceAfter === 400, ledgerRow ? `${ledgerRow.amount} -> ${ledgerRow.balanceAfter}` : 'no ledger row');
  check('Paid entry is credited to Kelise (affiliate attribution)', String(ledgerRow?.metadata?.referralAffiliateId || '') === ctx.kelise, String(ledgerRow?.metadata?.referralAffiliateId));
  const brokeToken = jwt.sign({ id: String(broke._id), scope: 'player' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const brokeEntry = await api('POST', `/api/fights/${ctx.fightId}/entries`, { token: brokeToken, json: { predictions } });
  const brokeAfter = await db.collection('users').findOne({ _id: broke._id });
  check('Entry refused with insufficient FM COINS (no charge)', brokeEntry.status === 402 && Number(brokeAfter.tokens) === 0, `HTTP ${brokeEntry.status}`);

  // ---- Image processing outside the personalized poster --------------------
  const otherFight = new ObjectId();
  await db.collection('matches').insertOne({ _id: otherFight, matchFighterA: 'Other A', matchFighterB: 'Other B', matchType: 'LIVE', matchStatus: 'Scheduled', matchDate: new Date(Date.now() + 864e6), matchTime: '20:00', matchTokens: 0, pot: 0, createdAt: new Date() });
  const general = await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#224488' } }).jpeg().toBuffer();
  const form = new FormData(); form.append('poster', new Blob([general], { type: 'image/jpeg' }), 'general.jpg');
  const upload = await api('POST', `/api/admin/fights/${otherFight}/social-poster`, { token: adminLogin.body?.token, form });
  const otherDoc = await db.collection('matches').findOne({ _id: otherFight });
  check('General fight poster upload still works (other fight)', [200, 201].includes(upload.status) && /^http:\/\/127\.0\.0\.1:9187\//.test(otherDoc?.fightPosterImage || ''), `HTTP ${upload.status} ${otherDoc?.fightPosterImage}`);
  const kitAfter = await api('GET', `/api/affiliates/me/promotions/${ctx.fightId}/share`, { token: affLogin.body?.token });
  check('Kelise\'s poster unaffected by another fight\'s upload', kitAfter.body?.creative?.personalizedPoster?.sha256 === ctx.approvedSha256);
  const jpeg = await api('GET', `/api/public/affiliate-posters/${ctx.fightId}/${ctx.kelise}/image?format=jpeg`);
  const meta = Buffer.isBuffer(jpeg.body) ? await sharp(jpeg.body).metadata().catch(() => ({})) : {};
  const original = await api('GET', `/api/affiliates/me/promotions/${ctx.fightId}/custom-poster/image`, { token: affLogin.body?.token });
  const originalMeta = Buffer.isBuffer(original.body) ? await sharp(original.body).metadata() : {};
  check('JPEG conversion keeps the poster size', meta.format === 'jpeg' && meta.width === originalMeta.width && meta.height === originalMeta.height, `${meta.format} ${meta.width}x${meta.height} vs ${originalMeta.width}x${originalMeta.height}`);
  check('Exact poster bytes still served to Kelise', sha(original.body) === ctx.approvedSha256);

  // ---- sharp coverage: JPEG, WebP and a rotated phone photo (EXIF) ---------
  const { readQr } = require('../../affiliate-custom-poster');
  const adminToken = adminLogin.body?.token;
  const controlLink = `https://www.fantasymmadness.com/league/${ctx.control}?fightId=${ctx.fightId}`;
  const base = sharp({ create: { width: 1000, height: 1400, channels: 3, background: '#663311' } });
  const variants = [
    ['JPEG', await base.clone().jpeg({ quality: 90 }).toBuffer(), 'image/jpeg', 'jpeg', { width: 1000, height: 1400 }],
    ['WebP', await base.clone().webp({ quality: 90 }).toBuffer(), 'image/webp', 'webp', { width: 1000, height: 1400 }],
    ['rotated phone photo (EXIF 6)', await sharp({ create: { width: 1400, height: 1000, channels: 3, background: '#335511' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer(), 'image/jpeg', 'jpeg', { width: 1000, height: 1400 }],
  ];
  for (const [label, bytes, type, format, size] of variants) {
    const f = new FormData(); f.append('fightId', ctx.fightId); f.append('poster', new Blob([bytes], { type }), `control.${format === 'jpeg' ? 'jpg' : format}`);
    const src = await api('POST', '/api/admin/affiliate-posters/sources', { token: adminToken, form: f });
    const place = await api('POST', '/api/admin/affiliate-posters/suggest-placement', { token: adminToken, json: { fightId: ctx.fightId, sourceId: src.body?.source?.id, sourcePosterUrl: src.body?.source?.url, affiliateId: ctx.control } });
    const prev = await api('POST', '/api/admin/affiliate-posters/preview', { token: adminToken, json: { fightId: ctx.fightId, audience: 'one', affiliateId: ctx.control, sourceId: src.body?.source?.id, sourcePosterUrl: src.body?.source?.url, qr: place.body?.placement || { x: 0.7, y: 0.75, scale: 0.22 }, promo: { title: 'format test' } } });
    const img = prev.body?.poster ? await api('GET', `/api/admin/affiliate-posters/${prev.body.poster.id}/image`, { token: adminToken }) : { body: Buffer.alloc(0) };
    const m = Buffer.isBuffer(img.body) && img.body.length ? await sharp(img.body).metadata() : {};
    const q = m.format ? await readQr(sharp, img.body, { left: prev.body.poster.qr.left - 20, top: prev.body.poster.qr.top - 20, size: prev.body.poster.qr.size + 40 }) : null;
    check(`Poster pipeline (${label}): upload, auto-place, build`, src.status === 201 && place.status === 200 && prev.status === 201, `HTTP ${src.status}/${place.status}/${prev.status} ${prev.body?.message || ''}`);
    check(`Poster pipeline (${label}): keeps ${format} format and upright size`, m.format === format && m.width === size.width && m.height === size.height, `${m.format} ${m.width}x${m.height}`);
    check(`Poster pipeline (${label}): QR opens the affiliate's league`, q?.data === controlLink, q?.data);
  }

  await client.close();
}

main().catch((error) => check('Regression script completed', false, error.stack || error.message))
  .finally(() => {
    const file = path.join(OUT, 'e2e-results.json');
    const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    fs.writeFileSync(path.join(OUT, 'regression-results.json'), JSON.stringify(results, null, 2));
    fs.writeFileSync(file, JSON.stringify([...existing, ...results], null, 2));
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} regression checks passed`);
    process.exitCode = failed.length ? 1 : 0;
  });
