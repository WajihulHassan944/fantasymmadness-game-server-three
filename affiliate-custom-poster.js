'use strict';

// Custom fight posters for ONE affiliate.
//
// The owner uploads her finished poster for a fight (saved on the fight as
// fightPosterImage), picks one affiliate, places that affiliate's QR code on
// an empty area, previews the finished image and approves it. The approved
// image is stored here, byte for byte, and the affiliate email attaches THAT
// record — never a newer/older fight image looked up at send time.
//
// Safety rules enforced on the server:
// - The finished poster is always built from the poster currently saved on
//   the fight. If the owner's screen shows a different poster, nothing is made.
// - The QR code encodes the affiliate's own league link for this fight (the
//   same link getAffiliateFightShareUrl builds on the website).
// - Only the QR square changes; every other pixel comes from the original.
// - An approved poster can only be emailed to the affiliate it was made for,
//   for the fight it was made for, and only while that fight still has the
//   same base poster.

const crypto = require('crypto');

// QR reader (Issue #185). Vendored jsQR (Apache-2.0, vendor/jsqr/LICENSE) so the
// lockfile and deployed dependencies stay unchanged. If it cannot load, QR
// verification is reported as unavailable instead of silently passing.
let jsQR = null;
try {
  const loaded = require('./vendor/jsqr/jsQR.js');
  jsQR = loaded.default || loaded;
} catch (error) {
  console.error('[affiliate-custom-poster] QR reader unavailable:', error?.message);
}

const SITE_URL = 'https://www.fantasymmadness.com';
const OBJECT_ID = /^[a-f\d]{24}$/i;
const MIN_QR_PIXELS = 96;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

// Same rule as fmm-ver2/src/Utils/affiliatePublicLink.js getAffiliateFightShareUrl
// for a saved affiliate id: the ID-style league link with the fight id.
function affiliateLeagueFightLink(affiliateId, fightId) {
  return `${SITE_URL}/league/${encodeURIComponent(String(affiliateId))}?fightId=${encodeURIComponent(String(fightId))}`;
}

// The owner's already-configured paid fight, credited to the affiliate: the
// same attributed entry link the website uses (fight page with ?play=1&ref=).
// play=1 keeps the visitor on the fight entry page instead of the league page;
// the page remembers ref and the paid entry carries it for the existing split.
function affiliatePaidFightLink(affiliateId, fightId, fightSource = '') {
  const path = fightSource === 'pro_wrestling' ? '/pro-wrestling/matches/' : '/fight/';
  return `${SITE_URL}${path}${encodeURIComponent(String(fightId))}?play=1&ref=${encodeURIComponent(String(affiliateId))}`;
}
const qrLinkFor = (target, affiliateId, fightId, fightSource) => (target === 'paid'
  ? affiliatePaidFightLink(affiliateId, fightId, fightSource)
  : affiliateLeagueFightLink(affiliateId, fightId));

function allowedSourceHosts() {
  const extra = String(process.env.AFFILIATE_POSTER_SOURCE_HOSTS || '')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  return new Set(['res.cloudinary.com', ...extra]);
}

function assertAllowedSource(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { throw httpError(409, 'The saved fight poster address is not valid. Upload the poster again.'); }
  const hostWithPort = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  const hosts = allowedSourceHosts();
  const secureCloudinary = parsed.protocol === 'https:' && parsed.hostname === 'res.cloudinary.com' && !parsed.port;
  if (!secureCloudinary && !hosts.has(hostWithPort.toLowerCase())) {
    throw httpError(409, 'The saved fight poster is not stored in the FANTASY MMADNESS image library. Upload it again from the back office.');
  }
  if (parsed.username || parsed.password) throw httpError(409, 'The saved fight poster address is not valid.');
  return parsed.toString();
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Which affiliate and fight a FANTASY MMADNESS share link credits, or null for
// any other address. Handles the league link (/league/<id>?fightId=), the named
// league link (?ref=<id>) and the paid-fight link (/fight/<id>?ref=<id>).
function affiliateFromLink(link) {
  let url;
  try { url = new URL(String(link || '')); } catch { return null; }
  if (!/(^|\.)fantasymmadness\.com$/i.test(url.hostname)) return null;
  const parts = url.pathname.split('/').filter(Boolean).map((part) => { try { return decodeURIComponent(part); } catch { return part; } });
  const pathId = (name) => (parts[0] === name && OBJECT_ID.test(parts[1] || '') ? parts[1] : '');
  const query = (name) => (OBJECT_ID.test(url.searchParams.get(name) || '') ? url.searchParams.get(name) : '');
  const affiliateId = (query('ref') || query('affiliateId') || pathId('league')).toLowerCase();
  const fightId = (query('fightId') || pathId('fight') || (parts[0] === 'pro-wrestling' && parts[1] === 'matches' && OBJECT_ID.test(parts[2] || '') ? parts[2] : '')).toLowerCase();
  if (!affiliateId && !fightId) return null;
  return { affiliateId, fightId };
}

// Reads one QR code from an image (or from one square of it). Returns
// { data, box } with box as fractions of the upright image, or null.
async function readQr(sharp, buffer, region = null) {
  if (!jsQR) return null;
  const upright = await sharp(buffer, { failOn: 'error' }).rotate().png().toBuffer({ resolveWithObject: true });
  const fullWidth = upright.info.width; const fullHeight = upright.info.height;
  let left = 0; let top = 0; let width = fullWidth; let height = fullHeight;
  if (region) {
    left = clamp(Math.round(region.left), 0, fullWidth - 1);
    top = clamp(Math.round(region.top), 0, fullHeight - 1);
    width = clamp(Math.round(region.size), 1, fullWidth - left);
    height = clamp(Math.round(region.size), 1, fullHeight - top);
  }
  // A few working sizes: large posters are scaled down (faster and steadier),
  // small QR squares are scaled up so every module is several pixels wide.
  const longest = Math.max(width, height);
  const targets = [...new Set([Math.min(1400, longest), 900, Math.max(600, Math.min(1200, longest * 3))])];
  for (const target of targets) {
    const scale = target / longest;
    let pipeline = sharp(upright.data);
    if (region) pipeline = pipeline.extract({ left, top, width, height });
    const { data, info } = await pipeline
      .resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), kernel: scale > 1 ? 'nearest' : 'lanczos3', fit: 'fill' })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const found = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height, { inversionAttempts: 'attemptBoth' });
    if (!found?.data) continue;
    const corners = [found.location.topLeftCorner, found.location.topRightCorner, found.location.bottomLeftCorner, found.location.bottomRightCorner];
    const xs = corners.map((point) => left + point.x / scale); const ys = corners.map((point) => top + point.y / scale);
    const minX = Math.min(...xs); const minY = Math.min(...ys);
    const side = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY);
    return { data: found.data, box: { x: minX / fullWidth, y: minY / fullHeight, scale: side / fullWidth }, width: fullWidth, height: fullHeight };
  }
  return null;
}

// Stored image bytes come back as a Buffer (document) or a BSON Binary (lean).
function imageBytes(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value && value._bsontype === 'Binary') return Buffer.from(value.buffer);
  return Buffer.from(value || []);
}

module.exports = function registerAffiliateCustomPosters({ app, mongoose, verifyAdminToken, verifyToken, requireScope, affiliateScope = 'affiliate', cloudinary, sharp, QRCode, upload, fetchImpl = fetch }) {
  const Match = mongoose.models.Match;
  const Shadow = mongoose.models.Shadow;
  const ProWrestlingMatch = mongoose.models.ProWrestlingMatch;
  const Affiliate = mongoose.models.Affiliate;

  const posterSchema = new mongoose.Schema({
    fightId: { type: String, required: true, index: true },
    fightSource: { type: String, default: '' },
    affiliateId: { type: String, required: true, index: true },
    affiliateEmail: { type: String, default: '' },
    sourcePosterUrl: { type: String, required: true },
    sourceSha256: { type: String, default: '' },
    qrLink: { type: String, required: true },
    qr: { left: Number, top: Number, size: Number, x: Number, y: Number, scale: Number },
    width: Number,
    height: Number,
    contentType: { type: String, required: true },
    image: { type: Buffer, required: true },
    sha256: { type: String, required: true },
    bytes: Number,
    imageUrl: { type: String, default: '' },
    status: { type: String, enum: ['preview', 'approved', 'superseded'], default: 'preview', index: true },
    approvedAt: Date,
    approvedBy: { type: String, default: '' },
    createdBy: { type: String, default: '' },
    sends: [{ email: String, sentAt: Date }],
    // 'one' = made for one affiliate; 'all' = an approved design that every
    // affiliate receives with their OWN QR (built per affiliate when sent).
    audience: { type: String, enum: ['one', 'all'], default: 'one', index: true },
    // 'fight' = the general poster saved on the fight; 'custom' = a poster
    // uploaded only for this campaign (never replaces the fight's poster).
    sourceKind: { type: String, enum: ['fight', 'custom'], default: 'fight' },
    sourceId: { type: String, default: '' },
    promo: { title: String, event: String, affiliateName: String, message: String },
    // Where the QR goes: 'league' = the affiliate's league (top section);
    // 'paid' = the owner's paid fight credited to the affiliate (social
    // promotion section). A 'paid' poster is made from an approved poster.
    qrTarget: { type: String, enum: ['league', 'paid'], default: 'league' },
    derivedFrom: { type: String, default: '' },
    // Issue #185: the finished image was read back and its QR opens qrLink.
    qrVerified: { type: Boolean, default: undefined },
  }, { timestamps: true, collection: 'affiliatecustomposters' });
  const AffiliateCustomPoster = mongoose.models.AffiliateCustomPoster || mongoose.model('AffiliateCustomPoster', posterSchema);

  // A poster uploaded for one campaign only. Stored in its own folder and
  // never written to the fight, so it cannot replace the general poster or
  // another affiliate's poster.
  const sourceSchema = new mongoose.Schema({
    fightId: { type: String, required: true, index: true },
    url: { type: String, required: true },
    publicId: { type: String, default: '' },
    bytes: Number,
    createdBy: { type: String, default: '' },
  }, { timestamps: true, collection: 'affiliatepostersources' });
  const AffiliatePosterSource = mongoose.models.AffiliatePosterSource || mongoose.model('AffiliatePosterSource', sourceSchema);
  const SOURCE_FOLDER = 'affiliate_poster_sources';

  const adminName = (req) => String(req.admin?.email || req.admin?.id || req.admin?._id || 'admin');

  async function findFight(fightId) {
    if (!OBJECT_ID.test(String(fightId || ''))) return null;
    const match = Match && await Match.findById(fightId).lean();
    if (match) return { fight: match, source: 'match' };
    const shadow = Shadow && await Shadow.findById(fightId).lean();
    if (shadow) return { fight: shadow, source: 'shadow' };
    const wrestling = ProWrestlingMatch && await ProWrestlingMatch.findById(fightId).lean();
    if (wrestling) return { fight: wrestling, source: 'pro_wrestling' };
    return null;
  }

  // The poster the owner uploaded for this fight (Fight posters for affiliates
  // or the Fight Launch Desk). Older background/banner art never stands in.
  const savedPosterFor = (fight) => String(fight?.fightPosterImage || '').trim();

  async function loadSourceImage(url) {
    const safeUrl = assertAllowedSource(url);
    const response = await fetchImpl(safeUrl, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'Cache-Control': 'no-cache' } });
    if (!response.ok) throw httpError(502, 'The saved fight poster could not be downloaded. Try again in a moment.');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_SOURCE_BYTES) throw httpError(422, 'The saved fight poster is too large to process.');
    return buffer;
  }

  async function compose({ source, qrLink, qr }) {
    const meta = await sharp(source, { failOn: 'error' }).metadata();
    // A phone photo can carry an EXIF rotation. The owner places the QR on the
    // poster as her screen shows it, so build on the upright image.
    const rotated = Number(meta.orientation) >= 5;
    const width = Number(rotated ? meta.height : meta.width) || 0;
    const height = Number(rotated ? meta.width : meta.height) || 0;
    if (!width || !height) throw httpError(422, 'The saved fight poster has no usable size.');
    const format = ['png', 'jpeg', 'webp'].includes(meta.format) ? meta.format : 'png';

    const maxSide = Math.min(width, height);
    const scale = clamp(Number(qr?.scale) || 0.22, 0.03, 0.9);
    const size = clamp(Math.round(scale * width), Math.min(MIN_QR_PIXELS, maxSide), maxSide);
    const left = clamp(Math.round((Number(qr?.x) || 0) * width), 0, width - size);
    const top = clamp(Math.round((Number(qr?.y) || 0) * height), 0, height - size);

    const rawQr = await QRCode.toBuffer(qrLink, { type: 'png', errorCorrectionLevel: 'M', margin: 2, width: size, color: { dark: '#000000ff', light: '#ffffffff' } });
    const qrPng = await sharp(rawQr).resize(size, size, { kernel: 'nearest', fit: 'fill' }).png().toBuffer();

    let pipeline = sharp(source, { failOn: 'error' });
    if (Number(meta.orientation) > 1) pipeline = pipeline.rotate();
    pipeline = pipeline.composite([{ input: qrPng, left, top }]);
    // Keep the artwork's own colour profile so colours do not shift.
    if (meta.icc && typeof pipeline.keepIccProfile === 'function') pipeline = pipeline.keepIccProfile();
    // Keep the poster's own format. PNG stays lossless, so every pixel outside
    // the QR square is identical to the upload.
    if (format === 'jpeg') pipeline = pipeline.jpeg({ quality: 97, chromaSubsampling: '4:4:4', mozjpeg: false });
    else if (format === 'webp') pipeline = pipeline.webp({ quality: 97, lossless: false, smartSubsample: true });
    else pipeline = pipeline.png({ compressionLevel: 9 });
    const output = await pipeline.toBuffer();
    return {
      output,
      contentType: format === 'jpeg' ? 'image/jpeg' : `image/${format}`,
      width, height,
      qr: { left, top, size, x: left / width, y: top / height, scale: size / width },
    };
  }

  // Read the QR square back out of the finished image. A poster whose QR does
  // not open the affiliate's own link is never stored, approved or sent.
  async function verifyComposedQr(built, qrLink) {
    if (!jsQR) throw httpError(503, 'The QR checker is unavailable, so the poster could not be verified. Nothing was saved.');
    const margin = Math.round(built.qr.size * 0.15);
    const found = await readQr(sharp, built.output, { left: built.qr.left - margin, top: built.qr.top - margin, size: built.qr.size + margin * 2 });
    if (!found || found.data !== qrLink) {
      throw httpError(422, 'The QR code on the finished poster could not be read back correctly. Make the QR code larger or move it to a plainer area, then try again.');
    }
    return true;
  }

  // A poster the owner made herself may already carry a QR code. If it does,
  // it must credit this affiliate and this fight; another affiliate's QR on
  // this affiliate's poster would send her fans (and her referrals) elsewhere.
  async function checkEmbeddedQr(source, { affiliateId, fightId }) {
    const found = await readQr(sharp, source).catch(() => null);
    if (!found) return null;
    const credited = affiliateFromLink(found.data);
    if (!credited) return { ...found, matches: false, foreign: false };
    if ((credited.affiliateId && credited.affiliateId !== String(affiliateId).toLowerCase()) || (credited.fightId && credited.fightId !== String(fightId).toLowerCase())) {
      throw httpError(409, 'The QR code already printed on this poster belongs to a different affiliate or fight. Upload the poster made for this affiliate and this fight.');
    }
    return { ...found, matches: Boolean(credited.affiliateId), foreign: false };
  }

  async function storeImage(buffer, contentType) {
    if (!cloudinary?.uploader?.upload_stream) return '';
    const uploaded = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream({ folder: 'fantasymmadness/affiliate-custom-posters', resource_type: 'image' }, (error, result) => (error ? reject(error) : resolve(result))).end(buffer);
    });
    return String(uploaded?.secure_url || '');
  }

  const publicPoster = (doc) => ({
    id: String(doc._id),
    fightId: doc.fightId,
    affiliateId: doc.affiliateId,
    status: doc.status,
    url: doc.imageUrl || `/api/admin/affiliate-posters/${doc._id}/image`,
    qrLink: doc.qrLink,
    qr: doc.qr,
    width: doc.width,
    height: doc.height,
    contentType: doc.contentType,
    sha256: doc.sha256,
    sourcePosterUrl: doc.sourcePosterUrl,
    approvedAt: doc.approvedAt || null,
    createdAt: doc.createdAt,
    audience: doc.audience || 'one',
    sourceKind: doc.sourceKind || 'fight',
    sourceId: doc.sourceId || '',
    qrTarget: doc.qrTarget || 'league',
    derivedFrom: doc.derivedFrom || '',
    promo: {
      title: doc.promo?.title || '',
      event: doc.promo?.event || '',
      affiliateName: doc.promo?.affiliateName || '',
      message: doc.promo?.message || '',
    },
  });

  const cleanText = (value, max) => String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
  const cleanPromo = (promo = {}) => ({
    title: cleanText(promo.title, 140),
    event: cleanText(promo.event, 200),
    affiliateName: cleanText(promo.affiliateName, 80),
    message: cleanText(promo.message, 2000),
  });

  // Which artwork a campaign uses, and proof it is still the same artwork.
  async function resolveSource({ fightId, found, sourceId }) {
    if (sourceId) {
      if (!OBJECT_ID.test(String(sourceId))) throw httpError(400, 'The uploaded poster reference is not valid.');
      const source = await AffiliatePosterSource.findById(sourceId).lean();
      if (!source) throw httpError(404, 'The uploaded poster could not be found. Upload it again.');
      if (source.fightId !== String(fightId)) throw httpError(409, 'That uploaded poster belongs to a different fight. Upload it again for this fight.');
      return { kind: 'custom', url: source.url, id: String(source._id) };
    }
    const saved = savedPosterFor(found.fight);
    if (!saved) throw httpError(409, 'Upload your finished poster for this fight first.');
    return { kind: 'fight', url: saved, id: '' };
  }
  async function sourceStillValid(doc) {
    if (doc.sourceKind === 'custom') {
      const source = doc.sourceId && await AffiliatePosterSource.findById(doc.sourceId).lean();
      return Boolean(source && source.fightId === doc.fightId && source.url === doc.sourcePosterUrl);
    }
    const found = await findFight(doc.fightId);
    return Boolean(found && savedPosterFor(found.fight) === doc.sourcePosterUrl);
  }

  // ---- Automatic QR placement --------------------------------------------
  // 1. An empty QR box drawn on the artwork: a flat square whose edge clearly
  //    differs from its inside. The QR goes inside it.
  // 2. Otherwise the calmest open area, preferably in the lower-right corner.
  // Placement is always inside the original artwork; nothing is added.
  async function suggestPlacement(source) {
    const W = 240;
    const { data, info } = await sharp(source, { failOn: 'error' }).rotate().resize({ width: W }).greyscale().raw().toBuffer({ resolveWithObject: true });
    const w = info.width; const h = info.height;
    const sum = new Float64Array((w + 1) * (h + 1));
    const sq = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0; let rowSq = 0;
      for (let x = 0; x < w; x++) {
        const v = data[y * w + x]; row += v; rowSq += v * v;
        sum[(y + 1) * (w + 1) + x + 1] = sum[y * (w + 1) + x + 1] + row;
        sq[(y + 1) * (w + 1) + x + 1] = sq[y * (w + 1) + x + 1] + rowSq;
      }
    }
    const rect = (x, y, rw, rh) => {
      const a = y * (w + 1) + x; const b = a + rw; const c = (y + rh) * (w + 1) + x; const d = c + rw;
      const n = rw * rh; const s1 = sum[d] - sum[b] - sum[c] + sum[a]; const s2 = sq[d] - sq[b] - sq[c] + sq[a];
      const mean = s1 / n; return { mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)), s1, s2, n };
    };
    let box = null;
    const minSide = Math.round(Math.min(w, h) * 0.12); const maxSide = Math.round(Math.min(w, h) * 0.5);
    for (let side = maxSide; side >= minSide; side -= 2) {
      const inset = Math.max(2, Math.round(side * 0.08));
      const ring = Math.max(2, Math.round(side * 0.05));
      for (let y = ring; y + side + ring <= h; y += 2) {
        for (let x = ring; x + side + ring <= w; x += 2) {
          const inner = rect(x + inset, y + inset, side - inset * 2, side - inset * 2);
          if (inner.std > 6) continue;
          // Each edge of a drawn box stands out from its flat inside; a flat
          // area that merely touches one dark edge is not a box.
          const edges = [
            rect(x - ring, y - ring, side + ring * 2, ring),
            rect(x - ring, y + side, side + ring * 2, ring),
            rect(x - ring, y, ring, side),
            rect(x + side, y, ring, side),
          ];
          if (edges.filter((edge) => Math.abs(edge.mean - inner.mean) >= 30).length < 3) continue;
          const score = side * 1000 + (x + y);
          if (!box || score > box.score) box = { x, y, side, inset, score };
        }
      }
      if (box) break;
    }
    if (box) {
      const pad = Math.round(box.side * 0.1);
      return { reason: 'empty-box', x: (box.x + pad) / w, y: (box.y + pad) / h, scale: (box.side - pad * 2) / w };
    }
    const side = Math.round(w * 0.22); const margin = Math.round(w * 0.03);
    let best = null;
    for (let y = Math.round(h / 2); y + side + margin <= h; y += 2) {
      for (let x = Math.round(w / 2); x + side + margin <= w; x += 2) {
        const r = rect(x, y, side, side);
        const score = r.std - (x + y) * 0.01;
        if (!best || score < best.score) best = { x, y, std: r.std, score };
      }
    }
    if (best && best.std < 18) return { reason: 'open-area', x: best.x / w, y: best.y / h, scale: side / w };
    return { reason: 'lower-right', x: (w - side - margin) / w, y: (h - side - margin) / h, scale: side / w };
  }

  const fail = (res, error, fallback) => {
    if (error?.status) return res.status(error.status).json({ ok: false, message: error.message });
    console.error(`[affiliate-custom-poster] ${fallback}:`, error);
    return res.status(500).json({ ok: false, message: fallback });
  };

  const SOURCE_TYPES = /^image\/(png|jpeg|webp)$/;

  async function saveSource({ fightId, url, publicId, bytes, req }) {
    const doc = await AffiliatePosterSource.create({ fightId, url, publicId, bytes: Number(bytes) || undefined, createdBy: adminName(req) });
    return { id: String(doc._id), url: doc.url, fightId };
  }

  // Upload a poster for one campaign only (small files through the server).
  // The fight's own poster is not touched.
  const single = upload?.single ? upload.single('poster') : (_req, _res, next) => next();
  app.post('/api/admin/affiliate-posters/sources', verifyAdminToken, single, async (req, res) => {
    try {
      const fightId = String(req.body?.fightId || '').trim();
      if (!OBJECT_ID.test(fightId)) return res.status(400).json({ ok: false, message: 'Choose a fight first.' });
      if (!await findFight(fightId)) return res.status(404).json({ ok: false, message: 'Fight not found.' });
      if (!req.file?.buffer || !SOURCE_TYPES.test(req.file.mimetype)) return res.status(400).json({ ok: false, message: 'Choose a PNG, JPEG, or WebP poster.' });
      const uploaded = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream({ folder: SOURCE_FOLDER, resource_type: 'image' }, (error, result) => (error ? reject(error) : resolve(result))).end(req.file.buffer);
      });
      const source = await saveSource({ fightId, url: uploaded.secure_url, publicId: uploaded.public_id, bytes: req.file.size, req });
      return res.status(201).json({ ok: true, source });
    } catch (error) { return fail(res, error, 'Could not save the poster.'); }
  });

  // Large posters: signed direct upload so the exact file is kept.
  app.post('/api/admin/affiliate-posters/sources/direct-upload', verifyAdminToken, async (req, res) => {
    try {
      const fightId = String(req.body?.fightId || '').trim();
      if (!OBJECT_ID.test(fightId)) return res.status(400).json({ ok: false, message: 'Choose a fight first.' });
      if (!await findFight(fightId)) return res.status(404).json({ ok: false, message: 'Fight not found.' });
      const config = cloudinary.config();
      if (!config.cloud_name || !config.api_key || !config.api_secret) return res.status(503).json({ ok: false, message: 'Direct poster upload is not configured.' });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = cloudinary.utils.api_sign_request({ folder: SOURCE_FOLDER, timestamp }, config.api_secret);
      const prefix = String(config.upload_prefix || 'https://api.cloudinary.com').replace(/\/$/, '');
      return res.json({ ok: true, uploadUrl: `${prefix}/v1_1/${encodeURIComponent(config.cloud_name)}/image/upload`, fields: { api_key: config.api_key, timestamp, folder: SOURCE_FOLDER, signature } });
    } catch (error) { return fail(res, error, 'Could not prepare the poster upload.'); }
  });

  app.post('/api/admin/affiliate-posters/sources/confirm', verifyAdminToken, async (req, res) => {
    try {
      const fightId = String(req.body?.fightId || '').trim();
      if (!OBJECT_ID.test(fightId)) return res.status(400).json({ ok: false, message: 'Choose a fight first.' });
      if (!await findFight(fightId)) return res.status(404).json({ ok: false, message: 'Fight not found.' });
      const secureUrl = String(req.body?.secure_url || '').trim();
      const publicId = String(req.body?.public_id || '').trim();
      const version = String(req.body?.version || '').trim();
      const signature = String(req.body?.signature || '').trim();
      const config = cloudinary.config();
      if (!publicId.startsWith(`${SOURCE_FOLDER}/`) || !version || !signature) return res.status(400).json({ ok: false, message: 'The poster upload was incomplete. Please upload it again.' });
      if (cloudinary.utils.api_sign_request({ public_id: publicId, version }, config.api_secret) !== signature) return res.status(400).json({ ok: false, message: 'The poster upload could not be verified. Please upload it again.' });
      let parsed;
      try { parsed = new URL(secureUrl); } catch { return res.status(400).json({ ok: false, message: 'The poster address is not valid.' }); }
      const host = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
      const ownLibrary = parsed.protocol === 'https:' && parsed.hostname === 'res.cloudinary.com' && parsed.pathname.startsWith(`/${config.cloud_name}/image/upload/`);
      if (!ownLibrary && !allowedSourceHosts().has(host.toLowerCase())) return res.status(400).json({ ok: false, message: 'The poster was not stored in the FANTASY MMADNESS image library.' });
      if (!decodeURIComponent(parsed.pathname).includes(publicId)) return res.status(400).json({ ok: false, message: 'The poster upload did not match. Please upload it again.' });
      const source = await saveSource({ fightId, url: secureUrl, publicId, bytes: req.body?.bytes, req });
      return res.status(201).json({ ok: true, source, exact: true });
    } catch (error) { return fail(res, error, 'Could not save the poster.'); }
  });

  // Where the QR should go on this artwork.
  app.post('/api/admin/affiliate-posters/suggest-placement', verifyAdminToken, async (req, res) => {
    try {
      const fightId = String(req.body?.fightId || '').trim();
      const found = await findFight(fightId);
      if (!found) return res.status(404).json({ ok: false, message: 'Fight not found.' });
      const chosen = await resolveSource({ fightId, found, sourceId: String(req.body?.sourceId || '').trim() });
      const expected = String(req.body?.sourcePosterUrl || '').trim();
      if (expected && expected !== chosen.url) return res.status(409).json({ ok: false, code: 'POSTER_CHANGED', message: 'A different poster is saved than the one on your screen. Reload and try again.' });
      const source = await loadSourceImage(chosen.url);
      // The affiliate's own QR is already printed on her poster: cover exactly
      // that spot (same link, so nothing visible changes for her fans).
      const affiliateId = String(req.body?.affiliateId || '').trim();
      if (chosen.kind === 'custom' && OBJECT_ID.test(affiliateId)) {
        const embedded = await checkEmbeddedQr(source, { affiliateId, fightId });
        if (embedded?.matches) {
          const scale = clamp(embedded.box.scale * 1.16, 0.03, 0.9);
          const shift = (scale - embedded.box.scale) / 2;
          const aspect = embedded.width / embedded.height;
          return res.json({ ok: true, placement: { reason: 'existing-qr', x: clamp(embedded.box.x - shift, 0, 1 - scale), y: clamp(embedded.box.y - shift * aspect, 0, 1), scale }, sourcePosterUrl: chosen.url });
        }
      }
      const placement = await suggestPlacement(source);
      return res.json({ ok: true, placement, sourcePosterUrl: chosen.url });
    } catch (error) { return fail(res, error, 'Could not find a place for the QR code.'); }
  });

  // Build a finished poster (not sent, not approved). For "all affiliates" the
  // preview shows one sample affiliate's QR; each affiliate gets their own.
  app.post('/api/admin/affiliate-posters/preview', verifyAdminToken, async (req, res) => {
    try {
      const fightId = String(req.body?.fightId || '').trim();
      const audience = req.body?.audience === 'all' ? 'all' : 'one';
      let affiliateId = String(req.body?.affiliateId || '').trim();
      if (!OBJECT_ID.test(fightId)) return res.status(400).json({ ok: false, message: 'Choose a fight first.' });
      if (audience === 'one' && !OBJECT_ID.test(affiliateId)) return res.status(400).json({ ok: false, message: 'Choose a fight and an affiliate first.' });
      const found = await findFight(fightId);
      if (!found) return res.status(404).json({ ok: false, message: 'Fight not found.' });
      const chosen = await resolveSource({ fightId, found, sourceId: String(req.body?.sourceId || '').trim() });
      const expected = String(req.body?.sourcePosterUrl || '').trim();
      if (expected && expected !== chosen.url) {
        return res.status(409).json({ ok: false, code: 'POSTER_CHANGED', message: 'A different poster is saved for this fight than the one on your screen. Reload the page and place the QR again.', savedPosterUrl: chosen.url });
      }
      let affiliate = OBJECT_ID.test(affiliateId) ? await Affiliate.findById(affiliateId).select('_id email firstName lastName verified').lean() : null;
      if (audience === 'one' && !affiliate) return res.status(404).json({ ok: false, message: 'Affiliate not found.' });
      if (audience === 'all' && !affiliate) {
        affiliate = await Affiliate.findOne({ verified: true, email: { $regex: /@/ } }).sort({ firstName: 1, lastName: 1, _id: 1 }).select('_id email firstName lastName verified').lean();
        if (!affiliate) return res.status(409).json({ ok: false, message: 'There are no approved affiliates to send to yet.' });
      }
      affiliateId = String(affiliate._id);
      const qrLink = affiliateLeagueFightLink(affiliate._id, fightId);
      const source = await loadSourceImage(chosen.url);
      if (chosen.kind === 'custom' && audience === 'one') await checkEmbeddedQr(source, { affiliateId, fightId });
      const built = await compose({ source, qrLink, qr: req.body?.qr || {} });
      await verifyComposedQr(built, qrLink);
      const sha256 = crypto.createHash('sha256').update(built.output).digest('hex');
      const imageUrl = await storeImage(built.output, built.contentType).catch((error) => {
        console.error('[affiliate-custom-poster] image copy upload failed:', error?.message);
        return '';
      });
      const doc = await AffiliateCustomPoster.create({
        fightId, fightSource: found.source, affiliateId, affiliateEmail: String(affiliate.email || '').toLowerCase(),
        sourcePosterUrl: chosen.url, sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
        sourceKind: chosen.kind, sourceId: chosen.id, audience, promo: cleanPromo(req.body?.promo),
        qrLink, qr: built.qr, width: built.width, height: built.height, contentType: built.contentType,
        image: built.output, sha256, bytes: built.output.length, imageUrl, status: 'preview', createdBy: adminName(req), qrVerified: true,
      });
      return res.status(201).json({ ok: true, poster: { ...publicPoster(doc), affiliateName: [affiliate.firstName, affiliate.lastName].filter(Boolean).join(' ') } });
    } catch (error) { return fail(res, error, 'Could not build the finished poster.'); }
  });

  // One finished poster (for the announcement window).
  app.get('/api/admin/affiliate-posters/:id', verifyAdminToken, async (req, res, next) => {
    try {
      if (!OBJECT_ID.test(String(req.params.id || ''))) return next();
      const doc = await AffiliateCustomPoster.findById(req.params.id).select('-image').lean();
      if (!doc) return res.status(404).json({ ok: false, message: 'Finished poster not found.' });
      return res.json({ ok: true, poster: publicPoster(doc) });
    } catch (error) { return fail(res, error, 'Could not load the finished poster.'); }
  });

  // Exact bytes of a finished poster, for the owner's preview and download.
  app.get('/api/admin/affiliate-posters/:id/image', verifyAdminToken, async (req, res) => {
    try {
      if (!OBJECT_ID.test(String(req.params.id || ''))) return res.status(400).end();
      const doc = await AffiliateCustomPoster.findById(req.params.id).select('image contentType sha256').lean();
      if (!doc) return res.status(404).end();
      res.setHeader('Content-Type', doc.contentType);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Poster-Sha256', doc.sha256);
      return res.status(200).send(imageBytes(doc.image));
    } catch (error) { return fail(res, error, 'Could not load the finished poster.'); }
  });

  // A league-QR poster and a paid-fight-QR poster for the same campaign live
  // side by side; approving one never retires the other.
  const sameTarget = (doc) => (doc.qrTarget === 'paid' ? { qrTarget: 'paid' } : { qrTarget: { $ne: 'paid' } });

  // The owner approves exactly this finished poster (and its promotional text).
  app.post('/api/admin/affiliate-posters/:id/approve', verifyAdminToken, async (req, res) => {
    try {
      if (!OBJECT_ID.test(String(req.params.id || ''))) return res.status(400).json({ ok: false, message: 'Invalid poster.' });
      const doc = await AffiliateCustomPoster.findById(req.params.id);
      if (!doc) return res.status(404).json({ ok: false, message: 'Finished poster not found.' });
      if (doc.status === 'superseded') return res.status(409).json({ ok: false, message: 'A newer finished poster replaced this one. Approve the newest version.' });
      if (doc.qrVerified === false) return res.status(409).json({ ok: false, message: 'The QR code on this poster could not be verified. Make a new preview.' });
      if (!await sourceStillValid(doc)) {
        return res.status(409).json({ ok: false, code: 'POSTER_CHANGED', message: 'The poster was replaced after this preview was made. Place the QR again and approve the new preview.' });
      }
      const audience = doc.audience || 'one';
      await AffiliateCustomPoster.updateMany(
        audience === 'all'
          ? { _id: { $ne: doc._id }, fightId: doc.fightId, audience: 'all', status: 'approved', ...sameTarget(doc) }
          : { _id: { $ne: doc._id }, fightId: doc.fightId, affiliateId: doc.affiliateId, audience: { $ne: 'all' }, status: 'approved', ...sameTarget(doc) },
        { $set: { status: 'superseded' } },
      );
      doc.status = 'approved';
      doc.approvedAt = new Date();
      doc.approvedBy = adminName(req);
      await doc.save();
      return res.json({ ok: true, poster: publicPoster(doc) });
    } catch (error) { return fail(res, error, 'Could not approve the finished poster.'); }
  });

  // Social promotion section: the SAME approved poster (same artwork, same QR
  // position and size, same promotional text), with the affiliate's QR now
  // opening the owner's paid fight credited to that affiliate. No new upload,
  // contest or payment setup. Approval carries over because only the QR
  // destination differs; the owner sees the result before it is sent.
  app.post('/api/admin/affiliate-posters/:id/paid-version', verifyAdminToken, async (req, res) => {
    try {
      if (!OBJECT_ID.test(String(req.params.id || ''))) return res.status(400).json({ ok: false, message: 'Invalid poster.' });
      const base = await AffiliateCustomPoster.findById(req.params.id).select('-image').lean();
      if (!base) return res.status(404).json({ ok: false, message: 'Approved poster not found.' });
      if (base.status !== 'approved') return res.status(409).json({ ok: false, message: 'Approve the poster in the top section first.' });
      if (base.qrTarget === 'paid') return res.json({ ok: true, poster: publicPoster(base) });
      if (!await sourceStillValid(base)) return res.status(409).json({ ok: false, code: 'POSTER_CHANGED', message: 'The poster was replaced after it was approved. Approve the new poster first.' });
      const found = await findFight(base.fightId);
      if (!found) return res.status(404).json({ ok: false, message: 'Fight not found.' });
      const existing = await AffiliateCustomPoster.findOne({ derivedFrom: String(base._id), qrTarget: 'paid', status: 'approved' }).select('-image').lean();
      if (existing) return res.json({ ok: true, poster: publicPoster(existing) });
      const affiliate = await Affiliate.findById(base.affiliateId).select('_id email firstName lastName').lean();
      if (!affiliate) return res.status(404).json({ ok: false, message: 'Affiliate not found.' });
      const qrLink = affiliatePaidFightLink(affiliate._id, base.fightId, found.source);
      const source = await loadSourceImage(base.sourcePosterUrl);
      const built = await compose({ source, qrLink, qr: { x: base.qr?.x, y: base.qr?.y, scale: base.qr?.scale } });
      await verifyComposedQr(built, qrLink);
      const sha256 = crypto.createHash('sha256').update(built.output).digest('hex');
      const imageUrl = await storeImage(built.output, built.contentType).catch((error) => {
        console.error('[affiliate-custom-poster] image copy upload failed:', error?.message);
        return '';
      });
      await AffiliateCustomPoster.updateMany(
        { fightId: base.fightId, qrTarget: 'paid', status: 'approved', ...(base.audience === 'all' ? { audience: 'all' } : { affiliateId: base.affiliateId, audience: { $ne: 'all' } }) },
        { $set: { status: 'superseded' } },
      );
      const doc = await AffiliateCustomPoster.create({
        fightId: base.fightId, fightSource: found.source, affiliateId: String(affiliate._id), affiliateEmail: String(affiliate.email || '').toLowerCase(),
        sourcePosterUrl: base.sourcePosterUrl, sourceSha256: base.sourceSha256, sourceKind: base.sourceKind, sourceId: base.sourceId,
        audience: base.audience || 'one', promo: base.promo, qrTarget: 'paid', derivedFrom: String(base._id),
        qrLink, qr: built.qr, width: built.width, height: built.height, contentType: built.contentType,
        image: built.output, sha256, bytes: built.output.length, imageUrl, qrVerified: true,
        status: 'approved', approvedAt: new Date(), approvedBy: adminName(req), createdBy: adminName(req),
      });
      return res.status(201).json({ ok: true, poster: { ...publicPoster(doc), affiliateName: [affiliate.firstName, affiliate.lastName].filter(Boolean).join(' ') } });
    } catch (error) { return fail(res, error, 'Could not make the paid-fight poster.'); }
  });

  // Used by /send-email-affiliate: the approved image for this exact fight and
  // recipient, or the reason it cannot be sent.
  async function forEmail({ posterId, fightId, email }) {
    if (!OBJECT_ID.test(String(posterId || ''))) throw httpError(400, 'The approved poster reference is not valid.');
    const doc = await AffiliateCustomPoster.findById(posterId);
    if (!doc) throw httpError(404, 'The approved poster could not be found. Approve it again before sending.');
    if (doc.status !== 'approved') throw httpError(409, 'This finished poster has not been approved (or a newer one replaced it). Approve it before sending.');
    if (String(fightId || '') !== doc.fightId) throw httpError(409, 'The approved poster belongs to a different fight.');
    const recipient = String(email || '').trim().toLowerCase();
    if (!await sourceStillValid(doc)) {
      throw httpError(409, 'The poster was replaced after you approved this finished poster. Make and approve a new one before sending.');
    }
    const ext = doc.contentType === 'image/jpeg' ? 'jpg' : doc.contentType.replace('image/', '');
    if ((doc.audience || 'one') === 'all') {
      // Every affiliate gets the approved design with THEIR OWN QR code.
      const exact = new RegExp(`^${recipient.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
      const affiliate = await Affiliate.findOne({ email: exact, verified: true }).select('_id email').lean();
      if (!affiliate) throw httpError(409, 'Only approved affiliates can receive this poster. It was not sent.');
      const qrLink = qrLinkFor(doc.qrTarget, affiliate._id, doc.fightId, doc.fightSource);
      const built = await compose({ source: await loadSourceImage(doc.sourcePosterUrl), qrLink, qr: { x: doc.qr?.x, y: doc.qr?.y, scale: doc.qr?.scale } });
      await verifyComposedQr(built, qrLink);
      return {
        id: String(doc._id), image: built.output, contentType: built.contentType,
        sha256: crypto.createHash('sha256').update(built.output).digest('hex'), qrLink,
        filename: `fantasy-mmadness-fight-poster-${doc.fightId}.${ext}`,
        cid: `fight-poster-${doc._id}-${affiliate._id}@fantasymmadness.com`,
      };
    }
    const affiliate = await Affiliate.findById(doc.affiliateId).select('_id email firstName').lean();
    if (!affiliate || String(affiliate.email || '').trim().toLowerCase() !== recipient) {
      throw httpError(409, 'This finished poster was made for a different affiliate. It was not sent.');
    }
    const image = imageBytes(doc.image);
    if (crypto.createHash('sha256').update(image).digest('hex') !== doc.sha256) throw httpError(500, 'The approved poster failed its integrity check. It was not sent.');
    return {
      id: String(doc._id),
      image,
      contentType: doc.contentType,
      sha256: doc.sha256,
      qrLink: doc.qrLink,
      filename: `fantasy-mmadness-fight-poster-${doc.fightId}.${ext}`,
      cid: `fight-poster-${doc._id}@fantasymmadness.com`,
    };
  }

  async function markSent(posterId, email) {
    await AffiliateCustomPoster.updateOne({ _id: posterId }, { $push: { sends: { email: String(email || '').toLowerCase(), sentAt: new Date() } } });
  }

  // ---- Issue #185: the personalized poster everywhere the affiliate sees it --
  // The ONE approved poster made for this affiliate and this fight (still
  // built from the artwork it was approved on), or null. Precedence when
  // several exist: the one most recently emailed to her, then the league-QR
  // version (it matches the tracked link in her kit), then the newest approval.
  async function approvedForAffiliate({ fightId, affiliateId }) {
    if (!OBJECT_ID.test(String(fightId || '')) || !OBJECT_ID.test(String(affiliateId || ''))) return null;
    const docs = await AffiliateCustomPoster.find({ fightId: String(fightId), affiliateId: String(affiliateId), audience: { $ne: 'all' }, status: 'approved' })
      .select('-image').lean();
    const lastSent = (doc) => Math.max(0, ...(doc.sends || []).map((send) => new Date(send.sentAt).getTime() || 0));
    docs.sort((a, b) => (lastSent(b) - lastSent(a))
      || ((a.qrTarget === 'paid') - (b.qrTarget === 'paid'))
      || (new Date(b.approvedAt || b.createdAt).getTime() - new Date(a.approvedAt || a.createdAt).getTime()));
    for (const doc of docs) {
      if (doc.qrVerified === false) continue;
      if (await sourceStillValid(doc)) return doc;
    }
    return null;
  }

  // Email without an explicit poster reference (for example the general
  // "Prepare affiliate alerts" window): attach the affiliate's approved
  // personalized poster when one exists; otherwise null, and the regular
  // general-poster email goes out unchanged.
  async function posterForAffiliateEmail({ fightId, email }) {
    const recipient = String(email || '').trim().toLowerCase();
    if (!OBJECT_ID.test(String(fightId || '')) || !recipient) return null;
    const exact = new RegExp(`^${recipient.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const affiliate = await Affiliate.findOne({ email: exact }).select('_id').lean();
    if (!affiliate) return null;
    const doc = await approvedForAffiliate({ fightId, affiliateId: String(affiliate._id) });
    return doc ? forEmail({ posterId: String(doc._id), fightId, email: recipient }) : null;
  }

  // What the affiliate's kit needs to show, copy, download and share it.
  const kitPoster = (doc) => (doc ? {
    id: String(doc._id),
    fightId: doc.fightId,
    affiliateId: doc.affiliateId,
    sha256: doc.sha256,
    contentType: doc.contentType,
    width: doc.width,
    height: doc.height,
    qrLink: doc.qrLink,
    qrTarget: doc.qrTarget || 'league',
    approvedAt: doc.approvedAt || null,
    imagePath: `/api/affiliates/me/promotions/${encodeURIComponent(doc.fightId)}/custom-poster/image?v=${doc.sha256.slice(0, 16)}`,
    publicImagePath: `/api/public/affiliate-posters/${encodeURIComponent(doc.fightId)}/${encodeURIComponent(doc.affiliateId)}/image?v=${doc.sha256.slice(0, 16)}`,
  } : null);

  async function sendPosterBytes(res, doc, cacheControl) {
    const full = await AffiliateCustomPoster.findById(doc._id).select('image contentType sha256').lean();
    if (!full) return res.status(404).end();
    const image = imageBytes(full.image);
    if (crypto.createHash('sha256').update(image).digest('hex') !== full.sha256) return res.status(500).json({ ok: false, message: 'The poster failed its integrity check.' });
    res.setHeader('Content-Type', full.contentType);
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('X-Poster-Sha256', full.sha256);
    return res.status(200).send(image);
  }

  if (typeof verifyToken === 'function' && typeof requireScope === 'function') {
    const affiliateAuth = [verifyToken, requireScope(affiliateScope)];
    const selfId = (req) => String(req.user?.id || req.user?._id || '').trim();
    app.get('/api/affiliates/me/promotions/:fightId/custom-poster', ...affiliateAuth, async (req, res) => {
      try {
        const doc = await approvedForAffiliate({ fightId: String(req.params.fightId || ''), affiliateId: selfId(req) });
        res.setHeader('Cache-Control', 'private, no-store');
        return res.json({ ok: true, poster: kitPoster(doc) });
      } catch (error) { return fail(res, error, 'Could not load your personalized poster.'); }
    });
    app.get('/api/affiliates/me/promotions/:fightId/custom-poster/image', ...affiliateAuth, async (req, res) => {
      try {
        const doc = await approvedForAffiliate({ fightId: String(req.params.fightId || ''), affiliateId: selfId(req) });
        if (!doc) return res.status(404).json({ ok: false, message: 'No personalized poster for this fight.' });
        return sendPosterBytes(res, doc, 'private, no-store');
      } catch (error) { return fail(res, error, 'Could not load your personalized poster.'); }
    });
  }

  // Public image for social link previews (the affiliate's league page). The
  // poster exists to be shared publicly; only an approved, still-valid poster
  // for a verified affiliate is served.
  app.get('/api/public/affiliate-posters/:fightId/:affiliateId/image', async (req, res) => {
    try {
      const affiliateId = String(req.params.affiliateId || '');
      if (!OBJECT_ID.test(affiliateId) || !OBJECT_ID.test(String(req.params.fightId || ''))) return res.status(400).end();
      const affiliate = await Affiliate.findById(affiliateId).select('_id verified').lean();
      if (!affiliate?.verified) return res.status(404).end();
      const doc = await approvedForAffiliate({ fightId: String(req.params.fightId), affiliateId });
      if (!doc) return res.status(404).end();
      // Link-preview renderers cannot always read WebP: ?format=jpeg returns a
      // JPEG copy of the same approved poster (the kit always uses the exact file).
      if (req.query.format === 'jpeg') {
        const full = await AffiliateCustomPoster.findById(doc._id).select('image sha256').lean();
        const image = imageBytes(full?.image);
        if (!full || crypto.createHash('sha256').update(image).digest('hex') !== full.sha256) return res.status(500).end();
        const jpeg = await sharp(image, { failOn: 'error' }).rotate().flatten({ background: '#ffffff' }).jpeg({ quality: 88 }).toBuffer();
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
        res.setHeader('X-Poster-Sha256', full.sha256);
        return res.status(200).send(jpeg);
      }
      return sendPosterBytes(res, doc, 'public, max-age=300, s-maxage=300');
    } catch (error) { return fail(res, error, 'Could not load the poster.'); }
  });

  app.locals.affiliateCustomPoster = { forEmail, markSent, approvedForAffiliate, posterForAffiliateEmail, kitPoster, affiliateLeagueFightLink, affiliatePaidFightLink };
  return { AffiliateCustomPoster, AffiliatePosterSource, forEmail, markSent, approvedForAffiliate, posterForAffiliateEmail, kitPoster, compose, suggestPlacement, affiliateLeagueFightLink, affiliatePaidFightLink };
};

module.exports.affiliateLeagueFightLink = affiliateLeagueFightLink;
module.exports.affiliatePaidFightLink = affiliatePaidFightLink;

// Large posters (over the hosting request limit) go straight from the owner's
// browser to the image library, so the exact file is kept instead of a
// shrunken copy. The server signs the upload and then verifies the library's
// signature before saving the result as the fight's poster.
module.exports.registerPosterDirectUpload = function registerPosterDirectUpload({ app, mongoose, verifyAdminToken, cloudinary }) {
  const FOLDER = 'fight_social_posters';
  const models = () => [mongoose.models.Match, mongoose.models.Shadow, mongoose.models.ProWrestlingMatch].filter(Boolean);
  const findFightDoc = async (fightId) => {
    for (const Model of models()) {
      const doc = await Model.findById(fightId);
      if (doc) return doc;
    }
    return null;
  };

  app.post('/api/admin/fights/:fightId/social-poster/direct-upload', verifyAdminToken, async (req, res) => {
    try {
      const fightId = String(req.params.fightId || '');
      if (!OBJECT_ID.test(fightId)) return res.status(400).json({ ok: false, message: 'Invalid fight ID.' });
      if (!await findFightDoc(fightId)) return res.status(404).json({ ok: false, message: 'Fight not found.' });
      const config = cloudinary.config();
      if (!config.cloud_name || !config.api_key || !config.api_secret) return res.status(503).json({ ok: false, message: 'Direct poster upload is not configured.' });
      const timestamp = Math.floor(Date.now() / 1000);
      const params = { folder: FOLDER, timestamp };
      const signature = cloudinary.utils.api_sign_request(params, config.api_secret);
      const prefix = String(config.upload_prefix || 'https://api.cloudinary.com').replace(/\/$/, '');
      return res.json({ ok: true, uploadUrl: `${prefix}/v1_1/${encodeURIComponent(config.cloud_name)}/image/upload`, fields: { api_key: config.api_key, timestamp, folder: FOLDER, signature } });
    } catch (error) {
      console.error('[poster-direct-upload] signature failed:', error);
      return res.status(500).json({ ok: false, message: 'Could not prepare the poster upload.' });
    }
  });

  app.post('/api/admin/fights/:fightId/social-poster/confirm', verifyAdminToken, async (req, res) => {
    try {
      const fightId = String(req.params.fightId || '');
      if (!OBJECT_ID.test(fightId)) return res.status(400).json({ ok: false, message: 'Invalid fight ID.' });
      const secureUrl = String(req.body?.secure_url || '').trim();
      const publicId = String(req.body?.public_id || '').trim();
      const version = String(req.body?.version || '').trim();
      const signature = String(req.body?.signature || '').trim();
      const config = cloudinary.config();
      if (!publicId.startsWith(`${FOLDER}/`) || !version || !signature) return res.status(400).json({ ok: false, message: 'The poster upload was incomplete. Please upload it again.' });
      // The library signs (public_id, version) with our secret: proof that
      // this exact upload really happened in our own account.
      const expected = cloudinary.utils.api_sign_request({ public_id: publicId, version }, config.api_secret);
      if (expected !== signature) return res.status(400).json({ ok: false, message: 'The poster upload could not be verified. Please upload it again.' });
      let parsed;
      try { parsed = new URL(secureUrl); } catch { return res.status(400).json({ ok: false, message: 'The poster address is not valid.' }); }
      const host = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
      const ownLibrary = parsed.protocol === 'https:' && parsed.hostname === 'res.cloudinary.com' && parsed.pathname.startsWith(`/${config.cloud_name}/image/upload/`);
      if (!ownLibrary && !allowedSourceHosts().has(host.toLowerCase())) return res.status(400).json({ ok: false, message: 'The poster was not stored in the FANTASY MMADNESS image library.' });
      if (!decodeURIComponent(parsed.pathname).includes(publicId)) return res.status(400).json({ ok: false, message: 'The poster upload did not match. Please upload it again.' });
      const fight = await findFightDoc(fightId);
      if (!fight) return res.status(404).json({ ok: false, message: 'Fight not found.' });
      const previous = fight.fightPosterImageDeleteUrl;
      fight.fightPosterImage = secureUrl;
      fight.fightPosterImageDeleteUrl = publicId;
      await fight.save();
      if (typeof app.locals.clearPublicResponseCache === 'function') app.locals.clearPublicResponseCache();
      if (previous && previous !== publicId) cloudinary.uploader.destroy(previous).catch((error) => console.error('Old social poster cleanup failed:', error));
      return res.json({ poster: secureUrl, exact: true });
    } catch (error) {
      console.error('[poster-direct-upload] confirm failed:', error);
      return res.status(500).json({ ok: false, message: 'Could not save the fight poster.' });
    }
  });
};

module.exports.affiliateFromLink = affiliateFromLink;
module.exports.readQr = readQr;
