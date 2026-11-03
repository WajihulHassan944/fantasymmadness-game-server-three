'use strict';

// Admin routes for fight-specific campaign drafts (Growth Command Center).
//
// Phase 1 safety:
// - Fight Registry (Match / Shadow / ProWrestlingMatch), affiliates and
//   approved posters are READ ONLY here. No fight, affiliate, poster, payment
//   or email record is written.
// - Drafts are stored only in the growth engine's own collection,
//   fan_acquisition_fight_campaigns.
// - Nothing is posted, emailed or messaged. queued/published/failed are
//   refused until Phase 2 is approved.

const core = require('./fan-acquisition-fight-campaigns');
const { isFightOpenForEntry, getFightEntryLockTime } = require('./fight-entry-time');
const { wrestlingPromotionFight, isWrestlingPromotionOpen } = require('./wrestling-promotion');
const { affiliateLeagueFightLink, affiliatePaidFightLink } = require('./affiliate-custom-poster');

const OBJECT_ID = /^[a-f\d]{24}$/i;
const WINDOW_DAYS = 60;
// Bounded work so the shared daily research cron cannot run long.
const CRON_MAX_FIGHTS = 40;
const CRON_BUDGET_MS = 5000;
const MANUAL_MAX_FIGHTS = 60;
const MANUAL_BUDGET_MS = 20000;
// Drafts remove themselves 30 days after the fight; replaced drafts after 14.
const KEEP_AFTER_FIGHT_MS = 30 * 86400 * 1000;
const KEEP_SUPERSEDED_MS = 14 * 86400 * 1000;
const purgeAfterFor = (campaign, now) => {
  const start = Date.parse(campaign.schedule?.startsAt || '') || Date.parse(`${campaign.schedule?.dateKey || ''}T23:59:59Z`) || now.getTime();
  return new Date(Math.max(start, now.getTime()) + KEEP_AFTER_FIGHT_MS);
};

module.exports = function registerFanAcquisitionFightRoutes({ app, mongoose, verifyAdminToken, getLatestResearch }) {
  const db = () => mongoose.connection.db;
  const store = () => db().collection('fan_acquisition_fight_campaigns');
  const audienceStore = () => db().collection('fan_acquisition_audiences');
  const models = () => ({
    Match: mongoose.models.Match, Shadow: mongoose.models.Shadow,
    ProWrestlingMatch: mongoose.models.ProWrestlingMatch, Affiliate: mongoose.models.Affiliate,
  });
  let indexed = false;
  const ensureIndexes = async () => {
    if (indexed) return;
    await store().createIndex({ dedupeKey: 1 }, { unique: true });
    await store().createIndex({ fightId: 1, affiliateId: 1, createdAt: -1 });
    // MongoDB deletes each draft once its purgeAfter date passes.
    await store().createIndex({ purgeAfter: 1 }, { expireAfterSeconds: 0 });
    indexed = true;
  };
  const reviewer = (req) => String(req.admin?.email || req.admin?.id || req.admin?._id || 'admin');
  const isOpenFor = (source) => (fight) => (source === 'pro_wrestling' ? isWrestlingPromotionOpen(fight) : isFightOpenForEntry(fight));

  // ---- read-only registry access --------------------------------------
  const normalizeWrestling = (raw) => {
    const fight = wrestlingPromotionFight(raw);
    // Only the poster the owner saved counts; older banner art never stands in.
    if (fight) fight.fightPosterImage = String(raw.fightPosterImage || '').trim();
    if (fight) { fight.venue = raw.venue; fight.eventCity = raw.eventCity || raw.city; fight.eventTimeZone = raw.eventTimeZone; }
    return fight;
  };

  async function upcomingFights({ fightIds = null, now = new Date() } = {}) {
    const { Match, Shadow, ProWrestlingMatch } = models();
    const from = new Date(now.getTime() - 36 * 3600 * 1000);
    const to = new Date(now.getTime() + WINDOW_DAYS * 86400 * 1000);
    const byId = fightIds ? { _id: { $in: fightIds.filter((id) => OBJECT_ID.test(id)).map((id) => new mongoose.Types.ObjectId(id)) } } : {};
    const dated = fightIds ? byId : { matchDate: { $gte: from, $lte: to } };
    const reads = [];
    if (Match) reads.push(Match.find({ ...dated, matchStatus: { $nin: ['Finished', 'Closed', 'Draft'] } }).sort({ matchDate: 1 }).limit(150).lean().then((rows) => rows.map((f) => ({ fight: f, source: 'match' }))));
    if (Shadow) reads.push(Shadow.find({ ...dated }).sort({ matchDate: 1 }).limit(150).lean().then((rows) => rows.map((f) => ({ fight: f, source: 'shadow' }))).catch(() => []));
    if (ProWrestlingMatch) reads.push(ProWrestlingMatch.find({ ...dated, publicVisible: true, status: { $nin: ['DRAFT', 'FINALIZED', 'CANCELLED', 'NO_CONTEST'] } }).sort({ matchDate: 1 }).limit(150).lean().then((rows) => rows.map((f) => ({ fight: normalizeWrestling(f), source: 'pro_wrestling' }))).catch(() => []));
    const rows = (await Promise.all(reads)).flat().filter((r) => r.fight);
    const seen = new Set();
    const when = (r) => Date.parse(r.fight.matchDate || '') || Number.MAX_SAFE_INTEGER;
    return rows.filter((r) => { const id = String(r.fight._id); if (seen.has(id)) return false; seen.add(id); return true; })
      .sort((x, y) => when(x) - when(y));
  }

  async function findAffiliate(affiliateId) {
    if (!affiliateId) return null;
    if (!OBJECT_ID.test(String(affiliateId))) return undefined;
    const { Affiliate } = models();
    return Affiliate ? Affiliate.findById(affiliateId).select('firstName lastName playerName leagueName promoterSuspendedAt status suspended').lean() : undefined;
  }

  async function approvedPosters(fightId, affiliateId) {
    if (!affiliateId) return [];
    // Raw read without the image bytes; never modifies poster records.
    return db().collection('affiliatecustomposters')
      .find({ fightId: String(fightId), affiliateId: String(affiliateId), status: 'approved' }, { projection: { image: 0 } })
      .limit(10).toArray().catch(() => []);
  }

  async function build({ fight, source }, affiliate, now = Date.now()) {
    const posters = await approvedPosters(fight._id, affiliate?._id);
    return core.buildFightCampaign({
      fight, source, affiliate, affiliatePosters: posters,
      isOpen: isOpenFor(source), isPublic: (f) => core.isPublicFight(f, source), getLockTime: getFightEntryLockTime,
      affiliateLeagueFightLink, affiliatePaidFightLink, now,
    });
  }

  // Ties saved research to a real fight: news leads that name a fighter, and
  // the saved audience candidates for the same sport. Research only; nothing
  // is contacted.
  const loadLatestResearch = async () => (typeof getLatestResearch === 'function' ? getLatestResearch().catch(() => null) : null);
  async function researchContext(campaign, latest, audienceCache = new Map()) {
    const lastName = (name) => String(name || '').trim().split(/\s+/).pop().toLowerCase();
    const names = [lastName(campaign.fighterA), lastName(campaign.fighterB)].filter((n) => n.length >= 3);
    const agent = (latest?.agents || []).find((a) => a.id === campaign.sport);
    const news = (latest?.agents || []).flatMap((a) => a.opportunities || [])
      .filter((o) => names.some((n) => String(o.title || '').toLowerCase().includes(n)))
      .slice(0, 5).map((o) => ({ title: core.cleanText(o.title, 220), url: o.url, publishedAt: o.publishedAt || null }));
    if (!audienceCache.has(campaign.sport)) {
      audienceCache.set(campaign.sport, await audienceStore().find({ sport: campaign.sport }, { projection: { name: 1, url: 1, type: 1, outreachStatus: 1 } })
        .sort({ updatedAt: -1 }).limit(8).toArray().catch(() => []));
    }
    const audiences = audienceCache.get(campaign.sport);
    return {
      researchRunAt: latest?.createdAt || null,
      matchingNews: news,
      suggestedAudiences: audiences.map((a) => ({ name: core.cleanText(a.name, 160), url: a.url, type: a.type, outreachStatus: a.outreachStatus || 'not_contacted' })),
      sportResearchStatus: agent?.status || 'no_saved_research',
      note: 'Research leads only. No audience has been contacted.',
    };
  }

  // Saves drafts. The same fight + affiliate + facts is never stored twice;
  // a changed fight produces a new draft and marks older unpublished ones as
  // superseded (with the reason shown to the owner).
  async function generate({ fightIds = null, affiliateId = '', now = new Date(), maxFights = MANUAL_MAX_FIGHTS, budgetMs = MANUAL_BUDGET_MS } = {}) {
    // A preview may inherit production MONGODB_URI. Never write campaign drafts,
    // create indexes, or run cron generation from a Vercel preview until a
    // separate test database has been independently verified and enabled.
    if (process.env.VERCEL_ENV === 'preview') {
      return { error: 'Preview campaign generation is disabled until database isolation is verified.', status: 503, isolationRequired: true };
    }
    const deadline = Date.now() + budgetMs;
    await ensureIndexes();
    let affiliate = null;
    if (affiliateId) {
      affiliate = await findAffiliate(affiliateId);
      if (!affiliate) return { error: 'Affiliate account not found.', status: 404 };
    }
    const fights = await upcomingFights({ fightIds, now });
    const latest = await loadLatestResearch();
    const created = []; const duplicates = []; const skipped = [];
    const audienceCache = new Map();
    let processed = 0;
    for (const row of fights) {
      if (processed >= maxFights || Date.now() > deadline) break;
      processed += 1;
      const result = await build(row, affiliate, now.getTime());
      if (result.skipped) {
        skipped.push({ fightId: String(row.fight._id), matchup: [row.fight.matchFighterA, row.fight.matchFighterB].filter(Boolean).join(' vs ') || String(row.fight.matchName || ''), reasons: result.reasons });
        continue;
      }
      // Unchanged fight: one cheap lookup, no research work, no new record.
      if (await store().findOne({ dedupeKey: result.campaign.dedupeKey }, { projection: { _id: 1 } })) { duplicates.push({ fightId: result.campaign.fightId, matchup: result.campaign.matchup }); continue; }
      const doc = { ...result.campaign, research: await researchContext(result.campaign, latest, audienceCache), createdAt: now, updatedAt: now, purgeAfter: purgeAfterFor(result.campaign, now), superseded: false, history: [{ from: null, to: result.campaign.state, by: 'growth-engine', at: now.toISOString(), note: 'Draft generated. Nothing was sent.' }] };
      const write = await store().updateOne({ dedupeKey: doc.dedupeKey }, { $setOnInsert: doc }, { upsert: true });
      if (!write.upsertedCount) { duplicates.push({ fightId: doc.fightId, matchup: doc.matchup }); continue; }
      await store().updateMany(
        { fightId: doc.fightId, affiliateId: doc.affiliateId, dedupeKey: { $ne: doc.dedupeKey }, superseded: { $ne: true }, state: { $in: ['draft', 'needs_review', 'approved'] } },
        { $set: { superseded: true, supersededBy: doc.dedupeKey, state: 'needs_review', updatedAt: now, purgeAfter: new Date(now.getTime() + KEEP_SUPERSEDED_MS), 'validation.supersededReason': 'Fight details or poster changed. A newer draft replaces this one.' } },
      );
      created.push({ fightId: doc.fightId, matchup: doc.matchup, state: doc.state });
    }
    const remaining = fights.length - processed;
    return { created, duplicates, skipped, inspected: processed, eligibleInWindow: fights.length, partial: remaining > 0, remaining };
  }
  const generateForCron = () => generate({ maxFights: CRON_MAX_FIGHTS, budgetMs: CRON_BUDGET_MS });
  app.locals.fanAcquisitionFightCampaigns = { generate, generateForCron };

  const loadCampaign = async (id) => (OBJECT_ID.test(String(id || '')) ? store().findOne({ _id: new mongoose.Types.ObjectId(id) }) : null);
  const rebuildCurrent = async (campaign) => {
    const rows = await upcomingFights({ fightIds: [campaign.fightId] });
    if (!rows.length) return { skipped: true, reasons: ['This fight is no longer in the Fight Registry or is outside the promotion window.'] };
    const affiliate = campaign.affiliateId ? await findAffiliate(campaign.affiliateId) : null;
    if (campaign.affiliateId && !affiliate) return { skipped: true, reasons: ['Affiliate account not found.'] };
    return build(rows[0], affiliate);
  };
  const fail = (res, status, message, extra = {}) => res.status(status).json({ ok: false, message, ...extra });

  // Which fights could be promoted right now, and why others cannot. No writes.
  app.get('/api/admin/fan-acquisition/fight-campaigns/fights', verifyAdminToken, async (req, res) => {
    try {
      const affiliate = req.query.affiliateId ? await findAffiliate(String(req.query.affiliateId)) : null;
      if (req.query.affiliateId && !affiliate) return fail(res, 404, 'Affiliate account not found.');
      const fights = await upcomingFights();
      const out = [];
      for (const row of fights) {
        const r = await build(row, affiliate);
        out.push(r.skipped
          ? { fightId: String(row.fight._id), source: row.source, matchup: [row.fight.matchFighterA, row.fight.matchFighterB].filter(Boolean).join(' vs '), eligible: false, reasons: r.reasons }
          : { fightId: r.campaign.fightId, source: row.source, matchup: r.campaign.matchup, eligible: true, schedule: r.campaign.schedule, hasPoster: Boolean(r.campaign.poster), state: r.campaign.state, warnings: r.campaign.validation.warnings, blocking: r.campaign.validation.blocking });
      }
      res.set('Cache-Control', 'private, no-store');
      return res.json({ ok: true, fights: out, windowDays: WINDOW_DAYS, publishingEnabled: false });
    } catch (error) {
      console.error('[fan-acquisition] fight list failed:', error?.message);
      return fail(res, 503, 'Fight Registry could not be read.');
    }
  });

  app.post('/api/admin/fan-acquisition/fight-campaigns/generate', verifyAdminToken, async (req, res) => {
    try {
      const fightIds = Array.isArray(req.body?.fightIds) ? req.body.fightIds.map(String).filter((id) => OBJECT_ID.test(id)).slice(0, 50) : null;
      const affiliateId = req.body?.affiliateId ? String(req.body.affiliateId) : '';
      const result = await generate({ fightIds: fightIds && fightIds.length ? fightIds : null, affiliateId });
      if (result.error) return fail(res, result.status || 400, result.error);
      return res.json({ ok: true, ...result, publishingEnabled: false, note: 'Drafts only. Nothing was posted or sent.' });
    } catch (error) {
      console.error('[fan-acquisition] fight campaign generation failed:', error?.message);
      return fail(res, 503, 'Fight campaigns could not be prepared.');
    }
  });

  app.get('/api/admin/fan-acquisition/fight-campaigns', verifyAdminToken, async (req, res) => {
    try {
      const query = req.query.includeSuperseded === 'true' ? {} : { superseded: { $ne: true } };
      if (req.query.state && core.STATES.includes(String(req.query.state))) query.state = String(req.query.state);
      const campaigns = await store().find(query).sort({ createdAt: -1 }).limit(60).toArray();
      // Live recheck against the Fight Registry so a changed or locked fight is
      // flagged before anyone acts on an old draft.
      for (const c of campaigns) {
        if (c.superseded || ['published', 'failed'].includes(c.state)) continue;
        const current = await rebuildCurrent(c).catch(() => null);
        c.liveCheck = !current ? { ok: false, reasons: ['Live check unavailable.'] }
          : current.skipped ? { ok: false, reasons: current.reasons }
            : current.campaign.fingerprint !== c.fingerprint ? { ok: false, reasons: ['Fight record or poster changed since this draft. Generate a fresh draft.'] }
              : { ok: true, reasons: [] };
      }
      res.set('Cache-Control', 'private, no-store');
      return res.json({ ok: true, campaigns, states: core.STATES, checks: core.REVIEW_CHECKS, checkLabels: core.REVIEW_CHECK_LABELS, publishingEnabled: false });
    } catch (error) {
      console.error('[fan-acquisition] fight campaign list failed:', error?.message);
      return fail(res, 503, 'Fight campaigns unavailable.');
    }
  });

  app.post('/api/admin/fan-acquisition/fight-campaigns/:id/checks', verifyAdminToken, async (req, res) => {
    try {
      const campaign = await loadCampaign(req.params.id);
      if (!campaign) return fail(res, 404, 'Campaign not found.');
      if (campaign.superseded) return fail(res, 409, 'A newer draft replaced this campaign. Review the newest draft.');
      const result = core.applyReviewCheck(campaign, { channel: String(req.body?.channel || ''), check: String(req.body?.check || ''), result: String(req.body?.result || ''), note: req.body?.note, reviewer: reviewer(req) });
      if (result.error) return fail(res, 400, result.error);
      const { channels, validation, state } = result.campaign;
      const write = await store().updateOne({ _id: campaign._id, state: campaign.state, superseded: { $ne: true } }, { $set: { channels, validation, state, updatedAt: new Date() } });
      if (!write.matchedCount) return fail(res, 409, 'This campaign changed while you were reviewing it. Refresh and try again.');
      return res.json({ ok: true, state, channel: channels[req.body.channel] });
    } catch (error) {
      return fail(res, 503, 'Review check could not be saved.');
    }
  });

  app.post('/api/admin/fan-acquisition/fight-campaigns/:id/status', verifyAdminToken, async (req, res) => {
    try {
      const to = String(req.body?.status || '');
      if (core.DISTRIBUTION_STATES.includes(to)) return fail(res, 403, 'Publishing is not enabled. Campaigns cannot be queued or published in Phase 1.', { publishingEnabled: false });
      const campaign = await loadCampaign(req.params.id);
      if (!campaign) return fail(res, 404, 'Campaign not found.');
      if (campaign.superseded) return fail(res, 409, 'A newer draft replaced this campaign. Review the newest draft.');
      const current = to === 'approved' ? await rebuildCurrent(campaign) : null;
      const result = core.transition(campaign, { to, current, reviewer: reviewer(req), note: req.body?.note });
      if (result.error) return fail(res, 409, result.error, { problems: result.problems || [] });
      const next = result.campaign;
      const write = await store().updateOne({ _id: campaign._id, state: campaign.state, superseded: { $ne: true } }, { $set: { state: next.state, history: next.history, approvedAt: next.approvedAt || null, approvedBy: next.approvedBy || null, updatedAt: new Date() } });
      if (!write.matchedCount) return fail(res, 409, 'This campaign changed while you were reviewing it. Refresh and try again.');
      return res.json({ ok: true, state: next.state, publishingEnabled: false, note: next.state === 'approved' ? 'Approved as a draft. Nothing was posted or sent.' : undefined });
    } catch (error) {
      return fail(res, 503, 'Status could not be saved.');
    }
  });

  app.post('/api/admin/fan-acquisition/fight-campaigns/:id/reject', verifyAdminToken, async (req, res) => {
    try {
      const campaign = await loadCampaign(req.params.id);
      if (!campaign) return fail(res, 404, 'Campaign not found.');
      const result = core.reject(campaign, { reason: req.body?.reason, reviewer: reviewer(req) });
      if (result.error) return fail(res, 400, result.error);
      const n = result.campaign;
      const write = await store().updateOne({ _id: campaign._id, state: campaign.state }, { $set: { state: n.state, history: n.history, rejected: true, rejectedAt: n.rejectedAt, rejectedBy: n.rejectedBy, rejectionReason: n.rejectionReason, approvedAt: null, approvedBy: null, updatedAt: new Date() } });
      if (!write.matchedCount) return fail(res, 409, 'This campaign changed while you were reviewing it. Refresh and try again.');
      return res.json({ ok: true, state: n.state, rejected: true, publishingEnabled: false });
    } catch (error) {
      return fail(res, 503, 'Rejection could not be saved.');
    }
  });

  return { generate, generateForCron, limits: { CRON_MAX_FIGHTS, CRON_BUDGET_MS, MANUAL_MAX_FIGHTS, MANUAL_BUDGET_MS, KEEP_AFTER_FIGHT_MS, KEEP_SUPERSEDED_MS } };
};
