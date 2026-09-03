'use strict';

/**
 * Safe fight data-quality helpers.
 *
 * These routes are additive. They do not change legacy fight creation/listing routes.
 * Destructive actions require explicit admin IDs and default to dry-run or soft-delete.
 */

const DEFAULT_SCORING_CONFIG = Object.freeze({
  version: 'official-round-finish-scorecard-v3',
  points: {
    KO: 500,
    SP: 25,
    RW: 100,
    RL: 25,
  },
  labels: {
    KO: 'Finish Bonus — correct actual KO/TKO/submission finish-round pick',
    SP: 'Survival Bonus — wrong pick when the round is not the finish round',
    RW: 'Round Winner pick',
    RL: 'Round Loser paired credit',
  },
  ui: {
    outcomeInput: 'radio',
    roundWinnerOptions: ['fighterA', 'fighterB', 'draw', 'none'],
    finishOptions: ['none', 'fighterA_FINISH', 'fighterB_FINISH'],
    deriveOpponentOutcome: true,
    survivalDerivedFromFinish: true,
  },
});

function registerFightDataQualityRoutes(options) {
  const { app, mongoose, verifyAdminToken, Match, Shadow, axios, upload, cloudinary } = options || {};
  if (!app || !mongoose || !verifyAdminToken || !Match) {
    throw new Error('registerFightDataQualityRoutes requires app, mongoose, verifyAdminToken, and Match.');
  }

  const CombatFighter = buildCombatFighterModel(mongoose);
  const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  const fighterImageUpload = buildFighterImageUploadMiddleware(upload);

  app.get('/api/scoring-config', asyncHandler(async (req, res) => {
    res.json({ ok: true, source: 'backend-default', config: DEFAULT_SCORING_CONFIG });
  }));

  app.get('/api/admin/fights/scoring-config', verifyAdminToken, asyncHandler(async (req, res) => {
    res.json({ ok: true, source: 'backend-default', config: DEFAULT_SCORING_CONFIG });
  }));

  app.get('/api/admin/fights', verifyAdminToken, asyncHandler(async (req, res) => {
    const page = clamp(toInt(req.query.page, 1), 1, 100000);
    const limit = clamp(toInt(req.query.limit, 50), 1, 500);
    const requestedSource = cleanString(req.query.source || req.query.registrySource || '').toLowerCase();
    const includeShadow = parseBool(req.query.includeShadow ?? req.query.withShadow, false)
      || ['all', 'combined', 'registry', 'match_and_shadow', 'both'].includes(requestedSource);

    if (includeShadow) {
      const filter = buildAdminFightFilter(req.query, { defaultMatchType: null });
      const ShadowModel = Shadow;
      const queryLimit = Math.min(Math.max(limit, 1), 500);
      const [matches, shadows, matchTotal, shadowTotal] = await Promise.all([
        Match.find(filter).populate('fighterAId fighterBId').sort({ updatedAt: -1, _id: -1 }).limit(queryLimit).lean(),
        ShadowModel ? ShadowModel.find(filter).populate('fighterAId fighterBId').sort({ updatedAt: -1, _id: -1 }).limit(queryLimit).lean() : Promise.resolve([]),
        Match.countDocuments(filter),
        ShadowModel ? ShadowModel.countDocuments(filter) : Promise.resolve(0),
      ]);

      const serialized = [
        ...matches.map((item) => serializeAdminFight(item, 'match')),
        ...shadows.map((item) => serializeAdminFight(item, 'shadow')),
      ].sort(compareAdminFightRecords);
      const offset = (page - 1) * limit;
      const pageItems = serialized.slice(offset, offset + limit);

      return res.json({
        ok: true,
        source: 'combined',
        includeShadow: true,
        defaultMatchType: 'all',
        items: pageItems,
        counts: { match: matchTotal, shadow: shadowTotal, total: matchTotal + shadowTotal },
        pagination: pagination(page, limit, matchTotal + shadowTotal),
        note: 'Combined admin registry response includes Match and Shadow records so /administration/fights can show the full fight library with LIVE/SHADOW filters.',
      });
    }

    const filter = buildAdminFightFilter(req.query, { defaultMatchType: 'LIVE' });
    const [items, total] = await Promise.all([
      Match.find(filter)
        .populate('fighterAId fighterBId')
        .sort({ updatedAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Match.countDocuments(filter),
    ]);
    res.json({
      ok: true,
      source: 'match',
      defaultMatchType: 'LIVE',
      items: items.map((item) => serializeAdminFight(item, 'match')),
      pagination: pagination(page, limit, total),
      note: 'This admin endpoint defaults to LIVE fights from the Match collection. Pass source=all or includeShadow=true for the combined registry.',
    });
  }));

  app.get('/api/admin/fights/live', verifyAdminToken, asyncHandler(async (req, res) => {
    req.query.matchType = 'LIVE';
    const page = clamp(toInt(req.query.page, 1), 1, 100000);
    const limit = clamp(toInt(req.query.limit, 50), 1, 200);
    const filter = buildAdminFightFilter(req.query, { defaultMatchType: 'LIVE' });
    const [items, total] = await Promise.all([
      Match.find(filter)
        .populate('fighterAId fighterBId')
        .sort({ updatedAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Match.countDocuments(filter),
    ]);
    res.json({ ok: true, source: 'match', matchType: 'LIVE', items: items.map((item) => serializeAdminFight(item, 'match')), pagination: pagination(page, limit, total) });
  }));

  app.get('/api/admin/shadow-fights/library', verifyAdminToken, asyncHandler(async (req, res) => {
    const page = clamp(toInt(req.query.page, 1), 1, 100000);
    const limit = clamp(toInt(req.query.limit, 50), 1, 200);
    const filter = buildAdminFightFilter(req.query, { defaultMatchType: null, ignoreMatchTypeWhenAll: true });
    const ShadowModel = Shadow;
    if (!ShadowModel) return res.json({ ok: true, source: 'shadow', items: [], pagination: pagination(page, limit, 0), warning: 'Shadow model is not available in this backend instance.' });
    const [items, total] = await Promise.all([
      ShadowModel.find(filter)
        .populate('fighterAId fighterBId')
        .sort({ updatedAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ShadowModel.countDocuments(filter),
    ]);
    res.json({
      ok: true,
      source: 'shadow',
      items: items.map((item) => serializeAdminFight(item, 'shadow')),
      pagination: pagination(page, limit, total),
      note: 'This endpoint returns Shadow collection records for the Shadow Fights Library only.',
    });
  }));

  app.get('/api/admin/fights/data-quality/duplicates', verifyAdminToken, asyncHandler(async (req, res) => {
    const limit = clamp(toInt(req.query.limit, 500), 1, 2000);
    const includeFinished = parseBool(req.query.includeFinished, true);
    const filter = includeFinished ? {} : { matchStatus: { $ne: 'Finished' } };
    const matches = await Match.find(filter)
      .select('_id matchName matchCategory matchCategoryTwo matchFighterA matchFighterB matchType matchStatus maxRounds matchDate createdAt updatedAt fighterAImage fighterBImage promotionBackground BoxingMatch MMAMatch fighterAId fighterBId')
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
      .select('_id matchName matchFighterA matchFighterB matchType matchStatus fighterAImage fighterBImage promotionBackground updatedAt fighterAId fighterBId')
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
          fighterAId: match.fighterAId ? String(match.fighterAId) : null,
          fighterBId: match.fighterBId ? String(match.fighterBId) : null,
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

  const publicCombatFighterListHandler = asyncHandler(async (req, res) => {
    const filter = buildFighterFilter(req.query, false);
    const page = clamp(toInt(req.query.page, 1), 1, 100000);
    const limit = clamp(toInt(req.query.limit, 50), 1, 100);
    const sort = buildFighterSort(req.query, false);
    const [items, total] = await Promise.all([
      CombatFighter.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
      CombatFighter.countDocuments(filter),
    ]);
    res.json({
      ok: true,
      source: 'combat_fighters',
      items: items.map(serializeCombatFighter),
      pagination: pagination(page, limit, total),
      note: 'Public fighter pages should use this fighter-library feed instead of deriving fighters from fight records.',
    });
  });

  app.get('/api/combat-fighters', publicCombatFighterListHandler);
  app.get('/api/public/combat-fighters', publicCombatFighterListHandler);
  app.get('/api/public/fighters', publicCombatFighterListHandler);

  app.get('/api/admin/combat-fighters', verifyAdminToken, asyncHandler(async (req, res) => {
    const filter = buildFighterFilter(req.query, true);
    const page = clamp(toInt(req.query.page, 1), 1, 100000);
    const limit = clamp(toInt(req.query.limit, 50), 1, 100);
    const [items, total] = await Promise.all([
      CombatFighter.find(filter).sort(buildFighterSort(req.query, true)).skip((page - 1) * limit).limit(limit).lean(),
      CombatFighter.countDocuments(filter),
    ]);
    res.json({ ok: true, items: items.map(serializeCombatFighter), pagination: pagination(page, limit, total) });
  }));

  app.post('/api/admin/combat-fighters', verifyAdminToken, fighterImageUpload, asyncHandler(async (req, res) => {
    const payload = normalizeCombatFighterPayload(req.body || {}, req.admin);
    await applyUploadedCombatFighterImage(payload, req, cloudinary);
    const existing = await CombatFighter.findOne({ normalizedName: payload.normalizedName, category: payload.category });
    if (existing) {
      Object.assign(existing, payload, { deletedAt: undefined, deletedBy: undefined, updatedBy: adminActor(req.admin) });
      await existing.save();
      return res.status(200).json({ ok: true, created: false, fighter: serializeCombatFighter(existing) });
    }
    const fighter = await CombatFighter.create(payload);
    res.status(201).json({ ok: true, created: true, fighter: serializeCombatFighter(fighter) });
  }));

  app.post('/api/admin/combat-fighters/suggest-from-matches', verifyAdminToken, asyncHandler(async (req, res) => {
    const limit = clamp(toInt(req.body?.limit, 1000), 1, 3000);
    const [matches, shadows] = await Promise.all([
      Match.find({}).select(selectFieldsForFighterImport()).sort({ updatedAt: -1, _id: -1 }).limit(limit).lean(),
      Shadow ? Shadow.find({}).select(selectFieldsForFighterImport()).sort({ updatedAt: -1, _id: -1 }).limit(limit).lean() : Promise.resolve([]),
    ]);

    const suggestions = buildFighterSuggestions([...tagRecords(matches, 'match'), ...tagRecords(shadows, 'shadow')]);
    res.json({
      ok: true,
      dryRun: true,
      inspected: matches.length + shadows.length,
      inspectedMatches: matches.length,
      inspectedShadows: shadows.length,
      suggestionCount: suggestions.length,
      suggestions,
      note: 'No fighter records were created. Use POST /api/admin/combat-fighters/import-from-fights to create/link selected suggestions in bulk.',
    });
  }));

  app.post('/api/admin/combat-fighters/import-from-fights', verifyAdminToken, asyncHandler(async (req, res) => {
    const startedAt = Date.now();
    const dryRun = parseBool(req.body?.dryRun, true);
    const limit = clamp(toInt(req.body?.limit, 1500), 1, 5000);
    const includeShadows = parseBool(req.body?.includeShadows, true);
    const checkImages = parseBool(req.body?.checkImages, !dryRun);
    const linkMatches = parseBool(req.body?.linkMatches, !dryRun);
    const overwriteImages = parseBool(req.body?.overwriteImages, false);
    const syncMatchImages = parseBool(req.body?.syncMatchImages, false);
    const offset = clamp(toInt(req.body?.offset ?? req.body?.cursor, 0), 0, 1000000);
    const defaultBatchSize = dryRun ? 50 : 8;
    const maxBatchSize = dryRun ? 200 : 25;
    const batchSize = clamp(toInt(req.body?.batchSize ?? req.body?.fighterBatchSize, defaultBatchSize), 1, maxBatchSize);
    const maxCandidateChecksPerFighter = clamp(toInt(req.body?.maxCandidateChecksPerFighter, 2), 1, dryRun ? 10 : 4);
    const imageTimeoutMs = clamp(toInt(req.body?.imageTimeoutMs, 1200), 400, 4000);
    const remoteConcurrency = clamp(toInt(req.body?.remoteConcurrency, 4), 1, 6);
    const allowImageGetFallback = parseBool(req.body?.allowImageGetFallback, false);

    const [matches, shadows] = await Promise.all([
      Match.find({}).select(selectFieldsForFighterImport()).sort({ updatedAt: -1, _id: -1 }).limit(limit).lean(),
      includeShadows && Shadow ? Shadow.find({}).select(selectFieldsForFighterImport()).sort({ updatedAt: -1, _id: -1 }).limit(limit).lean() : Promise.resolve([]),
    ]);

    const records = [...tagRecords(matches, 'match'), ...tagRecords(shadows, 'shadow')];
    const fighterGroups = sortFighterImportGroups(collectFighterImportGroups(records));
    const totalFighters = fighterGroups.length;
    const batchGroups = fighterGroups.slice(offset, offset + batchSize);

    const plan = await buildCombatFighterImportPlanFromGroups({
      groups: batchGroups,
      axios,
      checkImages,
      maxCandidateChecksPerFighter,
      imageTimeoutMs,
      remoteConcurrency,
      allowGetFallback: allowImageGetFallback,
    });

    const nextOffset = offset + plan.length;
    const hasMore = nextOffset < totalFighters;
    const batch = {
      offset,
      batchSize,
      processedFighters: plan.length,
      totalFighters,
      nextOffset: hasMore ? nextOffset : null,
      hasMore,
      checkImages,
      imageTimeoutMs,
      maxCandidateChecksPerFighter,
      remoteConcurrency,
      elapsedMs: Date.now() - startedAt,
    };

    if (dryRun) {
      return res.json({
        ok: true,
        dryRun: true,
        inspectedMatches: matches.length,
        inspectedShadows: shadows.length,
        fighterCount: totalFighters,
        batch,
        fighters: plan.map(summarizeImportPlanItem),
        note: 'Dry-run only. This endpoint is batched to stay under Vercel serverless limits. Send dryRun=false with the same offset/batchSize to create/update this batch, then continue with nextOffset while hasMore=true.',
      });
    }

    const result = await executeCombatFighterImportPlan({
      plan,
      CombatFighter,
      Match,
      Shadow,
      admin: req.admin,
      linkMatches,
      overwriteImages,
      syncMatchImages,
    });

    res.json({
      ok: true,
      dryRun: false,
      inspectedMatches: matches.length,
      inspectedShadows: shadows.length,
      batch,
      ...result,
      note: hasMore
        ? 'Safe batch imported. Continue by calling this endpoint again with dryRun=false and offset=batch.nextOffset until hasMore=false. Existing match fields are preserved as fallback.'
        : 'Combat fighter library import completed for the inspected records. Existing match fields are preserved as fallback; optional fighterAId/fighterBId references were linked when enabled.',
    });
  }));

  const cleanupFightFighterFieldsHandler = asyncHandler(async (req, res) => {
    const dryRun = parseBool(req.body?.dryRun, true);
    const includeMatches = parseBool(req.body?.includeMatches, true);
    const includeShadows = parseBool(req.body?.includeShadows, true);
    const resolveMissingRefs = parseBool(req.body?.resolveMissingRefs, true);
    const removeLegacyNames = parseBool(req.body?.removeLegacyNames ?? req.body?.removeNames, true);
    const removeLegacyImages = parseBool(req.body?.removeLegacyImages ?? req.body?.removeImages, true);
    const removeLegacyDeleteUrls = parseBool(req.body?.removeLegacyDeleteUrls ?? req.body?.removeDeleteUrls, true);
    const batchSize = clamp(toInt(req.body?.batchSize, 50), 1, 150);
    const filter = buildFightFighterCleanupFilter();

    const [matches, shadows, totalMatches, totalShadows] = await Promise.all([
      includeMatches ? Match.find(filter).select(selectFieldsForFighterImport()).sort({ updatedAt: -1, _id: -1 }).limit(batchSize).lean() : Promise.resolve([]),
      includeShadows && Shadow ? Shadow.find(filter).select(selectFieldsForFighterImport()).sort({ updatedAt: -1, _id: -1 }).limit(batchSize).lean() : Promise.resolve([]),
      includeMatches ? Match.countDocuments(filter) : Promise.resolve(0),
      includeShadows && Shadow ? Shadow.countDocuments(filter) : Promise.resolve(0),
    ]);

    const records = [...tagRecords(matches, 'match'), ...tagRecords(shadows, 'shadow')];
    const fighterByKeyMap = resolveMissingRefs
      ? await buildCombatFighterLookupForCleanup(records, CombatFighter)
      : new Map();

    const options = {
      resolveMissingRefs,
      removeLegacyNames,
      removeLegacyImages,
      removeLegacyDeleteUrls,
    };

    const matchOps = [];
    const shadowOps = [];
    const rows = [];
    let linkedByNameCount = 0;
    let legacyFieldsUnsetCount = 0;
    let unresolvedSideCount = 0;

    for (const record of records) {
      const plan = buildFightFighterCleanupPlan(record, fighterByKeyMap, options);
      rows.push(summarizeFightFighterCleanupPlan(record, plan));
      linkedByNameCount += plan.linkedByNameCount;
      legacyFieldsUnsetCount += plan.legacyFieldsUnsetCount;
      unresolvedSideCount += plan.unresolvedSides.length;

      if (!plan.hasUpdate) continue;
      const op = { updateOne: { filter: { _id: record._id }, update: plan.update } };
      if (record.__collection === 'shadow') shadowOps.push(op);
      else matchOps.push(op);
    }

    if (dryRun) {
      return res.json({
        ok: true,
        dryRun: true,
        inspectedMatches: matches.length,
        inspectedShadows: shadows.length,
        totalTargets: totalMatches + totalShadows,
        eligibleUpdates: rows.filter((row) => row.hasUpdate).length,
        linkedByNameCount,
        legacyFieldsUnsetCount,
        unresolvedSideCount,
        batch: {
          batchSize,
          processedRecords: records.length,
          hasMore: totalMatches + totalShadows > records.length,
        },
        rows: rows.slice(0, 100),
        note: 'Dry-run only. This checks which fights can be normalized to fighter-library refs and which legacy fighter name/image fields can be safely removed.',
      });
    }

    const [matchResult, shadowResult] = await Promise.all([
      matchOps.length ? Match.bulkWrite(matchOps, { ordered: false }) : Promise.resolve({ modifiedCount: 0 }),
      Shadow && shadowOps.length ? Shadow.bulkWrite(shadowOps, { ordered: false }) : Promise.resolve({ modifiedCount: 0 }),
    ]);

    res.json({
      ok: true,
      dryRun: false,
      inspectedMatches: matches.length,
      inspectedShadows: shadows.length,
      totalTargets: totalMatches + totalShadows,
      modifiedMatches: matchResult.modifiedCount || matchResult.nModified || 0,
      modifiedShadows: shadowResult.modifiedCount || shadowResult.nModified || 0,
      eligibleUpdates: rows.filter((row) => row.hasUpdate).length,
      linkedByNameCount,
      legacyFieldsUnsetCount,
      unresolvedSideCount,
      batch: {
        batchSize,
        processedRecords: records.length,
        hasMore: totalMatches + totalShadows > records.length,
      },
      rows: rows.slice(0, 100),
      note: 'Fight records were normalized to fighter-library references. Legacy fighter names/images were removed only for sides that have a valid fighter ref, so public reads must use populated fighter data.',
    });
  });

  app.post('/api/admin/combat-fighters/cleanup-fight-fighter-fields', verifyAdminToken, cleanupFightFighterFieldsHandler);
  app.post('/api/admin/combat-fighters/normalize-fight-links', verifyAdminToken, cleanupFightFighterFieldsHandler);

  app.get('/api/admin/combat-fighters/:id', verifyAdminToken, asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ ok: false, code: 'INVALID_COMBAT_FIGHTER_ID', message: 'Combat fighter id is invalid.' });
    const fighter = await CombatFighter.findById(req.params.id).lean();
    if (!fighter) return res.status(404).json({ ok: false, code: 'COMBAT_FIGHTER_NOT_FOUND', message: 'Combat fighter not found.' });
    res.json({ ok: true, fighter: serializeCombatFighter(fighter) });
  }));

  app.patch('/api/admin/combat-fighters/:id', verifyAdminToken, fighterImageUpload, asyncHandler(async (req, res) => {
    const fighter = await CombatFighter.findById(req.params.id);
    if (!fighter) return res.status(404).json({ ok: false, code: 'COMBAT_FIGHTER_NOT_FOUND', message: 'Combat fighter not found.' });
    const patch = normalizeCombatFighterPatch(req.body || {}, req.admin);
    await applyUploadedCombatFighterImage(patch, req, cloudinary, fighter);
    Object.assign(fighter, patch);
    await fighter.save();
    res.json({ ok: true, fighter: serializeCombatFighter(fighter) });
  }));

  app.delete('/api/admin/combat-fighters/:id', verifyAdminToken, asyncHandler(async (req, res) => {
    const fighter = await CombatFighter.findById(req.params.id);
    if (!fighter) return res.status(404).json({ ok: false, code: 'COMBAT_FIGHTER_NOT_FOUND', message: 'Combat fighter not found.' });

    fighter.status = 'inactive';
    fighter.deletedAt = new Date();
    fighter.deletedBy = adminActor(req.admin);
    fighter.updatedBy = adminActor(req.admin);
    await fighter.save();

    res.json({ ok: true, softDeleted: true, fighter: serializeCombatFighter(fighter), note: 'Fighter was soft-deleted/inactivated. Existing fights keep their old name/image fallback fields.' });
  }));

  // Permanent removal, separate from the soft-delete above. Deactivate is the
  // default (existing fights keep a name/image fallback); this actually erases
  // the fighter record so it never shows up in the library again.
  app.delete('/api/admin/combat-fighters/:id/permanent', verifyAdminToken, asyncHandler(async (req, res) => {
    const fighter = await CombatFighter.findById(req.params.id);
    if (!fighter) return res.status(404).json({ ok: false, code: 'COMBAT_FIGHTER_NOT_FOUND', message: 'Combat fighter not found.' });
    if (fighter.imagePublicId && cloudinary) {
      await cloudinary.uploader.destroy(fighter.imagePublicId).catch(() => null);
    }
    await CombatFighter.findByIdAndDelete(req.params.id);
    res.json({ ok: true, permanentlyDeleted: true, id: req.params.id, note: 'Fighter record was permanently removed. Fights already using this fighter keep their existing fallback name/image fields.' });
  }));

  app.post('/api/admin/combat-fighters/:id/restore', verifyAdminToken, asyncHandler(async (req, res) => {
    const fighter = await CombatFighter.findById(req.params.id);
    if (!fighter) return res.status(404).json({ ok: false, code: 'COMBAT_FIGHTER_NOT_FOUND', message: 'Combat fighter not found.' });

    fighter.status = 'active';
    fighter.deletedAt = undefined;
    fighter.deletedBy = undefined;
    fighter.updatedBy = adminActor(req.admin);
    await fighter.save();

    res.json({ ok: true, restored: true, fighter: serializeCombatFighter(fighter) });
  }));

  app.post('/api/admin/fights/:matchId/link-fighters', verifyAdminToken, asyncHandler(async (req, res) => {
    const match = await Match.findById(req.params.matchId);
    if (!match) return res.status(404).json({ ok: false, code: 'MATCH_NOT_FOUND', message: 'Match not found.' });

    const fighterAId = cleanString(req.body?.fighterAId);
    const fighterBId = cleanString(req.body?.fighterBId);
    if (fighterAId && !mongoose.isValidObjectId(fighterAId)) return res.status(400).json({ ok: false, code: 'INVALID_FIGHTER_A_ID', message: 'fighterAId is invalid.' });
    if (fighterBId && !mongoose.isValidObjectId(fighterBId)) return res.status(400).json({ ok: false, code: 'INVALID_FIGHTER_B_ID', message: 'fighterBId is invalid.' });

    const fighters = await CombatFighter.find({ _id: { $in: [fighterAId, fighterBId].filter(Boolean) } }).lean();
    const byId = new Map(fighters.map((fighter) => [String(fighter._id), fighter]));
    const syncNames = parseBool(req.body?.syncNames, true);
    const syncImages = parseBool(req.body?.syncImages, false);

    if (fighterAId) {
      const fighter = byId.get(fighterAId);
      if (!fighter) return res.status(404).json({ ok: false, code: 'FIGHTER_A_NOT_FOUND', message: 'fighterAId was not found.' });
      match.fighterAId = fighterAId;
      if (syncNames) match.matchFighterA = fighter.displayName || match.matchFighterA;
      if (syncImages && fighter.primaryImage) match.fighterAImage = fighter.primaryImage;
    }

    if (fighterBId) {
      const fighter = byId.get(fighterBId);
      if (!fighter) return res.status(404).json({ ok: false, code: 'FIGHTER_B_NOT_FOUND', message: 'fighterBId was not found.' });
      match.fighterBId = fighterBId;
      if (syncNames) match.matchFighterB = fighter.displayName || match.matchFighterB;
      if (syncImages && fighter.primaryImage) match.fighterBImage = fighter.primaryImage;
    }

    await match.save();

    res.json({ ok: true, matchId: String(match._id), fighterAId: match.fighterAId || null, fighterBId: match.fighterBId || null });
  }));

  app.use((err, req, res, next) => {
    if (!req.path || (!req.path.includes('/data-quality') && !req.path.includes('/combat-fighters') && !req.path.includes('/scoring-config') && !req.path.includes('/link-fighters') && !req.path.includes('/api/admin/fights') && !req.path.includes('/shadow-fights/library'))) {
      return next(err);
    }
    const status = err.status || err.httpStatus || 500;
    res.status(status).json({ ok: false, code: err.code || 'FIGHT_DATA_QUALITY_ERROR', message: err.message || 'Fight data-quality route failed.' });
  });

  return { CombatFighter, scoringConfig: DEFAULT_SCORING_CONFIG };
}


function buildFighterImageUploadMiddleware(upload) {
  if (!upload || typeof upload.fields !== 'function') {
    return (req, res, next) => next();
  }
  return upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'fighterImage', maxCount: 1 },
    { name: 'primaryImage', maxCount: 1 },
    { name: 'primaryImageFile', maxCount: 1 },
  ]);
}

function getUploadedCombatFighterImage(req) {
  if (!req) return null;
  if (req.file && req.file.buffer) return req.file;
  const files = req.files || {};
  const fields = ['image', 'fighterImage', 'primaryImage', 'primaryImageFile'];
  for (const field of fields) {
    const list = Array.isArray(files[field]) ? files[field] : [];
    const file = list.find((item) => item && item.buffer);
    if (file) return file;
  }
  return null;
}

async function applyUploadedCombatFighterImage(target, req, cloudinary, existingFighter = null) {
  const file = getUploadedCombatFighterImage(req);
  if (!file) return target;
  if (!cloudinary || !cloudinary.uploader || typeof cloudinary.uploader.upload_stream !== 'function') {
    const error = new Error('Cloudinary uploader is not configured for fighter image uploads.');
    error.status = 500;
    error.code = 'FIGHTER_IMAGE_UPLOAD_NOT_CONFIGURED';
    throw error;
  }

  const result = await uploadBufferToCloudinary(file.buffer, {
    cloudinary,
    folder: 'combat_fighters',
    resourceType: 'image',
  });

  const previousPublicId = cleanString(existingFighter?.imagePublicId);
  if (previousPublicId && previousPublicId !== result.public_id && typeof cloudinary.uploader.destroy === 'function') {
    try {
      await cloudinary.uploader.destroy(previousPublicId);
    } catch (destroyError) {
      // Do not fail the admin update if an old Cloudinary asset cannot be removed.
    }
  }

  target.primaryImage = result.secure_url || result.url;
  target.imagePublicId = result.public_id;
  target.imageHealth = {
    status: 'valid',
    provider: 'cloudinary',
    source: 'admin_upload',
    url: target.primaryImage,
    publicId: result.public_id,
    checkedAt: new Date(),
    bytes: result.bytes || null,
    width: result.width || null,
    height: result.height || null,
    format: result.format || null,
  };

  if (!req.body || req.body.status === undefined || String(req.body.status) === 'needs_review') {
    target.status = 'active';
  }

  return target;
}

function uploadBufferToCloudinary(buffer, { cloudinary, folder, resourceType = 'image' }) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType,
        transformation: [
          { quality: 'auto', fetch_format: 'auto' },
        ],
      },
      (error, result) => {
        if (error) return reject(error);
        return resolve(result || {});
      }
    );
    stream.end(buffer);
  });
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
    deletedAt: Date,
    deletedBy: Mixed,
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
        fighterAId: match.fighterAId ? String(match.fighterAId) : null,
        fighterBId: match.fighterBId ? String(match.fighterBId) : null,
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
  const groups = collectFighterImportGroups(matches);
  return Array.from(groups.values())
    .map((item) => ({
      displayName: item.displayName,
      normalizedName: item.normalizedName,
      category: item.category,
      aliases: Array.from(item.aliases),
      primaryImageCandidate: sortedImageCandidates(item.candidateImages)[0]?.url || null,
      candidateImages: sortedImageCandidates(item.candidateImages).slice(0, 5).map((candidate) => ({ url: candidate.url, count: candidate.count })),
      matchCount: item.matchIds.size,
      matchIds: Array.from(item.matchIds).slice(0, 25),
    }))
    .sort((a, b) => b.matchCount - a.matchCount || a.displayName.localeCompare(b.displayName));
}

async function buildCombatFighterImportPlan({
  records,
  axios,
  checkImages,
  maxCandidateChecksPerFighter,
  offset = 0,
  batchSize = null,
  imageTimeoutMs = 1200,
  remoteConcurrency = 4,
  allowGetFallback = false,
}) {
  const groups = sortFighterImportGroups(collectFighterImportGroups(records));
  const selectedGroups = batchSize ? groups.slice(offset, offset + batchSize) : groups;
  return buildCombatFighterImportPlanFromGroups({
    groups: selectedGroups,
    axios,
    checkImages,
    maxCandidateChecksPerFighter,
    imageTimeoutMs,
    remoteConcurrency,
    allowGetFallback,
  });
}

async function buildCombatFighterImportPlanFromGroups({
  groups,
  axios,
  checkImages,
  maxCandidateChecksPerFighter,
  imageTimeoutMs = 1200,
  remoteConcurrency = 4,
  allowGetFallback = false,
}) {
  const plan = await mapWithConcurrency(
    groups || [],
    clamp(toInt(remoteConcurrency, 4), 1, 6),
    async (group) => {
      const candidates = sortedImageCandidates(group.candidateImages);
      const verification = await pickValidImageCandidate(candidates, {
        axios,
        checkImages,
        maxCandidateChecksPerFighter,
        imageTimeoutMs,
        allowGetFallback,
      });
      return {
        displayName: group.displayName,
        normalizedName: group.normalizedName,
        category: group.category,
        aliases: Array.from(group.aliases),
        verifiedImage: verification.validCandidate,
        imageCandidates: candidates.slice(0, 10).map((candidate) => ({ url: candidate.url, count: candidate.count, publicId: candidate.publicId || null })),
        imageChecks: verification.checked,
        matchCount: group.matchIds.size,
        matchIds: Array.from(group.matchIds),
        links: group.links,
        status: verification.validCandidate ? 'active' : 'needs_review',
      };
    }
  );

  return plan.sort((a, b) => b.matchCount - a.matchCount || a.displayName.localeCompare(b.displayName));
}

function sortFighterImportGroups(groups) {
  return Array.from(groups.values()).sort((a, b) => b.matchIds.size - a.matchIds.size || a.displayName.localeCompare(b.displayName));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const list = Array.isArray(items) ? items : [];
  const safeConcurrency = clamp(toInt(concurrency, 4), 1, Math.max(1, list.length || 1));
  const results = new Array(list.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < list.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(list[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(safeConcurrency, list.length || 1) }, worker));
  return results;
}

async function executeCombatFighterImportPlan({ plan, CombatFighter, Match, Shadow, admin, linkMatches, overwriteImages, syncMatchImages }) {
  let createdCount = 0;
  let updatedCount = 0;
  let linkedMatchCount = 0;
  let linkedShadowCount = 0;
  const fighterByKey = new Map();
  const imported = [];

  for (const row of plan) {
    const payload = {
      displayName: row.displayName,
      normalizedName: row.normalizedName,
      category: row.category,
      aliases: row.aliases,
      primaryImage: row.verifiedImage?.url || '',
      imagePublicId: row.verifiedImage?.publicId || '',
      imageHealth: row.verifiedImage?.health || { status: 'missing', checked: true },
      status: row.status,
      source: 'fight-import',
      metadata: {
        importedFromMatches: true,
        matchCount: row.matchCount,
        matchIds: row.matchIds.slice(0, 100),
        imageCandidates: row.imageCandidates,
        imageChecks: row.imageChecks,
      },
      updatedBy: adminActor(admin),
    };

    let fighter = await CombatFighter.findOne({ normalizedName: row.normalizedName, category: row.category });
    if (fighter) {
      fighter.displayName = fighter.displayName || payload.displayName;
      fighter.aliases = mergeUniqueStrings(fighter.aliases || [], payload.aliases);
      fighter.source = fighter.source || payload.source;
      fighter.metadata = { ...(fighter.metadata || {}), ...(payload.metadata || {}) };
      fighter.updatedBy = payload.updatedBy;
      if (payload.primaryImage && (overwriteImages || !fighter.primaryImage)) {
        fighter.primaryImage = payload.primaryImage;
        fighter.imagePublicId = payload.imagePublicId;
        fighter.imageHealth = payload.imageHealth;
      }
      if (fighter.status === 'inactive') fighter.status = 'active';
      if (!fighter.primaryImage && fighter.status !== 'inactive') fighter.status = 'needs_review';
      await fighter.save();
      updatedCount += 1;
    } else {
      fighter = await CombatFighter.create({ ...payload, createdBy: adminActor(admin) });
      createdCount += 1;
    }

    const key = fighterKey(row.category, row.normalizedName);
    fighterByKey.set(key, fighter);
    imported.push({ key, fighter: serializeCombatFighter(fighter), created: Boolean(fighter.createdAt && fighter.updatedAt && String(fighter.createdAt) === String(fighter.updatedAt)) });
  }

  if (linkMatches) {
    const matchOps = [];
    const shadowOps = [];
    for (const row of plan) {
      const fighter = fighterByKey.get(fighterKey(row.category, row.normalizedName));
      if (!fighter) continue;
      for (const link of row.links) {
        const update = { $set: { [link.side === 'A' ? 'fighterAId' : 'fighterBId']: fighter._id } };
        if (syncMatchImages && fighter.primaryImage) {
          update.$set[link.side === 'A' ? 'fighterAImage' : 'fighterBImage'] = fighter.primaryImage;
        }
        const op = { updateOne: { filter: { _id: link.matchId }, update } };
        if (link.collection === 'shadow') shadowOps.push(op);
        else matchOps.push(op);
      }
    }

    if (matchOps.length) {
      const matchResult = await Match.bulkWrite(matchOps, { ordered: false });
      linkedMatchCount = matchResult.modifiedCount || matchResult.nModified || 0;
    }
    if (Shadow && shadowOps.length) {
      const shadowResult = await Shadow.bulkWrite(shadowOps, { ordered: false });
      linkedShadowCount = shadowResult.modifiedCount || shadowResult.nModified || 0;
    }
  }

  return {
    createdCount,
    updatedCount,
    importedCount: imported.length,
    linkedMatchCount,
    linkedShadowCount,
    imported: imported.slice(0, 100),
  };
}

function buildFightFighterCleanupFilter() {
  const valueExists = (field) => ({ [field]: { $exists: true, $nin: [null, '', 'null'] } });
  const missingRef = (field) => ({ $or: [{ [field]: { $exists: false } }, { [field]: null }, { [field]: '' }] });
  return {
    $or: [
      valueExists('matchFighterA'),
      valueExists('matchFighterB'),
      valueExists('fighterAImage'),
      valueExists('fighterBImage'),
      valueExists('fighterAImageDeleteUrl'),
      valueExists('fighterBImageDeleteUrl'),
      { $and: [missingRef('fighterAId'), valueExists('matchFighterA')] },
      { $and: [missingRef('fighterBId'), valueExists('matchFighterB')] },
    ],
  };
}

async function buildCombatFighterLookupForCleanup(records, CombatFighter) {
  const keys = new Map();
  for (const record of records || []) {
    for (const side of ['A', 'B']) {
      if (normalizeExistingObjectId(record[`fighter${side}Id`])) continue;
      const name = cleanString(side === 'A' ? record.matchFighterA : record.matchFighterB);
      if (!name) continue;
      const category = normalizeName(record.matchCategory) || 'combat';
      const normalizedName = normalizeName(name);
      if (!normalizedName) continue;
      keys.set(fighterKey(category, normalizedName), { category, normalizedName });
    }
  }

  const clauses = Array.from(keys.values()).map(({ category, normalizedName }) => ({ category, normalizedName }));
  if (!clauses.length) return new Map();

  const fighters = await CombatFighter.find({
    status: { $ne: 'inactive' },
    $or: clauses,
  }).lean();

  return new Map(fighters.map((fighter) => [fighterKey(fighter.category, fighter.normalizedName), fighter]));
}

function buildFightFighterCleanupPlan(record, fighterByKeyMap, options = {}) {
  const update = { $set: {}, $unset: {} };
  const sides = {};
  const unresolvedSides = [];
  let linkedByNameCount = 0;
  let legacyFieldsUnsetCount = 0;

  for (const side of ['A', 'B']) {
    const idField = `fighter${side}Id`;
    const nameField = `matchFighter${side}`;
    const imageField = `fighter${side}Image`;
    const deleteUrlField = `fighter${side}ImageDeleteUrl`;
    const displayName = cleanString(record[nameField]);
    const category = normalizeName(record.matchCategory) || 'combat';
    const normalizedName = normalizeName(displayName);
    let fighterId = normalizeExistingObjectId(record[idField]);
    let resolvedBy = fighterId ? 'existing_ref' : null;

    if (!fighterId && options.resolveMissingRefs && normalizedName) {
      const fighter = fighterByKeyMap.get(fighterKey(category, normalizedName));
      if (fighter?._id) {
        fighterId = String(fighter._id);
        update.$set[idField] = fighter._id;
        linkedByNameCount += 1;
        resolvedBy = 'name_category_lookup';
      }
    }

    const legacyFields = [];
    if (options.removeLegacyNames !== false && cleanString(record[nameField])) legacyFields.push(nameField);
    if (options.removeLegacyImages !== false && cleanString(record[imageField])) legacyFields.push(imageField);
    if (options.removeLegacyDeleteUrls !== false && cleanString(record[deleteUrlField])) legacyFields.push(deleteUrlField);

    if (fighterId) {
      for (const field of legacyFields) {
        update.$unset[field] = '';
        legacyFieldsUnsetCount += 1;
      }
    } else if (legacyFields.length) {
      unresolvedSides.push({ side, displayName, category, reason: 'No active fighter-library record found for this side.' });
    }

    sides[side] = {
      fighterId: fighterId || null,
      displayName,
      category,
      normalizedName,
      resolvedBy,
      legacyFields,
      willUnsetLegacyFields: Boolean(fighterId && legacyFields.length),
    };
  }

  if (!Object.keys(update.$set).length) delete update.$set;
  if (!Object.keys(update.$unset).length) delete update.$unset;

  return {
    update,
    sides,
    unresolvedSides,
    linkedByNameCount,
    legacyFieldsUnsetCount,
    hasUpdate: Boolean(update.$set || update.$unset),
  };
}

function summarizeFightFighterCleanupPlan(record, plan) {
  return {
    id: String(record._id),
    sourceType: record.__collection || 'match',
    matchName: record.matchName,
    matchType: record.matchType,
    matchStatus: record.matchStatus,
    hasUpdate: plan.hasUpdate,
    fighterAId: plan.sides.A?.fighterId || null,
    fighterBId: plan.sides.B?.fighterId || null,
    fighterAResolvedBy: plan.sides.A?.resolvedBy || null,
    fighterBResolvedBy: plan.sides.B?.resolvedBy || null,
    legacyFieldsToUnset: [
      ...(plan.sides.A?.willUnsetLegacyFields ? plan.sides.A.legacyFields : []),
      ...(plan.sides.B?.willUnsetLegacyFields ? plan.sides.B.legacyFields : []),
    ],
    unresolvedSides: plan.unresolvedSides,
  };
}

function normalizeExistingObjectId(value) {
  if (!value) return '';
  if (typeof value === 'object' && value._id) return String(value._id);
  return cleanString(value);
}

function collectFighterImportGroups(records) {
  const map = new Map();
  for (const record of records || []) {
    for (const side of ['A', 'B']) {
      const name = cleanString(side === 'A' ? record.matchFighterA : record.matchFighterB);
      if (!name) continue;
      const normalizedName = normalizeName(name);
      const category = normalizeName(record.matchCategory) || 'combat';
      const key = fighterKey(category, normalizedName);
      if (!map.has(key)) {
        map.set(key, {
          displayName: name,
          normalizedName,
          category,
          aliases: new Set([name]),
          candidateImages: new Map(),
          matchIds: new Set(),
          links: [],
        });
      }
      const item = map.get(key);
      item.aliases.add(name);
      item.matchIds.add(String(record._id));
      item.links.push({ collection: record.__collection || 'match', matchId: String(record._id), side });

      const image = cleanString(side === 'A' ? record.fighterAImage : record.fighterBImage);
      const publicId = cleanString(side === 'A' ? record.fighterAImageDeleteUrl : record.fighterBImageDeleteUrl);
      if (image && image !== 'null') {
        const current = item.candidateImages.get(image) || { url: image, count: 0, publicId: '', latestAt: null };
        current.count += 1;
        current.publicId = current.publicId || normalizePublicId(publicId);
        current.latestAt = maxDateString(current.latestAt, record.updatedAt || record.createdAt);
        item.candidateImages.set(image, current);
      }
    }
  }
  return map;
}

function sortedImageCandidates(candidateMap) {
  return Array.from(candidateMap.values()).sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return new Date(b.latestAt || 0) - new Date(a.latestAt || 0);
  });
}

async function pickValidImageCandidate(candidates, {
  axios,
  checkImages,
  maxCandidateChecksPerFighter,
  imageTimeoutMs = 1200,
  allowGetFallback = false,
}) {
  const checked = [];
  const toCheck = candidates.slice(0, maxCandidateChecksPerFighter);

  for (const candidate of toCheck) {
    const health = checkImages
      ? await checkImageUrl(candidate.url, axios, { timeoutMs: imageTimeoutMs, fallbackGet: allowGetFallback })
      : summarizeImageUrl(candidate.url);
    checked.push({
      url: candidate.url,
      status: health.status,
      httpStatus: health.httpStatus || null,
      contentType: health.contentType || null,
      timeoutMs: health.timeoutMs || null,
      error: health.error || null,
    });
    if (!checkImages || health.status === 'valid') {
      return { validCandidate: { ...candidate, health }, checked };
    }
  }

  return { validCandidate: null, checked };
}

function summarizeImportPlanItem(row) {
  return {
    displayName: row.displayName,
    normalizedName: row.normalizedName,
    category: row.category,
    aliases: row.aliases,
    primaryImage: row.verifiedImage?.url || null,
    imageStatus: row.verifiedImage ? 'valid' : 'needs_review',
    matchCount: row.matchCount,
    matchIds: row.matchIds.slice(0, 25),
    imageChecks: row.imageChecks,
  };
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
    imageHealth: isPlainObject(body.imageHealth) ? body.imageHealth : undefined,
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
  if (body.imageHealth !== undefined && isPlainObject(body.imageHealth)) patch.imageHealth = body.imageHealth;
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

function buildFighterSort(query, adminView = false) {
  const sortBy = cleanString(query.sortBy || query.sort || 'displayName');
  const sortOrder = String(query.sortOrder || query.order || 'asc').toLowerCase() === 'desc' ? -1 : 1;
  const allowed = new Set(['displayName', 'updatedAt', 'createdAt', 'category', 'status']);
  if (allowed.has(sortBy)) return { [sortBy]: sortOrder, _id: 1 };
  return adminView ? { updatedAt: -1, displayName: 1, _id: 1 } : { displayName: 1, _id: 1 };
}


function compareAdminFightRecords(a = {}, b = {}) {
  const toTime = (value) => {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
  };
  const aType = String(a.matchType || '').toUpperCase() === 'LIVE' ? 1 : 0;
  const bType = String(b.matchType || '').toUpperCase() === 'LIVE' ? 1 : 0;
  if (aType !== bType) return bType - aType;
  const aTime = Math.max(toTime(a.updatedAt), toTime(a.createdAt), toTime(a.matchDate), toTime(a._id?.getTimestamp?.()));
  const bTime = Math.max(toTime(b.updatedAt), toTime(b.createdAt), toTime(b.matchDate), toTime(b._id?.getTimestamp?.()));
  return bTime - aTime;
}

function buildAdminFightFilter(query, options = {}) {
  const filter = {};
  const defaultMatchType = options.defaultMatchType;
  const requestedMatchType = cleanString(query.matchType || query.type || defaultMatchType);

  if (requestedMatchType && !isAllFilterValue(requestedMatchType)) {
    filter.matchType = exactTextRegex(requestedMatchType) || requestedMatchType;
  }

  if (!isAllFilterValue(query.status)) filter.matchStatus = exactTextRegex(query.status) || query.status;
  const andFilters = [];
  if (!isAllFilterValue(query.category)) {
    const categoryRegex = exactTextRegex(query.category);
    andFilters.push({ $or: [{ matchCategory: categoryRegex }, { matchCategoryTwo: categoryRegex }] });
  }
  if (query.search) {
    const searchText = String(query.search).trim();
    const searchRegex = new RegExp(escapeRegExp(searchText), 'i');
    const searchOr = [
      { matchName: searchRegex },
      { matchFighterA: searchRegex },
      { matchFighterB: searchRegex },
      { matchDescription: searchRegex },
    ];
    if (mongooseLikeObjectId(searchText)) searchOr.push({ _id: searchText });
    andFilters.push({ $or: searchOr });
  }
  if (andFilters.length === 1) Object.assign(filter, andFilters[0]);
  if (andFilters.length > 1) filter.$and = andFilters;
  return filter;
}

function serializeAdminFight(item, sourceType) {
  const fighterA = normalizePopulatedFighter(item.fighterAId);
  const fighterB = normalizePopulatedFighter(item.fighterBId);
  return {
    ...item,
    id: String(item._id),
    sourceType,
    fighterAId: fighterA?.id || normalizeExistingObjectId(item.fighterAId) || null,
    fighterBId: fighterB?.id || normalizeExistingObjectId(item.fighterBId) || null,
    fighterA,
    fighterB,
    matchFighterA: fighterA?.displayName || item.matchFighterA || '',
    matchFighterB: fighterB?.displayName || item.matchFighterB || '',
    fighterAImage: fighterA?.primaryImage || item.fighterAImage || '',
    fighterBImage: fighterB?.primaryImage || item.fighterBImage || '',
    fighterAImageResolved: fighterA?.primaryImage || item.fighterAImage || null,
    fighterBImageResolved: fighterB?.primaryImage || item.fighterBImage || null,
  };
}


function mongooseLikeObjectId(value) {
  return /^[a-fA-F0-9]{24}$/.test(String(value || '').trim());
}

function normalizePopulatedFighter(value) {
  if (!value || typeof value !== 'object' || !value._id) return null;
  return serializeCombatFighter(value);
}

function summarizeImageUrl(url) {
  if (!url || url === 'null') return { status: 'missing', url: url || null };
  return { status: 'unchecked', url, provider: inferImageProvider(url) };
}

async function checkImageUrl(url, axios, options = {}) {
  const summary = summarizeImageUrl(url);
  if (summary.status === 'missing') return summary;
  if (!axios || !/^https?:\/\//i.test(url)) return { ...summary, status: 'invalid' };

  const timeoutMs = clamp(toInt(options.timeoutMs, 2500), 400, 7000);
  const fallbackGet = parseBool(options.fallbackGet, true);

  try {
    const response = await axios.head(url, { timeout: timeoutMs, validateStatus: () => true });
    const headResult = {
      ...summary,
      status: response.status >= 200 && response.status < 400 ? 'valid' : 'broken',
      httpStatus: response.status,
      contentType: response.headers?.['content-type'],
      timeoutMs,
    };

    if (headResult.status === 'broken' && response.status === 405 && fallbackGet) {
      return checkImageUrlWithGet(summary, axios, timeoutMs);
    }

    return headResult;
  } catch (headError) {
    if (!fallbackGet) {
      return {
        ...summary,
        status: 'broken',
        timeoutMs,
        error: headError.message,
        fallbackSkipped: true,
      };
    }

    return checkImageUrlWithGet(summary, axios, timeoutMs, headError);
  }
}

async function checkImageUrlWithGet(summary, axios, timeoutMs, headError) {
  try {
    const response = await axios.get(summary.url, { timeout: timeoutMs, responseType: 'stream', validateStatus: () => true });
    if (response.data && typeof response.data.destroy === 'function') response.data.destroy();
    return {
      ...summary,
      status: response.status >= 200 && response.status < 400 ? 'valid' : 'broken',
      httpStatus: response.status,
      contentType: response.headers?.['content-type'],
      timeoutMs,
      fallback: 'GET',
    };
  } catch (getError) {
    return { ...summary, status: 'broken', timeoutMs, error: getError.message || headError?.message };
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
    deletedAt: fighter.deletedAt,
    createdAt: fighter.createdAt,
    updatedAt: fighter.updatedAt,
  };
}

function selectFieldsForFighterImport() {
  return '_id matchName matchCategory matchCategoryTwo matchFighterA matchFighterB fighterAImage fighterBImage fighterAImageDeleteUrl fighterBImageDeleteUrl updatedAt createdAt matchType matchStatus fighterAId fighterBId';
}

function tagRecords(records, collection) {
  return (records || []).map((record) => ({ ...record, __collection: collection }));
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

function normalizePublicId(value) {
  const text = cleanString(value);
  if (!text || /^https?:\/\//i.test(text)) return '';
  return text;
}

function maxDateString(a, b) {
  const timeA = a ? new Date(a).getTime() : 0;
  const timeB = b ? new Date(b).getTime() : 0;
  return timeB > timeA ? b : a;
}

function fighterKey(category, normalizedName) {
  return `${category}:${normalizedName}`;
}

function mergeUniqueStrings(...lists) {
  return [...new Set(lists.flat().map((item) => cleanString(item)).filter(Boolean))];
}

function pagination(page, limit, total) {
  const pages = Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    pages,
    hasNextPage: page < pages,
    hasPrevPage: page > 1,
    nextPage: page < pages ? page + 1 : null,
    prevPage: page > 1 ? page - 1 : null,
  };
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

function isAllFilterValue(value) {
  return value === undefined || value === null || value === '' || String(value).toLowerCase() === 'all';
}

function exactTextRegex(value) {
  const text = cleanString(value);
  if (!text || isAllFilterValue(text)) return null;
  return new RegExp(`^${escapeRegExp(text)}$`, 'i');
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
    buildCombatFighterImportPlan,
    collectFighterImportGroups,
    normalizeName,
  },
};
