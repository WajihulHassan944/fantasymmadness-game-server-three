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
const QRCode = require('qrcode');
const { artPolicy, checkArtSource, fetchImage } = require('./growth-poster-studio-art');

let sharpLib = null;
const sharp = () => (sharpLib ||= require('sharp'));
let jsQR = null; try { jsQR = require('jsqr'); } catch { jsQR = null; }

const LOGO_URL = 'https://www.fantasymmadness.com/images/brand/fantasy-mmadness-main-logo-v23.jpg';
const SITE_HOST = 'www.fantasymmadness.com';
const BRAND = 'FANTASY MMADNESS';
const FORMATS = Object.freeze({ portrait: { width: 1080, height: 1350, use: ['instagram', 'facebook', 'x'] }, story: { width: 1080, height: 1920, use: ['tiktok'] } });
const SPORT_LABEL = { boxing: 'BOXING', 'mma-ufc': 'MMA / UFC', kickboxing: 'KICKBOXING', 'bare-knuckle': 'BARE-KNUCKLE', 'pro-wrestling': 'PRO WRESTLING' };
const RENDER_VERSION = 'v10-bundled-runtime-fonts';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clean = (s, n = 200) => String(s ?? '').replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// ---- facts (verified contest only) ------------------------------------------------------
function dayText(c) {
  const [y, m, d] = c.dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).toUpperCase();
}
function timeText(c) {
  if (!c.timing?.eventTimeVerified) return null;
  return new Intl.DateTimeFormat('en-US',{timeZone:c.timing.eventTimeZone,hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(c.timing.eventStartAt));

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
function qrMatrix(url) {
  const q = QRCode.create(url, { errorCorrectionLevel: 'M' });
  return { size: q.modules.size, get: (r, c) => q.modules.get(r, c) === 1 };
}
async function qrImage(url, target) {
  const m = qrMatrix(url); const quiet = 3; const n = m.size + quiet * 2;
  const scale = Math.max(4, Math.floor(target / n)); const px = n * scale;
  const raw = Buffer.alloc(px * px * 3, 255);
  for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) if (m.get(r, c)) {
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) { const i = (((r + quiet) * scale + y) * px + (c + quiet) * scale + x) * 3; raw[i] = raw[i + 1] = raw[i + 2] = 0; }
  }
  return { buffer: await sharp()(raw, { raw: { width: px, height: px, channels: 3 } }).png().toBuffer(), px, scale, quiet, modules: m.size };
}
// The poster itself is drawn by the premium genre design system (growth-poster-premium.js).
async function renderPoster({ contest, format = 'portrait', artwork = { mode: 'text' }, logo = null, qrUrl }) {
  if (!FORMATS[format]) throw Error(`unknown poster format ${format}`);
  const facts = posterFacts(contest, qrUrl);
  const premium = require('./growth-poster-premium');
  if (typeof premium.renderPremium !== 'function') throw Error('poster_renderer_unavailable');
  const r = await premium.renderPremium({ contest, format, artwork, logo, qrUrl, facts, qrImage });
  return { buffer: r.buffer, layout: r.layout, facts };
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
function createPosterStudio({ col, fetchImpl = globalThis.fetch, publicOrigin, imagePath = '/api/growth/posters', env = {}, logoUrl = LOGO_URL, artwork = null }) {
  const policy = artPolicy(env);
  const origin = String(publicOrigin || '').replace(/\/+$/, '');
  const library = artwork || require('./growth-fighter-artwork').createArtworkLibrary({ col, fetchImpl, env });
  let logoCache = null;
  async function logo() {
    if (logoCache && logoCache.at > Date.now() - 6 * 3600000) return logoCache.buffer;
    const r = await fetchImage(fetchImpl, logoUrl, { maxBytes: 4 * 1024 * 1024 }).catch(() => ({ ok: false }));
    logoCache = { at: Date.now(), buffer: r.ok ? r.buffer : null }; return logoCache.buffer;
  }
  if (!['/api/growth/posters', '/api/growth/production-posters'].includes(imagePath)) throw Error('invalid_poster_image_path');
  const urlFor = (id) => `${origin}${imagePath}/${id}.jpg`;
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
  async function ensureForDraft(draft, { now = new Date(), force = false, qrTarget = null } = {}) {
    const c = draft.contest;
    if (!c || !c.id || !draft.contestFingerprint) return { ok: false, reason: 'not_a_verified_contest_campaign' };
    const contestBlocked = await col.artRights.findOne({ contestId: c.id, status: 'blocked' });
    const sel = await library.select(c, { contestBlocked });
    let qrUrl = qrLink(c);
    if (qrTarget) {
      let target, base; try { target = new URL(qrTarget); base = new URL(canonicalUrl(c)); } catch { return { ok: false, reason: 'invalid_affiliate_qr_destination' }; }
      if (target.origin !== base.origin || target.pathname !== base.pathname || target.username || target.password || !/^[a-f0-9]{24}$/.test(target.searchParams.get('ref') || '') || [...target.searchParams.keys()].some(k => !['play','ref','utm_source','utm_medium','utm_campaign','utm_content','utm_term'].includes(k))) return { ok: false, reason: 'invalid_affiliate_qr_destination' };
      qrUrl = target.toString();
    }
    const artKey = sel.mode === 'fighter_photos' ? sel.fighters.map((f) => f.sha256).join('+') : sel.contestArt?.sha256 || 'text';
    const key = sha([RENDER_VERSION, draft.id, draft.contestFingerprint, canonicalUrl(c), artKey, ...(qrTarget ? [qrUrl] : [])].join('|')).slice(0, 20);
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
      for (const q of (have.layout?.qc?.problems || [])) holds.push(`${format}: quality_check_${q}`);
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
