'use strict';

/**
 * Safe fight data-quality helpers.
 *
 * These routes are additive. They do not change legacy fight creation/listing routes.
 * Destructive actions require explicit admin IDs and default to dry-run.
 */

const DEFAULT_SCORING_CONFIG = Object.freeze({
  version: 'combat-round-outcome-v1',
  points: {
    KO: 500,
    SP: 25,
    RW: 100,
    RL: 25,
  },
  labels: {
    KO: 'Knockout / finish bonus',
    SP: 'Survival points when fighter was not knocked out in the round',
    RW: 'Round win points',
    RL: 'Round loss participation points',
  },
  ui: {
    outcomeInput: 'radio',
    roundWinnerOptions: ['fighterA', 'fighterB', 'draw', 'none'],
    knockoutOptions: ['none', 'fighterA_KO', 'fighterB_KO'],
    deriveOpponentOutcome: true,
    survivalDerivedFromKnockout: true,
  },
});

function registerFightDataQualityRoutes(options) {
  const { app, mongoose, verifyAdminToken, Match, axios } = options || {};
  if (!app || !mongoose || !verifyAdminToken || !Match) {
    throw new Error('registerFightDataQualityRoutes requires app, mongoose, verifyAdminToken, and Match.');
  }

  const CombatFighter = buildCombatFighterModel(mongoose);
  const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  app.get('/api/scoring-config', asyncHandler(async (req, res) => {
    res.json({ ok: true, source: 'backend-default', config: DEFAULT_SCORING_CONFIG });
  }));

  app.get('/api/admin/fights/scoring-config', verifyAdminToken, asyncHandler(async (req, res) => {
    res.json({ ok: true, source: 'backend-default', config: DEFAULT_SCORING_CONFIG });
  }));

  app.get('/api/admin/fights/data-quality/duplicates', verifyAdminToken, asyncHandler(async (req, res) => {
    const limit = clamp(toInt(req.query.limit, 500), 1, 2000);
    const includeFinished = parseBool(req.query.includeFinished, true);
    const filter = includeFinished ? {} : { matchStatus: { $ne: 'Finished' } };
    const matches = await Match.find(filter)
      .select('_id matchName matchCategory matchCategoryTwo matchFighterA matchFighterB matchType matchStatus maxRounds matchDate createdAt updatedAt fighterAImage fighterBImage promotionBackground BoxingMatch MMAMatch')
      .sort({ updatedAt: -1, _id: -1 })
      .limit(limit)
      .lean();

    const groups = groupDuplicateMatches(matches);
    res.json({
      ok: true,
      inspected: matches.length,
      duplicateGroupCount: groups.length,
      groups,
      strategy: 'Grouped by normalized fighter pair + category + secondary category + maxRounds. Admin should review before deleting because LIVE and SHADOW versions may intentionally coexist.',
    });
  }));

  app.post('/api/admin/fights/data-quality/duplicates/delete', verifyAdminToken, asyncHandler(async (req, res) => {
    const ids = normalizeObjectIdArray(req.body?.ids, mongoose);
    const dryRun = parseBool(req.body?.dryRun, true);
    if (!ids.length) return res.status(400).json({ ok: false, code: 'MATCH_IDS_REQUIRED', message: 'Provide ids array with match IDs to delete.' });

    const matches = await Match.find({ _id: { $in: ids } })
      .select('_id matchName matchFighterA matchFighterB matchType matchStatus createdAt updatedAt')
      .lean();

    if (dryRun) {
      return res.json({ ok: true, dryRun: true, deleteCount: matches.length, matches });
    }

    const result = await Match.deleteMany({ _id: { $in: matches.map((match) => match._id) } });
    res.json({ ok: true, dryRun: false, deletedCount: result.deletedCount || 0, deletedMatches: matches });
  }));

  app.get('/api/admin/fights/data-quality/image-health', verifyAdminToken, asyncHandler(async (req, res) => {
    const limit = clamp(toInt(req.query.limit, 100), 1, 500);
    const check = parseBool(req.query.check, false);
    const onlyBroken = parseBool(req.query.onlyBroken, false);
    const matches = await Match.find({})
      .select('_id matchName matchFighterA matchFighterB matchType matchStatus fighterAImage fighterBImage promotionBackground updatedAt')
      .sort({ updatedAt: -1, _id: -1 })
      .limit(limit)
      .lean();

    const rows = [];
    for (const match of matches) {
      const imageFields = ['fighterAImage', 'fighterBImage', 'promotionBackground'];
      const checks = {};
      for (const field of imageFields) {
        const url = cleanString(match[field]);
        checks[field] = check ? await checkImageUrl(url, axios) : summarizeImageUrl(url);
      }
      const brokenFields = Object.entries(checks).filter(([, item]) => item.status === 'broken' || item.status === 'missing').map(([field]) => field);
      if (!onlyBroken || brokenFields.length) {
        rows.push({
          matchId: String(match._id),
          matchName: match.matchName,
          fighters: [match.matchFighterA, match.matchFighterB],
          matchType: match.matchType,
          matchStatus: match.matchStatus,
          checks,
          brokenFields,
        });
      }
    }

    res.json({
      ok: true,
      checkedRemoteUrls: check,
      inspected: matches.length,
      returned: rows.length,
      rows,
      note: check ? 'Remote URL checks were performed with HEAD requests. No data was changed.' : 'Remote URL checks were not performed. Pass ?check=true to verify 404/broken images.',
    });
  }));

  app.get('/api/combat-fighters', asyncHandler(async (req, res) => {
    const filter = buildFighterFilter(req.query, false);
    const page = clamp(toInt(req.query.page, 1), 1, 100000);
    const limit = clamp(toInt(req.query.limit, 50), 1, 100);
    const [items, total] = await Promise.all([
      CombatFighter.find(filter).sort({ displayName: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      CombatFighter.countDocuments(filter),
    ]);
    res.json({ ok: true, items: items.map(serializeCombatFighter), pagination: pagination(page, limit, total) });
  }));

  app.get('/api/admin/combat-fighters', verifyAdminToken, asyncHandler(async (req, res) => {
    const filter = buildFighterFilter(req.query, true);
    const page = clamp(toInt(req.query.page, 1), 1, 100000);
    const limit = clamp(toInt(req.query.limit, 50), 1, 100);
    const [items, total] = await Promise.all([
      CombatFighter.find(filter).sort({ updatedAt: -1, displayName: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      CombatFighter.countDocuments(filter),
    ]);
    res.json({ ok: true, items: items.map(serializeCombatFighter), pagination: pagination(page, limit, total) });
  }));

  app.post('/api/admin/combat-fighters', verifyAdminToken, asyncHandler(async (req, res) => {
    const payload = normalizeCombatFighterPayload(req.body || {}, req.admin);
    const existing = await CombatFighter.findOne({ normalizedName: payload.normalizedName, category: payload.category });
    if (existing) {
      Object.assign(existing, payload, { updatedBy: adminActor(req.admin) });
      await existing.save();
      return res.status(200).json({ ok: true, created: false, fighter: serializeCombatFighter(existing) });
    }
    const fighter = await CombatFighter.create(payload);
    res.status(201).json({ ok: true, created: true, fighter: serializeCombatFighter(fighter) });
  }));

  app.patch('/api/admin/combat-fighters/:id', verifyAdminToken, asyncHandler(async (req, res) => {
    const fighter = await CombatFighter.findById(req.params.id);
    if (!fighter) return res.status(404).json({ ok: false, code: 'COMBAT_FIGHTER_NOT_FOUND', message: 'Combat fighter not found.' });
    const patch = normalizeCombatFighterPatch(req.body || {}, req.admin);
    Object.assign(fighter, patch);
    await fighter.save();
    res.json({ ok: true, fighter: serializeCombatFighter(fighter) });
  }));

  app.post('/api/admin/combat-fighters/suggest-from-matches', verifyAdminToken, asyncHandler(async (req, res) => {
    const limit = clamp(toInt(req.body?.limit, 1000), 1, 3000);
    const matches = await Match.find({})
      .select('_id matchCategory matchCategoryTwo matchFighterA matchFighterB fighterAImage fighterBImage updatedAt')
      .sort({ updatedAt: -1, _id: -1 })
      .limit(limit)
      .lean();

    const suggestions = buildFighterSuggestions(matches);
    res.json({
      ok: true,
      dryRun: true,
      inspected: matches.length,
      suggestionCount: suggestions.length,
      suggestions,
      note: 'No fighter records were created. Use POST /api/admin/combat-fighters to approve/create selected suggestions.',
    });
  }));

  app.post('/api/admin/fights/:matchId/link-fighters', verifyAdminToken, asyncHandler(async (req, res) => {
    const match = await Match.findById(req.params.matchId);
    if (!match) return res.status(404).json({ ok: false, code: 'MATCH_NOT_FOUND', message: 'Match not found.' });

    const fighterAId = cleanString(req.body?.fighterAId);
    const fighterBId = cleanString(req.body?.fighterBId);
    if (fighterAId && !mongoose.isValidObjectId(fighterAId)) return res.status(400).json({ ok: false, code: 'INVALID_FIGHTER_A_ID', message: 'fighterAId is invalid.' });
    if (fighterBId && !mongoose.isValidObjectId(fighterBId)) return res.status(400).json({ ok: false, code: 'INVALID_FIGHTER_B_ID', message: 'fighterBId is invalid.' });

    if (fighterAId) match.fighterAId = fighterAId;
    if (fighterBId) match.fighterBId = fighterBId;
    await match.save();

    res.json({ ok: true, matchId: String(match._id), fighterAId: match.fighterAId || null, fighterBId: match.fighterBId || null });
  }));

  app.use((err, req, res, next) => {
    if (!req.path || (!req.path.includes('/data-quality') && !req.path.includes('/combat-fighters') && !req.path.includes('/scoring-config') && !req.path.includes('/link-fighters'))) {
      return next(err);
    }
    const status = err.status || err.httpStatus || 500;
    res.status(status).json({ ok: false, code: err.code || 'FIGHT_DATA_QUALITY_ERROR', message: err.message || 'Fight data-quality route failed.' });
  });

  return { CombatFighter, scoringConfig: DEFAULT_SCORING_CONFIG };
}

function buildCombatFighterModel(mongoose) {
  const Mixed = mongoose.Schema.Types.Mixed;
  const schema = new mongoose.Schema({
    displayName: { type: String, required: true, trim: true },
    normalizedName: { type: String, required: true, trim: true, lowercase: true, index: true },
    category: { type: String, default: 'combat', index: true },
    aliases: [String],
    primaryImage: String,
    imagePublicId: String,
    imageHealth: Mixed,
    status: { type: String, enum: ['active', 'inactive', 'needs_review'], default: 'active', index: true },
    source: { type: String, default: 'admin' },
    metadata: Mixed,
    createdBy: Mixed,
    updatedBy: Mixed,
  }, { timestamps: true, minimize: false });

  schema.index({ normalizedName: 1, category: 1 }, { unique: true });
  return mongoose.models.CombatFighter || mongoose.model('CombatFighter', schema, 'combat_fighters');
}

function groupDuplicateMatches(matches) {
  const map = new Map();
  for (const match of matches) {
    const fighterPair = [normalizeName(match.matchFighterA), normalizeName(match.matchFighterB)].sort().join('|');
    const key = [normalizeName(match.matchCategory), normalizeName(match.matchCategoryTwo), fighterPair, match.maxRounds || ''].join('::');
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(match);
  }

  return Array.from(map.entries())
    .map(([key, rows]) => ({
      key,
      count: rows.length,
      preserveSuggestion: suggestMatchToPreserve(rows),
      matches: rows.map((match) => ({
        id: String(match._id),
        matchName: match.matchName,
        matchCategory: match.matchCategory,
        matchCategoryTwo: match.matchCategoryTwo,
        matchFighterA: match.matchFighterA,
        matchFighterB: match.matchFighterB,
        matchType: match.matchType,
        matchStatus: match.matchStatus,
        maxRounds: match.maxRounds,
        matchDate: match.matchDate,
        hasStats: hasCompletedStats(match),
        hasImages: Boolean(match.fighterAImage || match.fighterBImage || match.promotionBackground),
        createdAt: match.createdAt,
        updatedAt: match.updatedAt,
      })),
    }))
    .filter((group) => group.count > 1)
    .sort((a, b) => b.count - a.count);
}

function suggestMatchToPreserve(rows) {
  const sorted = [...rows].sort((a, b) => {
    const aScore = preservationScore(a);
    const bScore = preservationScore(b);
    if (aScore !== bScore) return bScore - aScore;
    return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
  });
  return sorted[0]?._id ? String(sorted[0]._id) : null;
}

function preservationScore(match) {
  let score = 0;
  if (match.matchStatus === 'Ongoing' || match.matchStatus === 'Live' || match.matchStatus === 'Open') score += 20;
  if (match.matchType === 'LIVE') score += 10;
  if (hasCompletedStats(match)) score += 30;
  if (match.fighterAImage) score += 5;
  if (match.fighterBImage) score += 5;
  if (match.promotionBackground) score += 5;
  return score;
}

function hasCompletedStats(match) {
  const boxingA = match.BoxingMatch?.fighterOneStats?.length || 0;
  const boxingB = match.BoxingMatch?.fighterTwoStats?.length || 0;
  const mmaA = match.MMAMatch?.fighterOneStats?.length || 0;
  const mmaB = match.MMAMatch?.fighterTwoStats?.length || 0;
  return boxingA + boxingB + mmaA + mmaB > 0;
}

function buildFighterSuggestions(matches) {
  const map = new Map();
  for (const match of matches) {
    for (const side of ['A', 'B']) {
      const name = cleanString(side === 'A' ? match.matchFighterA : match.matchFighterB);
      if (!name) continue;
      const normalizedName = normalizeName(name);
      const category = normalizeName(match.matchCategory) || 'combat';
      const key = `${category}:${normalizedName}`;
      if (!map.has(key)) {
        map.set(key, {
          displayName: name,
          normalizedName,
          category,
          aliases: new Set([name]),
          candidateImages: new Map(),
          matchIds: new Set(),
        });
      }
      const item = map.get(key);
      item.aliases.add(name);
      item.matchIds.add(String(match._id));
      const image = cleanString(side === 'A' ? match.fighterAImage : match.fighterBImage);
      if (image) item.candidateImages.set(image, (item.candidateImages.get(image) || 0) + 1);
    }
  }

  return Array.from(map.values())
    .map((item) => ({
      displayName: item.displayName,
      normalizedName: item.normalizedName,
      category: item.category,
      aliases: Array.from(item.aliases),
      primaryImageCandidate: Array.from(item.candidateImages.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      candidateImages: Array.from(item.candidateImages.entries()).map(([url, count]) => ({ url, count })).sort((a, b) => b.count - a.count).slice(0, 5),
      matchCount: item.matchIds.size,
      matchIds: Array.from(item.matchIds).slice(0, 25),
    }))
    .sort((a, b) => b.matchCount - a.matchCount || a.displayName.localeCompare(b.displayName));
}

function normalizeCombatFighterPayload(body, admin) {
  const displayName = cleanString(body.displayName || body.name);
  if (!displayName) {
    const error = new Error('displayName is required.');
    error.status = 400;
    error.code = 'DISPLAY_NAME_REQUIRED';
    throw error;
  }
  return {
    displayName,
    normalizedName: normalizeName(displayName),
    category: normalizeName(body.category || body.matchCategory || 'combat'),
    aliases: normalizeStringList(body.aliases),
    primaryImage: cleanString(body.primaryImage || body.image || body.fighterImage),
    imagePublicId: cleanString(body.imagePublicId || body.primaryImagePublicId),
    status: ['active', 'inactive', 'needs_review'].includes(String(body.status)) ? String(body.status) : 'active',
    source: cleanString(body.source) || 'admin',
    metadata: isPlainObject(body.metadata) ? body.metadata : {},
    createdBy: adminActor(admin),
    updatedBy: adminActor(admin),
  };
}

function normalizeCombatFighterPatch(body, admin) {
  const patch = {};
  if (body.displayName !== undefined || body.name !== undefined) {
    patch.displayName = cleanString(body.displayName || body.name);
    patch.normalizedName = normalizeName(patch.displayName);
  }
  if (body.category !== undefined || body.matchCategory !== undefined) patch.category = normalizeName(body.category || body.matchCategory || 'combat');
  if (body.aliases !== undefined) patch.aliases = normalizeStringList(body.aliases);
  if (body.primaryImage !== undefined || body.image !== undefined || body.fighterImage !== undefined) patch.primaryImage = cleanString(body.primaryImage || body.image || body.fighterImage);
  if (body.imagePublicId !== undefined || body.primaryImagePublicId !== undefined) patch.imagePublicId = cleanString(body.imagePublicId || body.primaryImagePublicId);
  if (body.status !== undefined && ['active', 'inactive', 'needs_review'].includes(String(body.status))) patch.status = String(body.status);
  if (body.metadata !== undefined && isPlainObject(body.metadata)) patch.metadata = body.metadata;
  patch.updatedBy = adminActor(admin);
  return patch;
}

function buildFighterFilter(query, includeInactive) {
  const filter = {};
  if (!includeInactive) filter.status = 'active';
  if (query.category) filter.category = normalizeName(query.category);
  if (query.status && includeInactive) filter.status = String(query.status);
  if (query.search) {
    const normalized = normalizeName(query.search);
    filter.$or = [
      { normalizedName: { $regex: escapeRegExp(normalized), $options: 'i' } },
      { displayName: { $regex: escapeRegExp(String(query.search)), $options: 'i' } },
      { aliases: { $regex: escapeRegExp(String(query.search)), $options: 'i' } },
    ];
  }
  return filter;
}

function summarizeImageUrl(url) {
  if (!url || url === 'null') return { status: 'missing', url: url || null };
  return { status: 'unchecked', url, provider: inferImageProvider(url) };
}

async function checkImageUrl(url, axios) {
  const summary = summarizeImageUrl(url);
  if (summary.status === 'missing') return summary;
  if (!axios || !/^https?:\/\//i.test(url)) return { ...summary, status: 'invalid' };
  try {
    const response = await axios.head(url, { timeout: 6000, validateStatus: () => true });
    return {
      ...summary,
      status: response.status >= 200 && response.status < 400 ? 'valid' : 'broken',
      httpStatus: response.status,
      contentType: response.headers?.['content-type'],
    };
  } catch (error) {
    return { ...summary, status: 'broken', error: error.message };
  }
}

function serializeCombatFighter(fighter) {
  if (!fighter) return null;
  return {
    id: String(fighter._id),
    displayName: fighter.displayName,
    normalizedName: fighter.normalizedName,
    category: fighter.category,
    aliases: fighter.aliases || [],
    primaryImage: fighter.primaryImage,
    imagePublicId: fighter.imagePublicId,
    imageHealth: fighter.imageHealth,
    status: fighter.status,
    source: fighter.source,
    metadata: fighter.metadata,
    createdAt: fighter.createdAt,
    updatedAt: fighter.updatedAt,
  };
}

function normalizeObjectIdArray(value, mongoose) {
  const raw = Array.isArray(value) ? value : [];
  return [...new Set(raw.map((item) => cleanString(item)).filter((item) => mongoose.isValidObjectId(item)))];
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return [...new Set(value.map((item) => cleanString(item)).filter(Boolean))];
  if (typeof value === 'string') return [...new Set(value.split(',').map((item) => cleanString(item)).filter(Boolean))];
  return [];
}

function inferImageProvider(url) {
  if (!url) return null;
  if (url.includes('res.cloudinary.com')) return 'cloudinary';
  if (url.includes('i.ibb.co') || url.includes('ibb.co')) return 'imgbb';
  return 'external';
}

function pagination(page, limit, total) {
  return { page, limit, total, pages: Math.ceil(total / limit) };
}

function adminActor(admin) {
  return admin ? { id: admin.id ? String(admin.id) : undefined, email: admin.email, role: 'admin' } : { source: 'backend' };
}

function normalizeName(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function cleanString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  registerFightDataQualityRoutes,
  _private: {
    DEFAULT_SCORING_CONFIG,
    groupDuplicateMatches,
    buildFighterSuggestions,
    normalizeName,
  },
};
