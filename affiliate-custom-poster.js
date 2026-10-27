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

const SITE_URL = 'https://www.fantasymmadness.com';
const OBJECT_ID = /^[a-f\d]{24}$/i;
const MIN_QR_PIXELS = 96;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

// Same rule as fmm-ver2/src/Utils/affiliatePublicLink.js getAffiliateFightShareUrl
// for a saved affiliate id: the ID-style league link with the fight id.
function affiliateLeagueFightLink(affiliateId, fightId) {
  return `${SITE_URL}/league/${encodeURIComponent(String(affiliateId))}?fightId=${encodeURIComponent(String(fightId))}`;
}

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

// Stored image bytes come back as a Buffer (document) or a BSON Binary (lean).
function imageBytes(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value && value._bsontype === 'Binary') return Buffer.from(value.buffer);
  return Buffer.from(value || []);
}

module.exports = function registerAffiliateCustomPosters({ app, mongoose, verifyAdminToken, cloudinary, sharp, QRCode, fetchImpl = fetch }) {
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
  }, { timestamps: true, collection: 'affiliatecustomposters' });
  const AffiliateCustomPoster = mongoose.models.AffiliateCustomPoster || mongoose.model('AffiliateCustomPoster', posterSchema);

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
  });

  const fail = (res, error, fallback) => {
    if (error?.status) return res.status(error.status).json({ ok: false, message: error.message });
    console.error(`[affiliate-custom-poster] ${fallback}:`, error);
    return res.status(500).json({ ok: false, message: fallback });
  };

  // Build a finished poster for one affiliate (not sent, not approved).
  app.post('/api/admin/affiliate-posters/preview', verifyAdminToken, async (req, res) => {
    try {
      const fightId = String(req.body?.fightId || '').trim();
      const affiliateId = String(req.body?.affiliateId || '').trim();
      if (!OBJECT_ID.test(fightId) || !OBJECT_ID.test(affiliateId)) return res.status(400).json({ ok: false, message: 'Choose a fight and an affiliate first.' });
      const found = await findFight(fightId);
      if (!found) return res.status(404).json({ ok: false, message: 'Fight not found.' });
      const saved = savedPosterFor(found.fight);
      if (!saved) return res.status(409).json({ ok: false, message: 'Upload your finished poster for this fight first.' });
      const expected = String(req.body?.sourcePosterUrl || '').trim();
      if (expected && expected !== saved) {
        return res.status(409).json({ ok: false, code: 'POSTER_CHANGED', message: 'A different poster is saved for this fight than the one on your screen. Reload the page and place the QR again.', savedPosterUrl: saved });
      }
      const affiliate = await Affiliate.findById(affiliateId).select('_id email firstName lastName verified').lean();
      if (!affiliate) return res.status(404).json({ ok: false, message: 'Affiliate not found.' });
      const qrLink = affiliateLeagueFightLink(affiliate._id, fightId);
      const source = await loadSourceImage(saved);
      const built = await compose({ source, qrLink, qr: req.body?.qr || {} });
      const sha256 = crypto.createHash('sha256').update(built.output).digest('hex');
      const imageUrl = await storeImage(built.output, built.contentType).catch((error) => {
        console.error('[affiliate-custom-poster] image copy upload failed:', error?.message);
        return '';
      });
      const doc = await AffiliateCustomPoster.create({
        fightId, fightSource: found.source, affiliateId: String(affiliate._id), affiliateEmail: String(affiliate.email || '').toLowerCase(),
        sourcePosterUrl: saved, sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
        qrLink, qr: built.qr, width: built.width, height: built.height, contentType: built.contentType,
        image: built.output, sha256, bytes: built.output.length, imageUrl, status: 'preview', createdBy: adminName(req),
      });
      return res.status(201).json({ ok: true, poster: publicPoster(doc) });
    } catch (error) { return fail(res, error, 'Could not build the finished poster.'); }
  });

  // Exact bytes of a finished poster, for the owner's preview.
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

  // The owner approves exactly this finished poster.
  app.post('/api/admin/affiliate-posters/:id/approve', verifyAdminToken, async (req, res) => {
    try {
      if (!OBJECT_ID.test(String(req.params.id || ''))) return res.status(400).json({ ok: false, message: 'Invalid poster.' });
      const doc = await AffiliateCustomPoster.findById(req.params.id);
      if (!doc) return res.status(404).json({ ok: false, message: 'Finished poster not found.' });
      if (doc.status === 'superseded') return res.status(409).json({ ok: false, message: 'A newer finished poster replaced this one. Approve the newest version.' });
      const found = await findFight(doc.fightId);
      if (!found || savedPosterFor(found.fight) !== doc.sourcePosterUrl) {
        return res.status(409).json({ ok: false, code: 'POSTER_CHANGED', message: 'The fight poster was replaced after this preview was made. Place the QR again and approve the new preview.' });
      }
      await AffiliateCustomPoster.updateMany(
        { _id: { $ne: doc._id }, fightId: doc.fightId, affiliateId: doc.affiliateId, status: 'approved' },
        { $set: { status: 'superseded' } },
      );
      doc.status = 'approved';
      doc.approvedAt = new Date();
      doc.approvedBy = adminName(req);
      await doc.save();
      return res.json({ ok: true, poster: publicPoster(doc) });
    } catch (error) { return fail(res, error, 'Could not approve the finished poster.'); }
  });

  // Used by /send-email-affiliate: returns the approved image for this exact
  // fight + recipient, or explains why it cannot be sent.
  async function forEmail({ posterId, fightId, email }) {
    if (!OBJECT_ID.test(String(posterId || ''))) throw httpError(400, 'The approved poster reference is not valid.');
    const doc = await AffiliateCustomPoster.findById(posterId);
    if (!doc) throw httpError(404, 'The approved poster could not be found. Approve it again before sending.');
    if (doc.status !== 'approved') throw httpError(409, 'This finished poster has not been approved (or a newer one replaced it). Approve it before sending.');
    if (String(fightId || '') !== doc.fightId) throw httpError(409, 'The approved poster belongs to a different fight.');
    const recipient = String(email || '').trim().toLowerCase();
    const affiliate = await Affiliate.findById(doc.affiliateId).select('_id email firstName').lean();
    if (!affiliate || String(affiliate.email || '').trim().toLowerCase() !== recipient) {
      throw httpError(409, 'This finished poster was made for a different affiliate. It was not sent.');
    }
    const found = await findFight(doc.fightId);
    if (!found || savedPosterFor(found.fight) !== doc.sourcePosterUrl) {
      throw httpError(409, 'The fight poster was replaced after you approved this finished poster. Make and approve a new one before sending.');
    }
    const image = imageBytes(doc.image);
    if (crypto.createHash('sha256').update(image).digest('hex') !== doc.sha256) throw httpError(500, 'The approved poster failed its integrity check. It was not sent.');
    const ext = doc.contentType === 'image/jpeg' ? 'jpg' : doc.contentType.replace('image/', '');
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

  app.locals.affiliateCustomPoster = { forEmail, markSent, affiliateLeagueFightLink };
  return { AffiliateCustomPoster, forEmail, markSent, compose, affiliateLeagueFightLink };
};

module.exports.affiliateLeagueFightLink = affiliateLeagueFightLink;
