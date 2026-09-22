'use strict';

const clampNumber = (value, min, max, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};
const clean = (value, max = 240) => String(value || '').trim().slice(0, max);
const slugify = (value) => clean(value, 120).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'fight-card';
const hashToken = (crypto, value) => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const publicCode = (crypto) => crypto.randomBytes(5).toString('hex');
const inviteToken = (crypto) => crypto.randomBytes(32).toString('base64url');
const validId = (mongoose, id) => mongoose.Types.ObjectId.isValid(String(id || ''));

module.exports = function registerFullCardPromoter({
  app, mongoose, crypto, Affiliate, Match, Score, User, verifyToken, verifyAdminToken,
  requireScope, affiliateScope, playerScope, calculateClassicPredictionPoints,
  clearPublicResponseCache, appOrigin, upload, cloudinary,
}) {
  const boutSchema = new mongoose.Schema({
    fightId: { type: mongoose.Schema.Types.ObjectId, ref: 'Match', default: null },
    order: { type: Number, required: true },
    cardSection: { type: String, enum: ['PRELIM', 'MAIN_CARD'], default: 'MAIN_CARD' },
    boutLabel: { type: String, default: '' },
    category: { type: String, enum: ['boxing', 'mma', 'kickboxing', 'Bare-knuckle', 'pro-wrestling'], required: true },
    fighterAName: { type: String, required: true },
    fighterAImage: { type: String, default: '' },
    fighterBName: { type: String, required: true },
    fighterBImage: { type: String, default: '' },
    pot: { type: Number, min: 0, default: 0 },
    entryTokens: { type: Number, min: 0, default: 0 },
    status: { type: String, enum: ['SCHEDULED', 'LIVE', 'COMPLETED', 'CANCELLED', 'REMOVED'], default: 'SCHEDULED' },
    replacementPending: { type: Object, default: null },
  }, { _id: true });

  const fullCardSchema = new mongoose.Schema({
    affiliateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Affiliate', required: true, index: true },
    eventName: { type: String, required: true },
    organizationName: { type: String, default: '' },
    eventPoster: { type: String, default: '' },
    promotionLogo: { type: String, default: '' },
    eventDate: { type: Date, required: true, index: true },
    startTime: { type: String, default: '' },
    venue: { type: String, default: '' },
    location: { type: String, default: '' },
    description: { type: String, default: '' },
    slug: { type: String, required: true, index: true },
    promoterCode: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: ['DRAFT', 'UPCOMING', 'LIVE', 'COMPLETED', 'CANCELLED', 'UNPUBLISHED'], default: 'DRAFT', index: true },
    lockedAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
    fullCardPrize: { type: Number, min: 0, default: 0 },
    bouts: { type: [boutSchema], default: [] },
    analytics: {
      pageViews: { type: Number, default: 0 },
      uniqueVisitors: { type: Number, default: 0 },
      shareClicks: { type: Number, default: 0 },
      qrScans: { type: Number, default: 0 },
      visitorHashes: { type: [String], default: [], select: false },
    },
    unpublishedReason: { type: String, default: '' },
  }, { timestamps: true });
  fullCardSchema.index({ affiliateId: 1, status: 1, eventDate: -1 });
  fullCardSchema.index({ slug: 1, promoterCode: 1 }, { unique: true });

  const promoterInviteSchema = new mongoose.Schema({
    tokenHash: { type: String, required: true, unique: true, index: true, select: false },
    affiliateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Affiliate', required: true, index: true },
    expiresAt: { type: Date, required: true, index: true },
    acceptedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    createdBy: { type: String, default: '' },
    allowGrandPrize: { type: Boolean, default: false },
    note: { type: String, default: '' },
  }, { timestamps: true });

  const FullCard = mongoose.models.FullCard || mongoose.model('FullCard', fullCardSchema);
  const PromoterInvite = mongoose.models.PromoterInvite || mongoose.model('PromoterInvite', promoterInviteSchema);

  const affiliateIdFrom = (req) => String(req.user?.id || req.user?._id || '');
  const requirePromoter = async (req, res, next) => {
    try {
      const affiliate = await Affiliate.findById(affiliateIdFrom(req))
        .select('_id firstName lastName playerName verified promoterRole canCreateFullCards canOfferFullCardPrize promoterSuspendedAt').lean();
      if (!affiliate) return res.status(404).json({ ok: false, message: 'Affiliate account not found.' });
      if (!affiliate.verified || !affiliate.canCreateFullCards || affiliate.promoterSuspendedAt) {
        return res.status(403).json({ ok: false, message: 'Full Card tools require active promoter approval.', code: 'FULL_CARD_ACCESS_REQUIRED' });
      }
      req.promoter = affiliate;
      return next();
    } catch (error) {
      return res.status(500).json({ ok: false, message: 'Could not verify promoter access.' });
    }
  };
  const promoterAuth = [verifyToken, requireScope(affiliateScope), requirePromoter];

  app.post('/api/affiliates/me/full-card-media', ...promoterAuth, upload.single('image'), async (req, res) => {
    if (!req.file?.buffer) return res.status(400).json({ ok: false, message: 'Choose an image to upload.' });
    try {
      const uploaded = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream({ folder: `fantasymmadness/full-cards/${req.promoter._id}`, resource_type: 'image' }, (error, result) => error ? reject(error) : resolve(result));
        stream.end(req.file.buffer);
      });
      return res.status(201).json({ ok: true, url: uploaded.secure_url });
    } catch (error) { return res.status(500).json({ ok: false, message: 'Could not upload that image.' }); }
  });

  const normalizeBouts = (rows = []) => (Array.isArray(rows) ? rows : []).slice(0, 30).map((row, index) => ({
    ...(validId(mongoose, row.fightId) ? { fightId: row.fightId } : {}),
    order: index + 1,
    cardSection: String(row.cardSection || 'MAIN_CARD').toUpperCase() === 'PRELIM' ? 'PRELIM' : 'MAIN_CARD',
    boutLabel: clean(row.boutLabel || (index === 0 ? 'MAIN EVENT' : index === 1 ? 'CO-MAIN EVENT' : `FIGHT #${index + 1}`), 50),
    category: ['boxing', 'mma', 'kickboxing', 'Bare-knuckle', 'pro-wrestling'].includes(row.category) ? row.category : 'boxing',
    fighterAName: clean(row.fighterAName, 100), fighterAImage: clean(row.fighterAImage, 2000),
    fighterBName: clean(row.fighterBName, 100), fighterBImage: clean(row.fighterBImage, 2000),
    pot: clampNumber(row.pot, 0, 100000000, 0), entryTokens: clampNumber(row.entryTokens, 0, 10000000, 0),
    status: ['SCHEDULED', 'LIVE', 'COMPLETED', 'CANCELLED', 'REMOVED'].includes(row.status) ? row.status : 'SCHEDULED',
  })).filter((row) => row.fighterAName && row.fighterBName);

  const cardPayload = (card, promoter = null) => ({
    id: card._id, eventName: card.eventName, organizationName: card.organizationName,
    eventPoster: card.eventPoster, promotionLogo: card.promotionLogo, eventDate: card.eventDate,
    startTime: card.startTime, venue: card.venue, location: card.location, description: card.description,
    slug: card.slug, promoterCode: card.promoterCode, status: card.status, lockedAt: card.lockedAt,
    publishedAt: card.publishedAt, fullCardPrize: card.fullCardPrize, bouts: card.bouts,
    promoter: promoter ? { id: promoter._id, name: promoter.playerName || [promoter.firstName, promoter.lastName].filter(Boolean).join(' '), verified: true } : undefined,
    shareUrl: `${String(appOrigin || 'https://fantasymmadness.com').replace(/\/$/, '')}/card/${card.slug}/${card.promoterCode}`,
  });

  // Admin permission + secure invitation lifecycle.
  app.patch('/api/admin/full-card-promoters/:affiliateId', verifyAdminToken, async (req, res) => {
    try {
      if (!validId(mongoose, req.params.affiliateId)) return res.status(400).json({ ok: false, message: 'Invalid affiliate ID.' });
      const update = {};
      if (typeof req.body?.enabled === 'boolean') {
        update.canCreateFullCards = req.body.enabled;
        // The owner's approval also completes affiliate verification, which
        // requirePromoter checks on every request.
        if (req.body.enabled) update.verified = true;
      }
      if (typeof req.body?.allowGrandPrize === 'boolean') update.canOfferFullCardPrize = req.body.allowGrandPrize;
      if (req.body?.role) update.promoterRole = ['STANDARD', 'PROMOTER', 'PARTNER'].includes(req.body.role) ? req.body.role : 'PROMOTER';
      if (typeof req.body?.suspended === 'boolean') update.promoterSuspendedAt = req.body.suspended ? new Date() : null;
      if (req.body?.enabled) {
        update.promoterVerifiedAt = new Date();
        update.promoterSuspendedAt = null;
        if (!req.body?.role) update.promoterRole = 'PROMOTER';
      }
      const affiliate = await Affiliate.findByIdAndUpdate(req.params.affiliateId, { $set: update }, { new: true })
        .select('_id firstName lastName playerName email verified promoterRole canCreateFullCards canOfferFullCardPrize promoterSuspendedAt').lean();
      if (!affiliate) return res.status(404).json({ ok: false, message: 'Affiliate not found.' });
      if (req.body?.enabled === false || req.body?.suspended === true) {
        await PromoterInvite.updateMany({ affiliateId: affiliate._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
      }
      return res.json({ ok: true, affiliate });
    } catch (error) { return res.status(500).json({ ok: false, message: 'Could not update promoter access.' }); }
  });

  app.post('/api/admin/full-card-promoter-invites', verifyAdminToken, async (req, res) => {
    try {
      const affiliateId = clean(req.body?.affiliateId, 80);
      if (!validId(mongoose, affiliateId) || !(await Affiliate.exists({ _id: affiliateId }))) return res.status(404).json({ ok: false, message: 'Affiliate not found.' });
      const raw = inviteToken(crypto);
      const days = clampNumber(req.body?.expiresInDays, 1, 30, 14);
      const invite = await PromoterInvite.create({
        tokenHash: hashToken(crypto, raw), affiliateId,
        expiresAt: new Date(Date.now() + days * 86400000), createdBy: String(req.admin?.id || req.admin?._id || ''),
        allowGrandPrize: Boolean(req.body?.allowGrandPrize), note: clean(req.body?.note, 300),
      });
      // Sending a private invitation is itself the owner's approval. The
      // designated affiliate can use Full Card tools immediately after login.
      await Affiliate.updateOne({ _id: affiliateId }, { $set: {
        verified: true, promoterRole: 'PROMOTER', canCreateFullCards: true,
        promoterVerifiedAt: new Date(), promoterSuspendedAt: null,
      } });
      return res.status(201).json({ ok: true, inviteId: invite._id, expiresAt: invite.expiresAt, url: `${String(appOrigin).replace(/\/$/, '')}/promoter/invite/${raw}` });
    } catch (error) { return res.status(500).json({ ok: false, message: 'Could not create invitation.' }); }
  });

  app.get('/api/admin/full-card-promoter-invites', verifyAdminToken, async (_req, res) => {
    const rows = await PromoterInvite.find().select('+tokenHash').populate('affiliateId', 'firstName lastName playerName email').sort({ createdAt: -1 }).limit(200).lean();
    return res.json({ ok: true, invitations: rows.map(({ tokenHash, ...row }) => row) });
  });
  app.patch('/api/admin/full-card-promoter-invites/:id/revoke', verifyAdminToken, async (req, res) => {
    const row = await PromoterInvite.findByIdAndUpdate(req.params.id, { $set: { revokedAt: new Date() } }, { new: true }).lean();
    return row ? res.json({ ok: true }) : res.status(404).json({ ok: false, message: 'Invitation not found.' });
  });

  app.get('/api/full-card-promoter-invites/:token', async (req, res) => {
    const row = await PromoterInvite.findOne({ tokenHash: hashToken(crypto, req.params.token) }).select('+tokenHash').populate('affiliateId', 'firstName lastName playerName').lean();
    const active = Boolean(row && !row.revokedAt && !row.acceptedAt && new Date(row.expiresAt) > new Date());
    return active ? res.json({ ok: true, expiresAt: row.expiresAt, promoterName: row.affiliateId?.playerName || row.affiliateId?.firstName || 'Affiliate' }) : res.status(410).json({ ok: false, message: 'This invitation is expired, revoked, or already used.' });
  });
  app.post('/api/full-card-promoter-invites/:token/accept', verifyToken, requireScope(affiliateScope), async (req, res) => {
    const affiliateId = affiliateIdFrom(req);
    const now = new Date();
    const row = await PromoterInvite.findOne({ tokenHash: hashToken(crypto, req.params.token), affiliateId, revokedAt: null, expiresAt: { $gt: now } }).lean();
    if (!row) return res.status(410).json({ ok: false, message: 'This invitation is unavailable for this account.' });
    const affiliate = await Affiliate.findById(affiliateId).select('verified canCreateFullCards promoterSuspendedAt').lean();
    if (!affiliate || affiliate.promoterSuspendedAt) return res.status(403).json({ ok: false, message: 'Promoter access has been disabled. Contact the owner.' });
    // Previously issued invitations still work for affiliates who had not
    // accepted them before this immediate-approval flow was deployed.
    if (!affiliate.canCreateFullCards) await Affiliate.updateOne({ _id: affiliateId }, { $set: {
      verified: true, promoterRole: 'PROMOTER', canCreateFullCards: true,
      canOfferFullCardPrize: row.allowGrandPrize, promoterVerifiedAt: now,
    } });
    if (!row.acceptedAt) await PromoterInvite.updateOne({ _id: row._id, acceptedAt: null }, { $set: { acceptedAt: now } });
    return res.json({ ok: true, message: 'Promoter access is active.' });
  });

  // Promoter card management.
  app.get('/api/affiliates/me/full-cards', ...promoterAuth, async (req, res) => {
    const cards = await FullCard.find({ affiliateId: req.promoter._id }).sort({ eventDate: -1, createdAt: -1 }).lean();
    return res.json({ ok: true, permission: { role: req.promoter.promoterRole, canOfferFullCardPrize: req.promoter.canOfferFullCardPrize }, cards: cards.map((card) => ({ ...cardPayload(card), analytics: card.analytics })) });
  });
  app.post('/api/affiliates/me/full-cards', ...promoterAuth, async (req, res) => {
    try {
      const eventName = clean(req.body?.eventName, 140);
      const eventDate = new Date(req.body?.eventDate);
      if (!eventName || Number.isNaN(eventDate.getTime())) return res.status(422).json({ ok: false, message: 'Event name and date are required.' });
      const prize = req.promoter.canOfferFullCardPrize ? clampNumber(req.body?.fullCardPrize, 0, 100000000, 0) : 0;
      const card = await FullCard.create({
        affiliateId: req.promoter._id, eventName, organizationName: clean(req.body?.organizationName, 140),
        eventPoster: clean(req.body?.eventPoster, 1200), promotionLogo: clean(req.body?.promotionLogo, 1200), eventDate,
        startTime: clean(req.body?.startTime, 20), venue: clean(req.body?.venue, 140), location: clean(req.body?.location, 140),
        description: clean(req.body?.description, 1200), slug: `${slugify(eventName)}-${Date.now().toString(36)}`,
        promoterCode: publicCode(crypto), fullCardPrize: prize, bouts: normalizeBouts(req.body?.bouts),
      });
      return res.status(201).json({ ok: true, card: cardPayload(card) });
    } catch (error) { return res.status(500).json({ ok: false, message: 'Could not create the Full Card.' }); }
  });
  app.get('/api/affiliates/me/full-cards/:cardId', ...promoterAuth, async (req, res) => {
    const card = await FullCard.findOne({ _id: req.params.cardId, affiliateId: req.promoter._id }).lean();
    return card ? res.json({ ok: true, card: cardPayload(card) }) : res.status(404).json({ ok: false, message: 'Full Card not found.' });
  });
  app.put('/api/affiliates/me/full-cards/:cardId', ...promoterAuth, async (req, res) => {
    const card = await FullCard.findOne({ _id: req.params.cardId, affiliateId: req.promoter._id });
    if (!card) return res.status(404).json({ ok: false, message: 'Full Card not found.' });
    if (card.lockedAt) return res.status(409).json({ ok: false, message: 'This card is locked. Request an administrator change.', code: 'CARD_LOCKED' });
    ['eventName', 'organizationName', 'eventPoster', 'promotionLogo', 'startTime', 'venue', 'location', 'description'].forEach((key) => { if (req.body?.[key] !== undefined) card[key] = clean(req.body[key], key === 'description' ? 1200 : key.includes('Poster') || key.includes('Logo') ? 1200 : 140); });
    if (req.body?.eventDate) card.eventDate = new Date(req.body.eventDate);
    if (req.body?.bouts) card.bouts = normalizeBouts(req.body.bouts);
    if (req.body?.fullCardPrize !== undefined && req.promoter.canOfferFullCardPrize) card.fullCardPrize = clampNumber(req.body.fullCardPrize, 0, 100000000, 0);
    await card.save();
    return res.json({ ok: true, card: cardPayload(card.toObject()) });
  });

  const materializeBouts = async (card) => {
    for (const bout of card.bouts) {
      if (bout.fightId || ['CANCELLED', 'REMOVED'].includes(bout.status)) continue;
      const fight = await Match.create({
        matchName: `${card.eventName} — ${bout.boutLabel}`, matchFighterA: bout.fighterAName, matchFighterB: bout.fighterBName,
        fighterAImage: bout.fighterAImage, fighterBImage: bout.fighterBImage, matchCategory: bout.category,
        matchDate: card.eventDate, matchTime: card.startTime, venue: card.venue, eventCity: card.location,
        pot: bout.pot, matchTokens: bout.entryTokens, affiliateId: String(card.affiliateId), matchBy: 'affiliate',
        matchStatus: 'Scheduled', matchShadowStatus: 'active', homepagePromoted: false,
        fullCardId: String(card._id), fullCardBoutOrder: bout.order,
      });
      bout.fightId = fight._id;
    }
  };
  app.post('/api/affiliates/me/full-cards/:cardId/publish', ...promoterAuth, async (req, res) => {
    const card = await FullCard.findOne({ _id: req.params.cardId, affiliateId: req.promoter._id });
    if (!card) return res.status(404).json({ ok: false, message: 'Full Card not found.' });
    if (card.bouts.length < 1) return res.status(422).json({ ok: false, message: 'Add at least one complete fight before publishing.' });
    await materializeBouts(card);
    card.status = 'UPCOMING'; card.publishedAt = card.publishedAt || new Date(); await card.save();
    clearPublicResponseCache?.();
    return res.json({ ok: true, card: cardPayload(card.toObject()) });
  });
  app.post('/api/affiliates/me/full-cards/:cardId/lock', ...promoterAuth, async (req, res) => {
    const card = await FullCard.findOneAndUpdate({ _id: req.params.cardId, affiliateId: req.promoter._id, lockedAt: null }, { $set: { lockedAt: new Date() } }, { new: true }).lean();
    return card ? res.json({ ok: true, card: cardPayload(card) }) : res.status(409).json({ ok: false, message: 'Card not found or already locked.' });
  });

  // Public event, progress and aggregate leaderboard.
  app.get('/api/full-cards/:slug/:promoterCode', async (req, res) => {
    const card = await FullCard.findOne({ slug: req.params.slug, promoterCode: req.params.promoterCode, status: { $in: ['UPCOMING', 'LIVE', 'COMPLETED'] } });
    if (!card) return res.status(404).json({ ok: false, message: 'Full Card not found.' });
    const promoter = await Affiliate.findById(card.affiliateId).select('_id firstName lastName playerName').lean();
    const visitor = hashToken(crypto, req.headers['x-fmm-visitor'] || `${req.ip}|${req.headers['user-agent'] || ''}`);
    const seen = (card.analytics.visitorHashes || []).includes(visitor);
    await FullCard.updateOne({ _id: card._id }, { $inc: { 'analytics.pageViews': 1, ...(seen ? {} : { 'analytics.uniqueVisitors': 1 }) }, ...(seen ? {} : { $addToSet: { 'analytics.visitorHashes': visitor } }) });
    return res.json({ ok: true, card: cardPayload(card.toObject(), promoter) });
  });
  app.post('/api/full-cards/:cardId/track', async (req, res) => {
    const field = req.body?.type === 'qr' ? 'analytics.qrScans' : 'analytics.shareClicks';
    await FullCard.updateOne({ _id: req.params.cardId }, { $inc: { [field]: 1 } });
    return res.json({ ok: true });
  });

  const buildLeaderboard = async (card) => {
    const activeBouts = card.bouts.filter((b) => b.fightId && !['CANCELLED', 'REMOVED'].includes(b.status));
    const fightIds = activeBouts.map((b) => String(b.fightId));
    const [fights, scores] = await Promise.all([Match.find({ _id: { $in: fightIds } }).lean(), Score.find({ matchId: { $in: fightIds }, refunded: { $ne: true } }).lean()]);
    const fightById = new Map(fights.map((f) => [String(f._id), f]));
    const totals = new Map();
    scores.forEach((row) => {
      const fight = fightById.get(String(row.matchId)); if (!fight) return;
      const category = String(fight.matchCategory || '').toLowerCase();
      const one = category === 'boxing' || category === 'bare-knuckle' ? fight?.BoxingMatch?.fighterOneStats : fight?.MMAMatch?.fighterOneStats;
      const two = category === 'boxing' || category === 'bare-knuckle' ? fight?.BoxingMatch?.fighterTwoStats : fight?.MMAMatch?.fighterTwoStats;
      const scored = Array.isArray(one) && Array.isArray(two);
      const current = totals.get(String(row.playerId)) || { userId: String(row.playerId), totalPoints: 0, fightsPredicted: 0, fightsScored: 0 };
      current.fightsPredicted += 1;
      if (scored) { current.totalPoints += calculateClassicPredictionPoints(row.predictions, one, two, category); current.fightsScored += 1; }
      totals.set(current.userId, current);
    });
    const ranked = [...totals.values()].sort((a, b) => b.totalPoints - a.totalPoints);
    const users = await User.find({ _id: { $in: ranked.map((r) => r.userId).filter((id) => validId(mongoose, id)) } }).select('playerName firstName lastName profileUrl').lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    return ranked.map((row, index) => ({ ...row, rank: index + 1, name: byId.get(row.userId)?.playerName || byId.get(row.userId)?.firstName || 'Player', profileUrl: byId.get(row.userId)?.profileUrl || '' }));
  };
  app.get('/api/full-cards/:cardId/leaderboard', async (req, res) => {
    const card = await FullCard.findById(req.params.cardId).lean();
    if (!card || !['UPCOMING', 'LIVE', 'COMPLETED'].includes(card.status)) return res.status(404).json({ ok: false, message: 'Full Card not found.' });
    const leaderboard = await buildLeaderboard(card);
    return res.json({ ok: true, leaderboard: leaderboard.slice(0, 100), fights: card.bouts.filter((b) => !['CANCELLED', 'REMOVED'].includes(b.status)).length });
  });
  app.get('/api/full-cards/:cardId/progress', verifyToken, requireScope(playerScope), async (req, res) => {
    const card = await FullCard.findById(req.params.cardId).lean();
    if (!card) return res.status(404).json({ ok: false, message: 'Full Card not found.' });
    const fightIds = card.bouts.filter((b) => b.fightId && !['CANCELLED', 'REMOVED'].includes(b.status)).map((b) => String(b.fightId));
    const completed = await Score.find({ playerId: String(req.user?.id || req.user?._id), matchId: { $in: fightIds }, refunded: { $ne: true } }).distinct('matchId');
    return res.json({ ok: true, predicted: completed.length, total: fightIds.length, percent: fightIds.length ? Math.round(completed.length / fightIds.length * 100) : 0, nextFightId: fightIds.find((id) => !completed.map(String).includes(id)) || null, lockedIn: Boolean(fightIds.length && completed.length === fightIds.length) });
  });

  // Admin control center.
  app.get('/api/admin/full-cards', verifyAdminToken, async (req, res) => {
    const cards = await FullCard.find().populate('affiliateId', 'firstName lastName playerName email promoterRole').sort({ createdAt: -1 }).limit(300).lean();
    return res.json({ ok: true, cards: cards.map((card) => ({ ...cardPayload(card, card.affiliateId), analytics: card.analytics })) });
  });
  app.patch('/api/admin/full-cards/:cardId', verifyAdminToken, async (req, res) => {
    const update = {};
    if (['DRAFT', 'UPCOMING', 'LIVE', 'COMPLETED', 'CANCELLED', 'UNPUBLISHED'].includes(req.body?.status)) update.status = req.body.status;
    if (typeof req.body?.locked === 'boolean') update.lockedAt = req.body.locked ? new Date() : null;
    if (req.body?.reason !== undefined) update.unpublishedReason = clean(req.body.reason, 300);
    const card = await FullCard.findByIdAndUpdate(req.params.cardId, { $set: update }, { new: true }).lean();
    return card ? res.json({ ok: true, card: cardPayload(card) }) : res.status(404).json({ ok: false, message: 'Full Card not found.' });
  });

  return { FullCard, PromoterInvite, helpers: { slugify, hashToken } };
};

module.exports.helpers = { clampNumber, clean, slugify, hashToken };
