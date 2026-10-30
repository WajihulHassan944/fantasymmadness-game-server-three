'use strict';

// Issue #185 end-to-end staging test (API + received email).
// Runs against the isolated staging server (isolation-preload.js), a local
// staging database and a local Mailpit test mailbox. Nothing here can reach a
// real affiliate, the live database or payment processing.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const QRCode = require('qrcode');
const { readQr, affiliateFromLink } = require('../../affiliate-custom-poster');

const API = process.env.STAGING_API || 'http://127.0.0.1:5055';
const MAILPIT = process.env.STAGING_MAILPIT || 'http://127.0.0.1:8025';
const MEDIA = `http://127.0.0.1:${process.env.STAGING_MEDIA_PORT || 9187}`;
const OUT = path.resolve(process.env.STAGING_OUT_DIR || path.join(__dirname, 'out'));
const MAILBOX_DOMAIN = 'fmm-staging.test';
fs.mkdirSync(path.join(OUT, 'media', 'seed'), { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ids = {
  fight: new ObjectId(),
  kelise: new ObjectId(),
  control: new ObjectId(),
  marcus: new ObjectId(),
};
const email = { kelise: `kelise.davis@${MAILBOX_DOMAIN}`, control: `control.affiliate@${MAILBOX_DOMAIN}`, marcus: `marcus.reed@${MAILBOX_DOMAIN}` };
const leagueLink = (affiliateId) => `https://www.fantasymmadness.com/league/${affiliateId}?fightId=${ids.fight}`;

const adminToken = () => jwt.sign({ id: 'staging-owner', email: 'owner@fmm-staging.test', role: 'admin' }, process.env.JWT_SECRET_ADMIN, { expiresIn: '1h' });
const affiliateToken = (id, mail) => jwt.sign({ id: String(id), email: mail, scope: 'affiliate' }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function api(method, route, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const response = await fetch(`${API}${route}`, { method, headers, body });
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await response.json().catch(() => ({})) : Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, body: payload };
}

async function posterArt(label, colour, qrLink) {
  const width = 1080; const height = 1350;
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="${colour}"/>
    <text x="60" y="190" font-family="sans-serif" font-size="78" font-weight="bold" fill="#fff">ELIF NUR TURHAN</text>
    <text x="60" y="300" font-family="sans-serif" font-size="64" fill="#ffcb57">vs</text>
    <text x="60" y="410" font-family="sans-serif" font-size="78" font-weight="bold" fill="#fff">ALYCIA BAUMGARDNER</text>
    <text x="60" y="560" font-family="sans-serif" font-size="46" fill="#fff">${label}</text>
  </svg>`);
  const layers = [];
  if (qrLink) {
    const qr = await QRCode.toBuffer(qrLink, { type: 'png', errorCorrectionLevel: 'M', margin: 2, width: 300 });
    layers.push({ input: { create: { width: 340, height: 340, channels: 3, background: '#ffffff' } }, left: 690, top: 950 });
    layers.push({ input: qr, left: 710, top: 970 });
  }
  return sharp(svg).composite(layers).png().toBuffer();
}

async function mailpitMessages() {
  const response = await fetch(`${MAILPIT}/api/v1/messages?limit=50`);
  return (await response.json()).messages || [];
}

async function main() {
  for (const name of ['JWT_SECRET', 'JWT_SECRET_ADMIN', 'MONGODB_URI']) if (!process.env[name]) throw new Error(`${name} is required`);
  if (!/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(process.env.MONGODB_URI)) throw new Error('Refusing: staging database must be local.');
  await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });

  // ---- Seed the isolated staging database ---------------------------------
  const generalBytes = await posterArt('GENERAL FIGHT POSTER', '#1d2a55', '');
  fs.writeFileSync(path.join(OUT, 'media', 'seed', 'general.png'), generalBytes);
  const generalUrl = `${MEDIA}/seed/general.png`;
  const client = await MongoClient.connect(process.env.MONGODB_URI);
  const db = client.db();
  const future = new Date(Date.now() + 14 * 86400000);
  await db.collection('matches').insertOne({
    _id: ids.fight, matchFighterA: 'Elif Nur Turhan', matchFighterB: 'Alycia Baumgardner', matchName: 'Turhan vs Baumgardner (staging)',
    matchCategory: 'Boxing', matchCategoryTwo: 'Boxing', matchType: 'LIVE', matchStatus: 'Scheduled', matchDate: future,
    matchDateKey: future.toISOString().slice(0, 10), matchTime: '20:00', eventTimeZone: 'America/New_York', matchTokens: 100, pot: 1000,
    fightPosterImage: generalUrl, promotionBackground: generalUrl, createdAt: new Date(),
  });
  const affiliate = (id, first, last, mail) => ({ _id: id, firstName: first, lastName: last, playerName: `${first}${last}`, leagueName: `${first} ${last} League`, email: mail, verified: true, usersJoined: [], createdAt: new Date() });
  await db.collection('affiliates').insertMany([
    affiliate(ids.kelise, 'Kelise', 'Davis', email.kelise),
    affiliate(ids.control, 'Control', 'Affiliate', email.control),
    affiliate(ids.marcus, 'Marcus', 'Reed', email.marcus),
  ]);
  const admin = adminToken();
  const keliseToken = affiliateToken(ids.kelise, email.kelise);
  const controlToken = affiliateToken(ids.control, email.control);

  // ---- Owner: upload Kelise's personalized poster (her QR already on it) --
  const keliseArt = await posterArt('KELISE DAVIS LEAGUE · SCAN TO JOIN', '#5a1033', leagueLink(ids.kelise));
  fs.writeFileSync(path.join(OUT, 'kelise-uploaded-poster.png'), keliseArt);
  const upload = async (bytes, name) => {
    const form = new FormData();
    form.append('fightId', String(ids.fight));
    form.append('poster', new Blob([bytes], { type: 'image/png' }), name);
    return api('POST', '/api/admin/affiliate-posters/sources', { token: admin, form });
  };
  const uploaded = await upload(keliseArt, 'kelise-poster.png');
  check('Owner upload of Kelise poster saved (one affiliate only)', uploaded.status === 201 && uploaded.body?.source?.id, `HTTP ${uploaded.status}`);
  const source = uploaded.body.source;
  const fightAfterUpload = await db.collection('matches').findOne({ _id: ids.fight });
  check('General fight poster unchanged by the one-affiliate upload', fightAfterUpload.fightPosterImage === generalUrl, fightAfterUpload.fightPosterImage);

  const placement = await api('POST', '/api/admin/affiliate-posters/suggest-placement', { token: admin, json: { fightId: String(ids.fight), sourceId: source.id, sourcePosterUrl: source.url, affiliateId: String(ids.kelise) } });
  check('QR placement finds the QR already printed on her poster', placement.status === 200 && placement.body?.placement?.reason === 'existing-qr', JSON.stringify(placement.body?.placement || placement.body));

  // A poster carrying ANOTHER affiliate's QR must be refused for Kelise.
  const foreign = await upload(await posterArt('WRONG QR', '#333333', leagueLink(ids.marcus)), 'wrong.png');
  const foreignPreview = await api('POST', '/api/admin/affiliate-posters/preview', { token: admin, json: { fightId: String(ids.fight), audience: 'one', affiliateId: String(ids.kelise), sourceId: foreign.body?.source?.id, sourcePosterUrl: foreign.body?.source?.url, qr: { x: 0.64, y: 0.7, scale: 0.3 }, promo: { title: 'x' } } });
  check('Poster with another affiliate\'s QR is refused for Kelise', foreignPreview.status === 409, `HTTP ${foreignPreview.status} ${foreignPreview.body?.message || ''}`);

  // ---- Owner: preview (what the Fight Launch Deck shows) and approve -------
  const preview = await api('POST', '/api/admin/affiliate-posters/preview', { token: admin, json: {
    fightId: String(ids.fight), audience: 'one', affiliateId: String(ids.kelise), sourceId: source.id, sourcePosterUrl: source.url,
    qr: placement.body.placement, promo: { title: 'Elif Nur Turhan vs Alycia Baumgardner', event: 'Staging card', affiliateName: 'Kelise Davis', message: 'Join Kelise Davis League.' },
  } });
  check('Finished personalized poster preview built', preview.status === 201 && preview.body?.poster?.id, `HTTP ${preview.status} ${preview.body?.message || ''}`);
  const poster = preview.body.poster;
  check('Preview QR link is Kelise\'s league link for this fight', poster.qrLink === leagueLink(ids.kelise), poster.qrLink);
  const previewImage = await api('GET', `/api/admin/affiliate-posters/${poster.id}/image`, { token: admin });
  const previewSha = sha(previewImage.body);
  fs.writeFileSync(path.join(OUT, 'owner-preview-poster.png'), previewImage.body);
  check('Owner preview image bytes match the stored poster', previewSha === poster.sha256, previewSha);
  const approved = await api('POST', `/api/admin/affiliate-posters/${poster.id}/approve`, { token: admin });
  check('Owner approved the personalized poster', approved.status === 200 && approved.body?.poster?.status === 'approved', `HTTP ${approved.status}`);

  // ---- Affiliate kit (API) -------------------------------------------------
  const keliseKit = await api('GET', `/api/affiliates/me/promotions/${ids.fight}/share`, { token: keliseToken });
  const kitPoster = keliseKit.body?.creative?.personalizedPoster;
  check('Kelise kit names her personalized poster', keliseKit.status === 200 && kitPoster?.id === poster.id, JSON.stringify(kitPoster && { id: kitPoster.id, sha: kitPoster.sha256 }));
  const kitImage = kitPoster ? await api('GET', kitPoster.imagePath, { token: keliseToken }) : { body: Buffer.alloc(0) };
  check('Kelise kit image (Copy/Download/Share source) = approved poster', sha(kitImage.body) === previewSha, sha(kitImage.body));
  const publicImage = kitPoster ? await api('GET', kitPoster.publicImagePath) : { body: Buffer.alloc(0) };
  check('Public social-preview image = approved poster', sha(publicImage.body) === previewSha, sha(publicImage.body));
  const controlKit = await api('GET', `/api/affiliates/me/promotions/${ids.fight}/share`, { token: controlToken });
  check('Affiliate without a personalized poster gets the general poster', controlKit.status === 200 && controlKit.body?.creative?.personalizedPoster === null && controlKit.body?.creative?.fightPoster === generalUrl, controlKit.body?.creative?.fightPoster);
  const controlPublic = await api('GET', `/api/public/affiliate-posters/${ids.fight}/${ids.control}/image`);
  check('No personalized poster is served for the other affiliate', controlPublic.status === 404, `HTTP ${controlPublic.status}`);
  const keliseOtherAccess = await api('GET', `/api/affiliates/me/promotions/${ids.fight}/custom-poster/image`, { token: controlToken });
  check('Another affiliate cannot load Kelise\'s poster through the kit', keliseOtherAccess.status === 404, `HTTP ${keliseOtherAccess.status}`);

  // ---- Owner sends (no real affiliates: staging mailbox only) --------------
  const send = (to, extra = {}) => api('POST', '/send-email-affiliate', { token: admin, json: {
    email: to, subject: 'STAGING #185 · Turhan vs Baumgardner fight kit', launchFightId: String(ids.fight),
    message: 'Hi,\n\nElif Nur Turhan vs Alycia Baumgardner is ready for your league.\n\nOPEN YOUR FIGHT SHARE KIT: https://www.fantasymmadness.com/affiliate/fight-launch?fightId=' + ids.fight, ...extra } });
  // (a) The path that failed in production: the alert window without a poster reference.
  const sentAlert = await send(email.kelise);
  check('Send A (fight alert, no poster reference) accepted', sentAlert.status === 200, `HTTP ${sentAlert.status} ${sentAlert.body?.message || ''}`);
  // (b) The approved-campaign path with the explicit poster reference.
  const sentCampaign = await send(email.kelise, { customPosterId: poster.id });
  check('Send B (approved campaign) accepted', sentCampaign.status === 200, `HTTP ${sentCampaign.status} ${sentCampaign.body?.message || ''}`);
  const sentControl = await send(email.control);
  check('Send C (affiliate without personalized poster) accepted', sentControl.status === 200, `HTTP ${sentControl.status}`);
  const misdirected = await send(email.control, { customPosterId: poster.id });
  check('Kelise\'s poster refused for a different affiliate (nothing sent)', misdirected.status === 409, `HTTP ${misdirected.status}`);

  // ---- Received mail (Mailpit test mailbox) --------------------------------
  let messages = [];
  for (let i = 0; i < 30 && messages.length < 3; i += 1) { messages = await mailpitMessages(); if (messages.length < 3) await sleep(500); }
  check('Exactly three messages received in the staging mailbox', messages.length === 3, String(messages.length));
  const received = [];
  for (const summary of messages) {
    const detail = await (await fetch(`${MAILPIT}/api/v1/message/${summary.ID}`)).json();
    const raw = Buffer.from(await (await fetch(`${MAILPIT}/api/v1/message/${summary.ID}/raw`)).arrayBuffer());
    const to = (detail.To || []).map((row) => row.Address.toLowerCase());
    const parts = [...(detail.Attachments || []), ...(detail.Inline || [])];
    const files = [];
    for (const part of parts) {
      const bytes = Buffer.from(await (await fetch(`${MAILPIT}/api/v1/message/${summary.ID}/part/${part.PartID}`)).arrayBuffer());
      files.push({ name: part.FileName, contentType: part.ContentType, contentId: part.ContentID, bytes });
    }
    received.push({ id: summary.ID, to, html: String(detail.HTML || ''), text: String(detail.Text || ''), files, raw });
  }
  const keliseMail = received.filter((mail) => mail.to.includes(email.kelise));
  const controlMail = received.filter((mail) => mail.to.includes(email.control));
  check('Kelise received both fight kit emails', keliseMail.length === 2, String(keliseMail.length));
  keliseMail.forEach((mail, index) => {
    fs.writeFileSync(path.join(OUT, `received-kelise-${index + 1}.eml`), mail.raw);
    const image = mail.files.find((file) => /^image\//.test(file.contentType));
    if (image) fs.writeFileSync(path.join(OUT, `received-kelise-${index + 1}-poster.${image.contentType.split('/')[1]}`), image.bytes);
    check(`Kelise email ${index + 1}: poster attached is byte-identical to the approved personalized poster`, image && sha(image.bytes) === previewSha, image ? sha(image.bytes) : 'no image attached');
    check(`Kelise email ${index + 1}: poster shown in the email body (cid)`, image && mail.html.includes(`cid:${image.contentId}`), image?.contentId);
    check(`Kelise email ${index + 1}: kit button opens her own kit`, mail.html.includes(`affiliate/fight-launch?fightId=${ids.fight}&amp;affiliateId=${ids.kelise}`) || mail.html.includes(`affiliate/fight-launch?fightId=${ids.fight}&affiliateId=${ids.kelise}`));
    check(`Kelise email ${index + 1}: general poster not used`, !mail.html.includes('/seed/general.png'));
  });
  check('Control affiliate received the general email (no personalized poster)', controlMail.length === 1 && !controlMail[0].files.some((file) => /^image\//.test(file.contentType)), controlMail[0] ? `${controlMail[0].files.length} attachments` : 'missing');
  if (controlMail[0]) fs.writeFileSync(path.join(OUT, 'received-control.eml'), controlMail[0].raw);

  // ---- QR in the RECEIVED poster: destination + referral attribution -------
  const receivedPoster = keliseMail[0]?.files.find((file) => /^image\//.test(file.contentType));
  const placed = poster.qr;
  const decoded = receivedPoster ? await readQr(sharp, receivedPoster.bytes, { left: placed.left - 30, top: placed.top - 30, size: placed.size + 60 }) : null;
  check('QR decoded from the received poster', Boolean(decoded?.data), decoded?.data);
  check('Received QR opens Kelise\'s own league for this fight', decoded?.data === leagueLink(ids.kelise), decoded?.data);
  const wholeImage = receivedPoster ? await readQr(sharp, receivedPoster.bytes) : null;
  check('Any QR found anywhere on the received poster credits Kelise', !wholeImage || affiliateFromLink(wholeImage.data)?.affiliateId === String(ids.kelise), wholeImage?.data);
  const credited = affiliateFromLink(decoded?.data);
  // The league page sends new fans to signup with referrer=<affiliate id from the link> and fight=<fight id>.
  const fan = `fan.${Date.now()}@${MAILBOX_DOMAIN}`;
  const register = await api('POST', '/register', { json: { firstName: 'Staging', lastName: 'Fan', playerName: `fan${Date.now()}`, email: fan, phone: '7755550100', password: 'Staging-Pass-185!', zipCode: '89501', isAgreed: true, isUSCitizen: true, referrerId: credited?.affiliateId, referredFightId: credited?.fightId } });
  const fanDoc = await db.collection('users').findOne({ email: fan });
  check('Signup from Kelise\'s QR records her as the referring affiliate', fanDoc && String(fanDoc.referredAffiliateId) === String(ids.kelise), `HTTP ${register.status} referredAffiliateId=${fanDoc?.referredAffiliateId}`);
  check('Signup from Kelise\'s QR records this fight', fanDoc && String(fanDoc.referredFightId) === String(ids.fight), String(fanDoc?.referredFightId));
  if (fanDoc) {
    await db.collection('users').updateOne({ _id: fanDoc._id }, { $set: { verified: true } });
    const fanToken = jwt.sign({ id: String(fanDoc._id), email: fan, scope: 'player' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const join = await api('POST', `/affiliate/${credited?.affiliateId}/join`, { token: fanToken, json: { fightId: credited?.fightId } });
    const league = await db.collection('affiliates').findOne({ _id: ids.kelise });
    check('Fan joins Kelise\'s league from the QR link', (league?.usersJoined || []).some((row) => String(row.userId) === String(fanDoc._id)), `HTTP ${join.status} ${join.body?.message || ''}`);
  }

  // ---- Fallback still intact ------------------------------------------------
  const fightAtEnd = await db.collection('matches').findOne({ _id: ids.fight });
  check('General fight poster still the original at the end', fightAtEnd.fightPosterImage === generalUrl);

  fs.writeFileSync(path.join(OUT, 'e2e-context.json'), JSON.stringify({ fightId: String(ids.fight), kelise: String(ids.kelise), control: String(ids.control), keliseToken, controlToken, approvedPosterId: poster.id, approvedSha256: previewSha, generalUrl, generalSha256: sha(generalBytes), keliseKitLink: (keliseMail[0]?.html.match(/https:\/\/www\.fantasymmadness\.com\/affiliate\/fight-launch\?[^"\s<]+/) || [''])[0].replace(/&amp;/g, '&'), keliseLeagueLink: leagueLink(ids.kelise) }, null, 2));
  await client.close();
}

main().catch((error) => { check('E2E script completed', false, error.stack || error.message); })
  .finally(() => {
    fs.writeFileSync(path.join(OUT, 'e2e-results.json'), JSON.stringify(results, null, 2));
    const failed = results.filter((row) => !row.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exitCode = failed.length ? 1 : 0;
  });
