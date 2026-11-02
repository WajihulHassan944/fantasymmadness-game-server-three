'use strict';
// FANTASY MMADNESS fight posters, generated server-side from VERIFIED contests only,
// in the owner-approved style: PREDICT (red) THE FIGHT (white), official brand mark,
// verified fight facts, PLAY THIS FIGHT, PLAY • PREDICT • COMPETE. No prizes, fees or amounts.
//
// Artwork (see growth-fighter-artwork.js), fail closed:
//   fighter_photos   - approved original photo of EACH named fighter (exact-name match, provenance)
//   contest_artwork  - the contest's official matchup artwork
//   text             - neither: names only, flagged NEEDS ARTWORK (never a substitute image)
// Every image is placed WHOLE: uniform scale inside its frame, never cropped, recoloured,
// retouched or overlaid. Facts come only from the verified contest.
//
// QR: encodes the fight's canonical address (fighter-name address when the website serves
// it, else the working ID address) plus the poster's campaign tags. After rendering, the QR is
// DECODED from the final JPEG with an independent decoder (jsQR) and must equal that link, and
// the link must resolve on the live website to the same fight. Anything else = HOLD.
//
// Output: JPEG sRGB. "portrait" 1080x1350 (feed: Instagram/Facebook/X), "story" 1080x1920 (TikTok).
const crypto = require('crypto');
const path = require('path');
const QRCode = require('qrcode');
const { artPolicy, checkArtSource, fetchImage } = require('./growth-poster-studio-art');

let sharpLib = null;
const sharp = () => (sharpLib ||= require('sharp'));
let jsQR = null; try { jsQR = require('jsqr'); } catch { jsQR = null; }

const FONT_BOLD = path.join(__dirname, 'growth-assets', 'fonts', 'Poppins-Bold.ttf');
const FONT_REG = path.join(__dirname, 'growth-assets', 'fonts', 'Poppins-Regular.ttf');
const LOGO_URL = 'https://www.fantasymmadness.com/images/brand/fantasy-mmadness-main-logo-v23.jpg';
const SITE_HOST = 'www.fantasymmadness.com';
const BRAND = 'FANTASY MMADNESS';
const FORMATS = Object.freeze({ portrait: { width: 1080, height: 1350, use: ['instagram', 'facebook', 'x'] }, story: { width: 1080, height: 1920, use: ['tiktok'] } });
const COLORS = { bg: '#0a0a0e', panel: '#15151c', red: '#e10600', gold: '#f5c518', white: '#ffffff', grey: '#b9b9c6', dim: '#8a8a98' };
const SPORT_LABEL = { boxing: 'BOXING', 'mma-ufc': 'MMA / UFC', kickboxing: 'KICKBOXING', 'bare-knuckle': 'BARE-KNUCKLE', 'pro-wrestling': 'PRO WRESTLING' };
const RENDER_VERSION = 'p6';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clean = (s, n = 200) => String(s ?? '').replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// ---- facts (verified contest only) ------------------------------------------------------
function dayText(c) {
  const [y, m, d] = c.dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).toUpperCase();
}
function timeText(c) {
  if (c.timeTba || !c.matchTime || !c.timeZone) return null;
  const [y, m, d] = c.dateKey.split('-').map(Number);
  const [hh, mm] = c.matchTime.split(':').map(Number);
  const abbr = new Intl.DateTimeFormat('en-US', { timeZone: c.timeZone, timeZoneName: 'short' }).formatToParts(new Date(Date.UTC(y, m - 1, d, 12))).find((p) => p.type === 'timeZoneName')?.value || '';
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh >= 12 ? 'PM' : 'AM'}${abbr ? ' ' + abbr : ''}`;
}
function canonicalUrl(c) { return c.cleanUrl || c.contestUrl; }
function posterFacts(c, qrUrl) {
  const shown = canonicalUrl(c).replace(/^https:\/\//, '').replace(/[?#].*$/, '');
  return {
    sport: SPORT_LABEL[c.sport], fighterA: c.fighterA, fighterB: c.fighterB,
    event: c.eventName || null, date: dayText(c), time: timeText(c),
    where: [c.venue, c.city].filter(Boolean).join(' · ') || null,
    detail: [c.weightClass, c.maxRounds ? `${c.maxRounds} ROUNDS` : null, c.promotion].filter(Boolean).join(' · ') || null,
    qrUrl, shownUrl: shown.length > 72 ? SITE_HOST : shown,
  };
}
// The QR destination: the fight's canonical address, tagged as the poster QR.
function qrLink(c) {
  const u = new URL(canonicalUrl(c));
  u.searchParams.set('utm_source', 'fan_acquisition'); u.searchParams.set('utm_medium', 'partner_outreach');
  u.searchParams.set('utm_campaign', `combat_fans_gs_${c.sport.replace(/[^a-z0-9]+/g, '_')}`); u.searchParams.set('utm_content', 'poster_qr');
  return u.toString();
}

// ---- rendering ------------------------------------------------------------------------
async function textImage(markup, { width, size, bold = true, color = COLORS.white, align = 'centre', spacing = 0 }) {
  const font = bold ? FONT_BOLD : FONT_REG;
  const buf = await sharp()({ text: { text: `<span foreground="${color}" letter_spacing="${Math.round(spacing * 1024)}">${markup}</span>`, font: `${bold ? 'Poppins Bold' : 'Poppins'} ${size}`, fontfile: font, width, align, rgba: true, dpi: 72, wrap: 'word' } }).png().toBuffer();
  const m = await sharp()(buf).metadata();
  return { buffer: buf, width: m.width, height: m.height };
}
async function fitText(markup, { width, max, min, lines = 1, ...o }) {
  for (let size = max; size >= min; size -= 4) {
    const t = await textImage(markup, { width, size, ...o });
    if (t.height <= Math.ceil(size * 1.45 * lines) && t.width <= width) return { ...t, size };
  }
  return { ...(await textImage(markup, { width, size: min, ...o })), size: min };
}
function qrMatrix(url) {
  const q = QRCode.create(url, { errorCorrectionLevel: 'M' });
  return { size: q.modules.size, get: (r, c) => q.modules.get(r, c) === 1 };
}
async function qrImage(url, target) {
  const m = qrMatrix(url); const quiet = 4; const n = m.size + quiet * 2;
  const scale = Math.max(4, Math.floor(target / n)); const px = n * scale;
  const raw = Buffer.alloc(px * px * 3, 255);
  for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) if (m.get(r, c)) {
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) { const i = (((r + quiet) * scale + y) * px + (c + quiet) * scale + x) * 3; raw[i] = raw[i + 1] = raw[i + 2] = 0; }
  }
  return { buffer: await sharp()(raw, { raw: { width: px, height: px, channels: 3 } }).png().toBuffer(), px, scale, quiet, modules: m.size };
}
const rect = (w, h, fill, rx = 0, stroke = null) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="${stroke ? 2 : 0}" y="${stroke ? 2 : 0}" width="${w - (stroke ? 4 : 0)}" height="${h - (stroke ? 4 : 0)}" rx="${rx}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="3"` : ''}/></svg>`);
const circle = (d, fill) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}"><circle cx="${d / 2}" cy="${d / 2}" r="${d / 2 - 2}" fill="${fill}" stroke="#ffffff" stroke-width="4"/></svg>`);
// Whole image, uniformly scaled to fit the box (never cropped or altered).
async function placeWhole(buffer, box) {
  const scaled = await sharp()(buffer).rotate().resize({ width: box.width, height: box.height, fit: 'inside', withoutEnlargement: false, kernel: 'lanczos3' }).toColourspace('srgb').png().toBuffer();
  const m = await sharp()(scaled).metadata();
  return { input: scaled, top: box.top + Math.round((box.height - m.height) / 2), left: box.left + Math.round((box.width - m.width) / 2), width: m.width, height: m.height };
}

async function renderPoster({ contest, format = 'portrait', artwork = { mode: 'text' }, logo = null, qrUrl }) {
  const F = FORMATS[format]; if (!F) throw Error(`unknown poster format ${format}`);
  const story = format === 'story';
  const W = F.width; const H = F.height; const pad = 44; const inner = W - pad * 2;
  const facts = posterFacts(contest, qrUrl);
  const L = []; const layout = { format, width: W, height: H, mode: artwork.mode, images: [] };
  const center = (t, top) => { L.push({ input: t.buffer, top, left: Math.round((W - t.width) / 2) }); return top + t.height; };
  L.push({ input: rect(W, 12, COLORS.red), top: 0, left: 0 });
  // 1. official brand mark
  let y = 26;
  if (logo) {
    const lg = await sharp()(logo).resize({ width: story ? 560 : 480, height: story ? 130 : 104, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    const lm = await sharp()(lg).metadata();
    L.push({ input: lg, top: y, left: Math.round((W - lm.width) / 2) }); layout.logo = true; y += lm.height + 12;
  } else { y = center(await textImage(esc(BRAND), { width: inner, size: story ? 58 : 50, spacing: 3 }), y) + 8; layout.logo = false; }
  // 2. PREDICT (red) THE FIGHT (white)
  const head = await fitText(`<span foreground="${COLORS.red}">PREDICT</span> THE FIGHT`, { width: inner, max: story ? 112 : 96, min: 60 });
  y = center(head, y) + 6;
  // 3. sport + event chip
  const chipText = [facts.sport, facts.event].filter(Boolean).join('  ·  ');
  const chip = await fitText(esc(chipText), { width: inner - 60, max: story ? 34 : 30, min: 20, spacing: 1.5 });
  const chipW = chip.width + 44; const chipH = chip.height + 14;
  L.push({ input: rect(chipW, chipH, COLORS.red, chipH / 2), top: y, left: Math.round((W - chipW) / 2) });
  L.push({ input: chip.buffer, top: y + 7, left: Math.round((W - chip.width) / 2) }); y += chipH + 18;
  // bottom stack, measured first so the art takes the remaining height
  const dateLine = [facts.date, facts.time].filter(Boolean).join(' · ');
  const dateT = await fitText(esc(dateLine), { width: inner, max: story ? 40 : 34, min: 22 });
  const whereT = facts.where ? await fitText(esc(facts.where), { width: inner, max: story ? 32 : 28, min: 18, bold: false, color: COLORS.grey }) : null;
  const detailT = facts.detail ? await fitText(esc(facts.detail), { width: inner, max: story ? 28 : 24, min: 18, bold: false, color: COLORS.dim }) : null;
  const qr = await qrImage(qrUrl, story ? 300 : 236);
  const tagT = await textImage('PLAY  •  PREDICT  •  COMPETE', { width: inner, size: story ? 34 : 28, color: COLORS.white, spacing: 4 });
  const namesBelow = artwork.mode === 'contest_artwork';
  const namesT = namesBelow ? await fitText(`${esc(facts.fighterA)}  <span foreground="${COLORS.red}">VS</span>  ${esc(facts.fighterB)}`, { width: inner, max: story ? 70 : 60, min: 34, lines: 2 }) : null;
  const factsH = dateT.height + (whereT ? whereT.height + 6 : 0) + (detailT ? detailT.height + 6 : 0);
  const bottomH = (namesT ? namesT.height + 14 : 0) + factsH + 22 + qr.px + 22 + tagT.height + 34;
  const artTop = y; const artH = Math.max(260, H - bottomH - artTop - 10);
  layout.artBox = { top: artTop, left: pad, width: inner, height: artH };
  // 4. artwork
  if (artwork.mode === 'fighter_photos') {
    const gap = 26; const vs = story ? 150 : 128; const nameH = story ? 120 : 96;
    const panelW = Math.floor((inner - gap) / 2); const photoH = artH - nameH - 10;
    const [A, B] = artwork.fighters;
    for (const [i, f] of [[0, A], [1, B]]) {
      const left = pad + i * (panelW + gap);
      L.push({ input: rect(panelW, artH, COLORS.panel, 18), top: artTop, left });
      // the inner edge leaves room for the VS badge, so the badge never covers any part of a photo
      const keep = Math.ceil(vs / 2 - gap / 2) + 8;
      const placed = await placeWhole(f.buffer, { top: artTop + 10, left: left + 10 + (i === 1 ? keep : 0), width: panelW - 20 - keep, height: photoH - 10 });
      L.push({ input: placed.input, top: placed.top, left: placed.left });
      layout.images.push({ side: f.side, name: f.name, top: placed.top, left: placed.left, width: placed.width, height: placed.height, sourceWidth: f.width, sourceHeight: f.height, sha256: f.sha256 });
      const nm = await fitText(esc(f.name.toUpperCase()), { width: panelW - 24, max: story ? 50 : 42, min: 22, lines: 2 });
      L.push({ input: nm.buffer, top: artTop + photoH + Math.round((nameH - nm.height) / 2), left: left + Math.round((panelW - nm.width) / 2) });
    }
    // VS badge sits in the gap between the photo frames (never over a photo)
    const vsTop = artTop + Math.round(photoH / 2 - vs / 2); const vsLeft = Math.round(W / 2 - vs / 2);
    const vT = await textImage('VS', { width: vs, size: Math.round(vs * 0.42) });
    L.push({ input: circle(vs, COLORS.red), top: vsTop, left: vsLeft }); L.push({ input: vT.buffer, top: vsTop + Math.round((vs - vT.height) / 2), left: vsLeft + Math.round((vs - vT.width) / 2) });
    layout.vs = { top: vsTop, left: vsLeft, size: vs };
  } else if (artwork.mode === 'contest_artwork') {
    L.push({ input: rect(inner, artH, COLORS.panel, 18), top: artTop, left: pad });
    const placed = await placeWhole(artwork.contestArt.buffer, { top: artTop + 10, left: pad + 10, width: inner - 20, height: artH - 20 });
    L.push({ input: placed.input, top: placed.top, left: placed.left });
    layout.images.push({ side: 'matchup', top: placed.top, left: placed.left, width: placed.width, height: placed.height, sourceWidth: artwork.contestArt.width, sourceHeight: artwork.contestArt.height, sha256: artwork.contestArt.sha256 });
  } else {
    // No approved artwork: names only (never a substitute or generated image).
    L.push({ input: rect(inner, artH, COLORS.panel, 18), top: artTop, left: pad });
    const big = story ? 118 : 100;
    const a = await fitText(esc(facts.fighterA.toUpperCase()), { width: inner - 80, max: big, min: 44, lines: 2 });
    const v = await textImage('VS', { width: inner - 80, size: Math.round(big * 0.8), color: COLORS.red });
    const b = await fitText(esc(facts.fighterB.toUpperCase()), { width: inner - 80, max: big, min: 44, lines: 2 });
    let ty = artTop + Math.round((artH - (a.height + v.height + b.height + 24)) / 2);
    for (const t of [a, v, b]) { ty = center(t, ty) + 12; }
  }
  // 5. facts
  y = artTop + artH + 14;
  if (namesT) y = center(namesT, y) + 14;
  y = center(dateT, y) + 6;
  if (whereT) y = center(whereT, y) + 6;
  if (detailT) y = center(detailT, y) + 6;
  y += 16;
  // 6. QR + PLAY THIS FIGHT
  L.push({ input: qr.buffer, top: y, left: pad });
  layout.qr = { top: y, left: pad, px: qr.px, scale: qr.scale, quiet: qr.quiet, modules: qr.modules, url: qrUrl };
  const ctaW = inner - qr.px - 30; const cx = pad + qr.px + 30;
  const btnT = await fitText('PLAY THIS FIGHT', { width: ctaW - 40, max: story ? 58 : 50, min: 26 });
  const btnH = btnT.height + 34;
  const scanT = await textImage('SCAN THE CODE TO MAKE YOUR PICKS', { width: ctaW, size: story ? 24 : 20, color: COLORS.grey, align: 'left', spacing: 1 });
  const siteT = await fitText(esc(facts.shownUrl), { width: ctaW, max: story ? 26 : 22, min: 14, bold: false, color: COLORS.gold, align: 'left' });
  const blockH = btnH + 14 + scanT.height + 8 + siteT.height; let cy = y + Math.max(0, Math.round((qr.px - blockH) / 2));
  L.push({ input: rect(ctaW, btnH, COLORS.red, 14), top: cy, left: cx });
  L.push({ input: btnT.buffer, top: cy + Math.round((btnH - btnT.height) / 2), left: cx + Math.round((ctaW - btnT.width) / 2) }); cy += btnH + 14;
  L.push({ input: scanT.buffer, top: cy, left: cx }); cy += scanT.height + 8;
  L.push({ input: siteT.buffer, top: cy, left: cx });
  y += qr.px + 22;
  // 7. tagline + brand bar
  center(tagT, y);
  L.push({ input: rect(W, 12, COLORS.red), top: H - 12, left: 0 });
  const out = await sharp()({ create: { width: W, height: H, channels: 3, background: COLORS.bg } }).composite(L).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
  return { buffer: out, layout, facts };
}

// ---- verification of the FINAL rendered image -----------------------------------------------------
// Decodes the QR code from the finished JPEG with jsQR (independent of the encoder).
async function decodeQr(jpeg) {
  if (!jsQR) return { ok: false, reason: 'qr_decoder_unavailable' };
  const { data, info } = await sharp()(jpeg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const r = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height, { inversionAttempts: 'dontInvert' });
  return r ? { ok: true, text: r.data } : { ok: false, reason: 'qr_not_decodable' };
}
// The decoded link must open the same fight on the live website.
async function verifyDestination(fetchImpl, url, contest) {
  const want = new URL(canonicalUrl(contest)); const idPath = new URL(contest.contestUrl).pathname;
  let r; try { r = await fetchImpl(url, { method: 'GET', redirect: 'follow', headers: { Accept: 'text/html' } }); } catch (e) { return { ok: false, reason: `destination_unreachable: ${clean(e.message, 120)}` }; }
  if (!r || !r.ok) return { ok: false, reason: `destination_http_${r ? r.status : 'none'}`, status: r?.status ?? null };
  let final; try { final = new URL(r.url || url); } catch { final = new URL(url); }
  const samePage = final.hostname === SITE_HOST && (final.pathname === want.pathname || final.pathname === idPath);
  return samePage ? { ok: true, status: r.status, finalUrl: `${final.origin}${final.pathname}` } : { ok: false, reason: 'destination_is_a_different_page', status: r.status, finalUrl: `${final.origin}${final.pathname}` };
}

// ---- studio: generate, verify, store, serve ----------------------------------------------------------
function createPosterStudio({ col, fetchImpl = globalThis.fetch, publicOrigin, env = {}, logoUrl = LOGO_URL, artwork = null }) {
  const policy = artPolicy(env);
  const origin = String(publicOrigin || '').replace(/\/+$/, '');
  const library = artwork || require('./growth-fighter-artwork').createArtworkLibrary({ col, fetchImpl, env });
  let logoCache = null;
  async function logo() {
    if (logoCache && logoCache.at > Date.now() - 6 * 3600000) return logoCache.buffer;
    const r = await fetchImage(fetchImpl, logoUrl, { maxBytes: 4 * 1024 * 1024 }).catch(() => ({ ok: false }));
    logoCache = { at: Date.now(), buffer: r.ok ? r.buffer : null }; return logoCache.buffer;
  }
  const urlFor = (id) => `${origin}/api/growth/posters/${id}.jpg`;
  const provenance = (sel) => ({
    mode: sel.mode, needsArtwork: sel.needsArtwork, missing: sel.missing, problems: sel.problems.slice(0, 10),
    used: sel.mode !== 'text',
    fighters: sel.fighters.map(({ buffer, ...f }) => f),
    contestArt: sel.contestArt ? (({ buffer, ...x }) => x)(sel.contestArt) : null,
    // short summary used by the console and the API contract
    reason: sel.mode === 'text' ? (sel.problems.find((p) => /blocked_by_owner/.test(p)) ? 'artwork_blocked_by_owner' : 'needs_artwork') : null,
    basis: sel.mode === 'fighter_photos' ? sel.fighters.map((f) => `${f.name}: ${f.basis}`).join(' | ') : sel.contestArt?.basis || null,
    url: sel.contestArt?.url || null,
  });
  async function ensureForDraft(draft, { now = new Date(), force = false } = {}) {
    const c = draft.contest;
    if (!c || !c.id || !draft.contestFingerprint) return { ok: false, reason: 'not_a_verified_contest_campaign' };
    const contestBlocked = await col.artRights.findOne({ contestId: c.id, status: 'blocked' });
    const sel = await library.select(c, { contestBlocked });
    const qrUrl = qrLink(c);
    const artKey = sel.mode === 'fighter_photos' ? sel.fighters.map((f) => f.sha256).join('+') : sel.contestArt?.sha256 || 'text';
    const key = sha([RENDER_VERSION, draft.id, draft.contestFingerprint, canonicalUrl(c), artKey].join('|')).slice(0, 20);
    const out = {}; const holds = []; let qr = null;
    for (const format of Object.keys(FORMATS)) {
      const id = `${key}-${format}`;
      let have = !force && await col.posters.findOne({ id }, { projection: { bytes: 0 } });
      if (!have) {
        const r = await renderPoster({ contest: c, format, artwork: sel, logo: await logo(), qrUrl });
        const dec = await decodeQr(r.buffer);
        const doc = { id, draftId: draft.id, contestId: c.id, contestFingerprint: draft.contestFingerprint, format, width: FORMATS[format].width, height: FORMATS[format].height,
          bytes: r.buffer, size: r.buffer.length, sha256: sha(r.buffer), contentType: 'image/jpeg', art: provenance(sel), layout: r.layout, facts: r.facts, qrUrl,
          qrDecoded: dec.ok ? dec.text : null, qrDecodeError: dec.ok ? null : dec.reason, renderVersion: RENDER_VERSION, createdAt: now.toISOString() };
        await col.posters.updateOne({ id }, { $setOnInsert: doc }, { upsert: true });
        have = doc;
      }
      if (have.qrDecoded !== qrUrl) holds.push(`${format}: ${have.qrDecoded ? 'qr_decodes_to_a_different_link' : have.qrDecodeError || 'qr_not_verified'}`);
      out[format] = { id, url: urlFor(id), width: have.width, height: have.height, qrDecoded: have.qrDecoded || null };
    }
    const dest = await verifyDestination(fetchImpl, qrUrl, c);
    if (!dest.ok) holds.push(dest.reason);
    qr = { encoded: qrUrl, decodedPortrait: out.portrait.qrDecoded, decodedStory: out.story.qrDecoded, decodedMatches: holds.every((h) => !/qr_/.test(h)), destination: dest, checkedAt: now.toISOString() };
    const art = provenance(sel);
    const poster = { portrait: { id: out.portrait.id, url: out.portrait.url, width: out.portrait.width, height: out.portrait.height }, story: { id: out.story.id, url: out.story.url, width: out.story.width, height: out.story.height },
      art, qrUrl, qr, status: holds.length ? 'hold' : 'ready', holdReasons: holds, needsArtwork: art.needsArtwork, generatedAt: now.toISOString(), renderVersion: RENDER_VERSION, sourceSig: sourceSig(c) };
    await col.drafts.updateOne({ id: draft.id }, { $set: { poster } });
    await col.posters.updateMany({ draftId: draft.id, id: { $nin: [out.portrait.id, out.story.id] }, withdrawnAt: { $exists: false } }, { $set: { withdrawnAt: now.toISOString() } });
    return { ok: true, poster };
  }
  async function getImage(id) {
    if (!/^[a-f0-9]{20}-(portrait|story)$/.test(String(id))) return null;
    const p = await col.posters.findOne({ id, withdrawnAt: { $exists: false } });
    if (!p) return null;
    const b = p.bytes; return { buffer: Buffer.isBuffer(b) ? b : Buffer.from(b.buffer || b), sha256: p.sha256, contentType: p.contentType };
  }
  async function setArtRights(contestId, { status, note, admin, now = new Date() }) {
    if (!['blocked', 'allowed'].includes(status)) return { ok: false, reason: 'status_must_be_blocked_or_allowed' };
    if (status === 'blocked' && !clean(note)) return { ok: false, reason: 'reason_required' };
    if (status === 'allowed') await col.artRights.deleteMany({ contestId: clean(contestId, 80) });
    else await col.artRights.updateOne({ contestId: clean(contestId, 80) }, { $set: { contestId: clean(contestId, 80), status, note: clean(note, 300), by: clean(admin, 120), at: now.toISOString() } }, { upsert: true });
    return { ok: true };
  }
  return { ensureForDraft, getImage, setArtRights, policy, urlFor, library, decoderAvailable: Boolean(jsQR) };
}

// Which published images could feed this contest's poster (changes => regenerate).
const sourceSig = (c) => sha(JSON.stringify([c?.posterUrl || null, ...['a', 'b'].map((k) => (c?.fighterPhotos?.[k] || []).map((x) => `${x.source}:${x.url}`))])).slice(0, 16);
// A poster is current when this renderer made it for the draft's current link and images.
const posterIsCurrent = (d) => Boolean(d.poster?.portrait && d.poster?.story && d.poster.renderVersion === RENDER_VERSION && d.poster.qrUrl === qrLink(d.contest) && d.poster.sourceSig === sourceSig(d.contest));

module.exports = { createPosterStudio, renderPoster, decodeQr, verifyDestination, checkArtSource, artPolicy, fetchImage, qrLink, qrMatrix, posterFacts, canonicalUrl, posterIsCurrent, sourceSig, FORMATS, LOGO_URL, RENDER_VERSION, decoderAvailable: () => Boolean(jsQR) };
