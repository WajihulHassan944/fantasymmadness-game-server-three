'use strict';
// FANTASY MMADNESS fight posters, generated server-side from VERIFIED contests only.
//
// Rights rules (fail closed):
//   - Fighter artwork is used ONLY when it is the official artwork FANTASY MMADNESS
//     itself published on that contest (the public contest feed's poster fields), it is
//     hosted on a FANTASY MMADNESS asset host, it is a real image, and the owner has not
//     blocked it. Anything else -> a typographic poster with NO fighter imagery.
//   - The artwork is never cropped, recoloured, retouched or overlaid: it is scaled
//     uniformly (aspect ratio kept) and placed whole inside its frame. Belts, logos and
//     text inside the artwork are therefore exactly as published.
//   - No AI-generated likenesses, no stock fighter photos, no scraped images.
//   - Every fact on the poster comes from the verified contest (names, date, time,
//     venue, rounds). Nothing is invented: missing facts are simply left off.
//   - The QR code encodes the campaign's own contest link (fighter-name address when
//     the website serves it, otherwise the working ID address) with campaign tags.
//
// Output: JPEG, sRGB. "portrait" 1080x1350 (4:5: Instagram/Facebook/X feed),
//         "story" 1080x1920 (9:16: TikTok photo / Stories).
const crypto = require('crypto');
const path = require('path');
const QRCode = require('qrcode');

let sharpLib = null;
const sharp = () => (sharpLib ||= require('sharp'));

const FONT_BOLD = path.join(__dirname, 'growth-assets', 'fonts', 'Poppins-Bold.ttf');
const FONT_REG = path.join(__dirname, 'growth-assets', 'fonts', 'Poppins-Regular.ttf');
const LOGO_URL = 'https://www.fantasymmadness.com/images/brand/fantasy-mmadness-main-logo-v23.jpg';
const BRAND = 'FANTASY MMADNESS';
const FORMATS = Object.freeze({ portrait: { width: 1080, height: 1350, use: ['instagram', 'facebook', 'x'] }, story: { width: 1080, height: 1920, use: ['tiktok'] } });
const COLORS = { bg: '#0b0b10', panel: '#16161e', red: '#d6001c', gold: '#f5c518', white: '#ffffff', grey: '#b8b8c6' };
const SPORT_LABEL = { boxing: 'BOXING', 'mma-ufc': 'MMA / UFC', kickboxing: 'KICKBOXING', 'bare-knuckle': 'BARE-KNUCKLE', 'pro-wrestling': 'PRO WRESTLING' };
const ART_TYPES = /^image\/(jpeg|png|webp)$/i;
const MAX_ART_BYTES = 12 * 1024 * 1024;
const MIN_ART_SIDE = 300;
const RENDER_VERSION = 'p4';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clean = (s, n = 200) => String(s ?? '').replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// ---- artwork rights ------------------------------------------------------------------
// FANTASY MMADNESS asset hosts. Cloudinary is where the owner's admin uploads fight art;
// GROWTH_ART_CLOUDINARY_CLOUDS (comma list) can narrow it to the FMM cloud name(s).
function artPolicy(env = {}) {
  const clouds = String(env.GROWTH_ART_CLOUDINARY_CLOUDS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const extraHosts = String(env.GROWTH_ART_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h));
  return { clouds, hosts: ['www.fantasymmadness.com', 'fantasymmadness.com', ...extraHosts] };
}
function checkArtSource(contest, policy, block = null) {
  const url = contest?.posterUrl;
  if (!url) return { ok: false, reason: 'no_official_artwork_on_this_contest' };
  if (block) return { ok: false, reason: 'artwork_blocked_by_owner', note: block.note || null };
  let u; try { u = new URL(url); } catch { return { ok: false, reason: 'artwork_address_invalid' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'artwork_not_https' };
  const host = u.hostname.toLowerCase();
  if (host === 'res.cloudinary.com') {
    const m = u.pathname.match(/^\/([^/]+)\/image\/upload\//);
    if (!m) return { ok: false, reason: 'artwork_not_an_uploaded_image' };
    if (policy.clouds.length && !policy.clouds.includes(m[1].toLowerCase())) return { ok: false, reason: 'artwork_not_on_the_fantasy_mmadness_cloud' };
  } else if (!policy.hosts.includes(host)) return { ok: false, reason: 'artwork_host_not_a_fantasy_mmadness_asset_host' };
  return { ok: true, url, host, basis: `Official artwork published by FANTASY MMADNESS on this contest (${contest.posterField || 'contest poster'})` };
}

async function fetchImage(fetchImpl, url, { maxBytes = MAX_ART_BYTES } = {}) {
  let r; try { r = await fetchImpl(url, { headers: { Accept: 'image/jpeg,image/png,image/webp' }, redirect: 'error' }); } catch (e) { return { ok: false, reason: `artwork_unreachable: ${clean(e.message, 120)}` }; }
  if (!r || !r.ok) return { ok: false, reason: `artwork_http_${r ? r.status : 'none'}` };
  const type = String(r.headers.get('content-type') || '').split(';')[0].trim();
  if (!ART_TYPES.test(type)) return { ok: false, reason: `artwork_not_an_image (${type || 'unknown type'})` };
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length || buf.length > maxBytes) return { ok: false, reason: 'artwork_size_out_of_range' };
  let meta; try { meta = await sharp()(buf).metadata(); } catch { return { ok: false, reason: 'artwork_could_not_be_decoded' }; }
  if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < MIN_ART_SIDE) return { ok: false, reason: 'artwork_too_small' };
  return { ok: true, buffer: buf, type, width: meta.width, height: meta.height, sha256: sha(buf) };
}

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
function posterFacts(c, qrUrl) {
  const shown = (c.cleanUrl || c.contestUrl || '').replace(/^https:\/\//, '').replace(/[?#].*$/, '');
  return {
    sport: SPORT_LABEL[c.sport], fighterA: c.fighterA, fighterB: c.fighterB,
    event: c.eventName || null, date: dayText(c), time: timeText(c),
    where: [c.venue, c.city].filter(Boolean).join(' · ') || null,
    detail: [c.weightClass, c.maxRounds ? `${c.maxRounds} ROUNDS` : null, c.promotion].filter(Boolean).join(' · ') || null,
    qrUrl, shownUrl: shown.length > 72 ? 'www.fantasymmadness.com' : shown,
  };
}
// The QR destination: the campaign's contest link, tagged as the poster QR.
function qrLink(c) {
  const base = c.cleanUrl || c.contestUrl;
  const u = new URL(base);
  u.searchParams.set('utm_source', 'fan_acquisition'); u.searchParams.set('utm_medium', 'partner_outreach');
  u.searchParams.set('utm_campaign', `combat_fans_gs_${c.sport.replace(/[^a-z0-9]+/g, '_')}`); u.searchParams.set('utm_content', 'poster_qr');
  return u.toString();
}

// ---- rendering ------------------------------------------------------------------------
async function textImage(markup, { width, size, bold = true, color = COLORS.white, align = 'centre', spacing = 0 }) {
  const font = bold ? FONT_BOLD : FONT_REG;
  const img = sharp()({ text: { text: `<span foreground="${color}" letter_spacing="${spacing * 1024}">${markup}</span>`, font: `${bold ? 'Poppins Bold' : 'Poppins'} ${size}`, fontfile: font, width, align, rgba: true, dpi: 72, wrap: 'word' } });
  const buf = await img.png().toBuffer();
  const m = await sharp()(buf).metadata();
  return { buffer: buf, width: m.width, height: m.height };
}
// Largest size (<= max) at which the text fits on the given number of lines.
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
  const m = qrMatrix(url); const quiet = 3; const n = m.size + quiet * 2;
  const scale = Math.max(3, Math.floor(target / n)); const px = n * scale;
  const raw = Buffer.alloc(px * px * 3, 255);
  for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) if (m.get(r, c)) {
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) { const i = (((r + quiet) * scale + y) * px + (c + quiet) * scale + x) * 3; raw[i] = raw[i + 1] = raw[i + 2] = 0; }
  }
  return { buffer: await sharp()(raw, { raw: { width: px, height: px, channels: 3 } }).png().toBuffer(), px, scale, quiet, modules: m.size };
}
const rect = (w, h, fill, rx = 0) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${rx}" fill="${fill}"/></svg>`);

async function renderPoster({ contest, format = 'portrait', art = null, logo = null, qrUrl }) {
  const F = FORMATS[format]; if (!F) throw Error(`unknown poster format ${format}`);
  const W = F.width; const H = F.height; const pad = 44; const inner = W - pad * 2;
  const facts = posterFacts(contest, qrUrl);
  const layers = []; const layout = { format, width: W, height: H };
  // brand header
  layers.push({ input: rect(W, 10, COLORS.red), top: 0, left: 0 });
  let y = 28;
  if (logo) {
    const lg = await sharp()(logo).resize({ width: 560, height: 120, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    const lm = await sharp()(lg).metadata();
    layers.push({ input: lg, top: y, left: Math.round((W - lm.width) / 2) }); layout.logo = { top: y, height: lm.height }; y += lm.height + 18;
  } else {
    const wm = await textImage(esc(BRAND), { width: inner, size: 64, spacing: 2 });
    layers.push({ input: wm.buffer, top: y, left: Math.round((W - wm.width) / 2) }); y += wm.height + 14;
  }
  const chip = await textImage(esc(facts.sport), { width: inner, size: 30, color: COLORS.white, spacing: 3 });
  const chipW = chip.width + 48; const chipH = chip.height + 16;
  layers.push({ input: rect(chipW, chipH, COLORS.red, chipH / 2), top: y, left: Math.round((W - chipW) / 2) });
  layers.push({ input: chip.buffer, top: y + 8, left: Math.round((W - chip.width) / 2) }); y += chipH + 22;
  // bottom block sizes first, so the artwork gets whatever is left
  // With artwork the names sit under it; a text poster carries them large inside the panel instead.
  const names = art ? await fitText(`${esc(facts.fighterA)}  <span foreground="${COLORS.red}">VS</span>  ${esc(facts.fighterB)}`, { width: inner, max: format === 'story' ? 76 : 68, min: 36, lines: 2 }) : null;
  const lines = [facts.event, [facts.date, facts.time].filter(Boolean).join(' · '), facts.where, facts.detail].filter(Boolean);
  const info = [];
  for (const l of lines) {
    const kind = l === facts.event ? 'event' : l === lines[facts.event ? 1 : 0] ? 'date' : 'detail';
    info.push(await fitText(esc(l), { width: inner, max: kind === 'detail' ? 28 : 36, min: 20, bold: kind !== 'detail', color: kind === 'event' ? COLORS.gold : kind === 'date' ? COLORS.white : COLORS.grey }));
  }
  const qrTarget = format === 'story' ? 300 : 236;
  const qr = await qrImage(qrUrl, qrTarget);
  const infoH = info.reduce((s, t) => s + t.height + 6, 0);
  const bottomH = (names ? names.height + 18 : 0) + infoH + 24 + qr.px + 20;
  const artTop = y; const artBottom = H - pad - bottomH; const artH = Math.max(200, artBottom - artTop);
  layout.artBox = { top: artTop, left: pad, width: inner, height: artH };
  layers.push({ input: rect(inner, artH, COLORS.panel, 18), top: artTop, left: pad });
  if (art) {
    // WHOLE artwork, uniformly scaled, never cropped or altered.
    const scaled = await sharp()(art.buffer).rotate().resize({ width: inner - 16, height: artH - 16, fit: 'inside', withoutEnlargement: false, kernel: 'lanczos3' }).toColourspace('srgb').png().toBuffer();
    const sm = await sharp()(scaled).metadata();
    const left = pad + Math.round((inner - sm.width) / 2); const top = artTop + Math.round((artH - sm.height) / 2);
    layers.push({ input: scaled, top, left });
    layout.art = { top, left, width: sm.width, height: sm.height, sourceWidth: art.width, sourceHeight: art.height, sha256: art.sha256 };
  } else {
    // No approved artwork: typographic panel only (no fighter imagery of any kind).
    const big = format === 'story' ? 118 : 100;
    const a = await fitText(esc(facts.fighterA.toUpperCase()), { width: inner - 80, max: big, min: 44, lines: 2 });
    const v = await textImage('VS', { width: inner - 80, size: Math.round(big * 0.8), color: COLORS.red });
    const b = await fitText(esc(facts.fighterB.toUpperCase()), { width: inner - 80, max: big, min: 44, lines: 2 });
    const total = a.height + v.height + b.height + 24; let ty = artTop + Math.round((artH - total) / 2);
    for (const t of [a, v, b]) { layers.push({ input: t.buffer, top: ty, left: Math.round((W - t.width) / 2) }); ty += t.height + 12; }
    layout.art = null;
  }
  // names + facts
  y = artBottom + 18;
  if (names) { layers.push({ input: names.buffer, top: y, left: Math.round((W - names.width) / 2) }); y += names.height + 18; }
  for (const t of info) { layers.push({ input: t.buffer, top: y, left: Math.round((W - t.width) / 2) }); y += t.height + 6; }
  y += 24;
  // QR + call to action
  const ctaW = inner - qr.px - 32;
  layers.push({ input: qr.buffer, top: y, left: pad });
  layout.qr = { top: y, left: pad, px: qr.px, scale: qr.scale, quiet: qr.quiet, modules: qr.modules, url: qrUrl };
  const cta = await fitText('SCAN TO MAKE\nYOUR PICKS', { width: ctaW, max: 50, min: 28, lines: 2, align: 'left' });
  const site = await fitText(esc(facts.shownUrl), { width: ctaW, max: 26, min: 16, bold: false, color: COLORS.gold, align: 'left' });
  const brand = await textImage(esc(BRAND), { width: ctaW, size: 26, color: COLORS.grey, align: 'left', spacing: 2 });
  const blockH = cta.height + 10 + site.height + 10 + brand.height; let cy = y + Math.max(0, Math.round((qr.px - blockH) / 2));
  const cx = pad + qr.px + 32;
  for (const t of [cta, site, brand]) { layers.push({ input: t.buffer, top: cy, left: cx }); cy += t.height + 10; }
  layers.push({ input: rect(W, 10, COLORS.red), top: H - 10, left: 0 });
  const out = await sharp()({ create: { width: W, height: H, channels: 3, background: COLORS.bg } }).composite(layers).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer();
  return { buffer: out, layout, facts };
}

// ---- studio: generate, store, serve ----------------------------------------------------------
function createPosterStudio({ col, fetchImpl = globalThis.fetch, publicOrigin, env = {}, logoUrl = LOGO_URL }) {
  const policy = artPolicy(env);
  const origin = String(publicOrigin || '').replace(/\/+$/, '');
  let logoCache = null;
  async function logo() {
    if (logoCache && logoCache.at > Date.now() - 6 * 3600000) return logoCache.buffer;
    const r = await fetchImage(fetchImpl, logoUrl, { maxBytes: 4 * 1024 * 1024 }).catch(() => ({ ok: false }));
    logoCache = { at: Date.now(), buffer: r.ok ? r.buffer : null }; return logoCache.buffer;
  }
  const urlFor = (id) => `${origin}/api/growth/posters/${id}.jpg`;
  async function ensureForDraft(draft, { now = new Date(), force = false } = {}) {
    const c = draft.contest;
    if (!c || !c.id || !draft.contestFingerprint) return { ok: false, reason: 'not_a_verified_contest_campaign' };
    const block = await col.artRights.findOne({ contestId: c.id, status: 'blocked' });
    const src = checkArtSource(c, policy, block);
    let art = null; let artStatus;
    if (src.ok) {
      const img = await fetchImage(fetchImpl, src.url);
      if (img.ok) { art = img; artStatus = { used: true, url: src.url, host: src.host, basis: src.basis, sha256: img.sha256, width: img.width, height: img.height }; }
      else artStatus = { used: false, url: src.url, reason: img.reason };
    } else artStatus = { used: false, url: c.posterUrl || null, reason: src.reason };
    const qrUrl = qrLink(c);
    const key = sha([RENDER_VERSION, draft.id, draft.contestFingerprint, c.cleanUrl || c.contestUrl, art?.sha256 || 'typographic'].join('|')).slice(0, 20);
    const out = {};
    for (const format of Object.keys(FORMATS)) {
      const id = `${key}-${format}`;
      const have = !force && await col.posters.findOne({ id }, { projection: { bytes: 0 } });
      if (have) { out[format] = { id, url: urlFor(id), width: have.width, height: have.height }; continue; }
      const r = await renderPoster({ contest: c, format, art, logo: await logo(), qrUrl });
      const doc = { id, draftId: draft.id, contestId: c.id, contestFingerprint: draft.contestFingerprint, format, width: FORMATS[format].width, height: FORMATS[format].height,
        bytes: r.buffer, size: r.buffer.length, sha256: sha(r.buffer), contentType: 'image/jpeg', art: artStatus, layout: r.layout, facts: r.facts, qrUrl, renderVersion: RENDER_VERSION, createdAt: now.toISOString() };
      await col.posters.updateOne({ id }, { $setOnInsert: doc }, { upsert: true });
      out[format] = { id, url: urlFor(id), width: doc.width, height: doc.height };
    }
    const poster = { ...out, art: artStatus, qrUrl, generatedAt: now.toISOString() };
    await col.drafts.updateOne({ id: draft.id }, { $set: { poster } });
    // Posters of older versions of this campaign are withdrawn (never served for publishing).
    await col.posters.updateMany({ draftId: draft.id, id: { $nin: Object.values(out).map((p) => p.id) }, withdrawnAt: { $exists: false } }, { $set: { withdrawnAt: now.toISOString() } });
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
  return { ensureForDraft, getImage, setArtRights, policy, urlFor };
}

module.exports = { createPosterStudio, renderPoster, checkArtSource, artPolicy, fetchImage, qrLink, qrMatrix, posterFacts, FORMATS, LOGO_URL, RENDER_VERSION };
