'use strict';

/**
 * Phase 2 Swarm Gateway for FantasyMMAdness backend.
 *
 * This file intentionally lives beside server.js so the existing backend structure
 * remains unchanged. It adds authenticated admin routes that proxy controlled work
 * to the Phase 1 IONOS swarm service and webhook routes for async callbacks.
 */

const DEFAULT_JOB_TYPE_ARRAY = [
  // Core content automation
  'content.article',
  'content.match-preview',
  'content.event-recap',
  'content.event-preview',
  'content.fight-card-article',
  'content.fighter-profile',
  'content.fighter-update-suggestion',
  'content.wrestler-profile',
  'content.pro-wrestling-match-preview',
  'content.pro-wrestling-match-recap',
  'content.rules-explainer',
  'content.email-newsletter-draft',
  'content.image-prompt',
  'content.faq-generation',
  'content.how-to-play-suggestion',
  'content.landing-page-suggestion',
  'content.old-blog-refresh',
  'content.blog-topic-suggestions',

  // SEO automation
  'seo.audit',
  'seo.metadata',
  'seo.schema-markup',
  'seo.sitemap-refresh',
  'seo.internal-links',
  'seo.related-post-linking',
  'seo.daily-audit',
  'seo.weekly-opportunity-report',
  'seo.missing-pages-detector',
  'seo.low-quality-page-detector',
  'seo.broken-link-detector',
  'seo.missing-metadata-detector',
  'seo.duplicate-content-detector',
  'seo.keyword-opportunity',
  'seo.canonical-check',
  'seo.opengraph-twitter-card',
  'seo.fight-event-structured-data',
  'seo.wrestler-fighter-structured-data',
  'seo.content-freshness-monitor',

  // Social and notification automation
  'social.draft',
  'social.twitter-post',
  'social.promotional-posts',
  'social.result-post',
  'social.reminder-post',
  'social.winners-announcement',
  'social.youtube-caption',
  'social.discord-announcement',
  'social.content-calendar',
  'social.admin-notification',

  // Data, trend, dashboard, and queue automation
  'data.external-candidate',
  'data.trending-mma-topic',
  'data.trending-pro-wrestling-topic',
  'data.content-calendar',
  'data.draft-queue-generation',
  'data.competitor-gap-report',
  'data.traffic-opportunity',
  'data.homepage-featured-content',
  'data.leaderboard-summary',

  // Existing wrestling agents
  'wrestling.scorecard-suggestion',
  'wrestling.match-analysis',
  'wrestling.wrestler-profile',

  // Admin/system controls and reports
  'automation.settings-snapshot',
  'automation.logs-report',
  'automation.failed-job-retry-report',
  'automation.agent-performance-dashboard',
  'automation.traffic-growth-dashboard',
  'system.health-check',
];

const DEFAULT_JOB_TYPES = new Set(DEFAULT_JOB_TYPE_ARRAY);

const AUTOMATION_TRIGGER_DEFAULTS = Object.freeze({
  manual: [],
  fight_published: [
    'content.match-preview',
    'social.twitter-post',
    'seo.metadata',
    'seo.schema-markup',
    'seo.sitemap-refresh',
    'seo.internal-links',
    'content.email-newsletter-draft',
    'seo.fight-event-structured-data',
  ],
  fight_result_updated: [
    'content.event-recap',
    'social.result-post',
    'data.leaderboard-summary',
  ],
  upcoming_event: [
    'content.event-preview',
    'content.fight-card-article',
    'social.promotional-posts',
    'data.homepage-featured-content',
    'seo.fight-event-structured-data',
  ],
  fighter_added: [
    'content.fighter-profile',
    'seo.wrestler-fighter-structured-data',
  ],
  fighter_updated: [
    'seo.metadata',
    'seo.content-freshness-monitor',
  ],
  fighter_record_changed: [
    'content.fighter-update-suggestion',
  ],
  pro_wrestling_match_published: [
    'content.pro-wrestling-match-preview',
    'wrestling.match-analysis',
    'social.twitter-post',
    'seo.schema-markup',
  ],
  pro_wrestling_result_updated: [
    'content.pro-wrestling-match-recap',
    'social.result-post',
  ],
  wrestler_added: [
    'content.wrestler-profile',
    'wrestling.wrestler-profile',
    'seo.wrestler-fighter-structured-data',
  ],
  contest_created: [
    'content.rules-explainer',
    'social.discord-announcement',
  ],
  contest_closing_soon: [
    'social.reminder-post',
  ],
  contest_completed: [
    'social.winners-announcement',
  ],
  blog_approved: [
    'social.twitter-post',
    'seo.audit',
    'seo.related-post-linking',
    'content.image-prompt',
    'content.email-newsletter-draft',
    'seo.opengraph-twitter-card',
  ],
  daily_schedule: [
    'seo.daily-audit',
    'seo.missing-pages-detector',
    'seo.low-quality-page-detector',
    'seo.broken-link-detector',
    'seo.missing-metadata-detector',
    'seo.keyword-opportunity',
    'data.trending-mma-topic',
    'data.trending-pro-wrestling-topic',
    'data.draft-queue-generation',
    'automation.agent-performance-dashboard',
  ],
  weekly_schedule: [
    'seo.weekly-opportunity-report',
    'seo.duplicate-content-detector',
    'data.content-calendar',
    'social.content-calendar',
    'data.competitor-gap-report',
    'data.traffic-opportunity',
    'seo.content-freshness-monitor',
    'automation.traffic-growth-dashboard',
  ],
});

const AUTOMATION_GROUPS = Object.freeze({
  content: 'Content automation',
  seo: 'SEO automation',
  social: 'Social automation',
  data: 'Data and traffic automation',
  wrestling: 'Pro-wrestling automation',
  automation: 'System and dashboard automation',
  system: 'System health',
});

const DEFAULT_VERTICALS = new Set(['combat', 'pro_wrestling']);
const DEFAULT_MODES = new Set(['DRY_RUN', 'SHADOW', 'DRAFT_ONLY', 'APPROVAL_REQUIRED', 'AUTOMATED']);
const REVIEW_STATUSES = new Set(['DRAFT', 'AWAITING_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED']);
const FINAL_JOB_STATUSES = new Set(['succeeded', 'awaiting_review', 'approved', 'published', 'rejected', 'failed', 'dead_letter', 'cancelled']);

function registerSwarmPhase2Routes(options) {
  const {
    app,
    mongoose,
    axios,
    crypto,
    verifyAdminToken,
    Blog,
    Notification,
  } = options || {};

  if (!app || !mongoose || !axios || !crypto || !verifyAdminToken) {
    throw new Error('registerSwarmPhase2Routes requires app, mongoose, axios, crypto, and verifyAdminToken.');
  }

  const models = buildSwarmModels(mongoose);
  const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  app.locals.swarmPhase2 = {
    triggerAutomationEvent: (event) => triggerAutomationEvent({
      config: getSwarmConfig(),
      axios,
      crypto,
      mongoose,
      models,
      admin: event?.admin,
      trigger: event?.trigger,
      vertical: event?.vertical,
      mode: event?.mode,
      sourceEntity: event?.sourceEntity,
      input: event?.input || {},
      metadata: { ...(isPlainObject(event?.metadata) ? event.metadata : {}), submittedFrom: event?.submittedFrom || 'backend-hook' },
      requestedJobTypes: Array.isArray(event?.jobTypes) ? event.jobTypes : undefined,
      reason: event?.reason || 'backend-hook-triggered-automation-event',
    }),
  };

  const requireSwarmEnabled = (req, res, next) => {
    const config = getSwarmConfig();
    if (!config.enabled) {
      return res.status(503).json({
        ok: false,
        code: 'SWARM_DISABLED',
        message: 'Swarm integration is disabled or SWARM_BASE_URL is not configured.',
      });
    }
    return next();
  };

  app.get('/api/admin/swarm/config', verifyAdminToken, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    res.json({
      ok: true,
      enabled: config.enabled,
      baseUrlConfigured: Boolean(config.baseUrl),
      hmacConfigured: Boolean(config.hmacSecret),
      apiKeyConfigured: Boolean(config.apiKey),
      callbackHmacConfigured: Boolean(config.callbackSecret),
      autoPublishEnabled: config.autoPublishEnabled,
      autoImportEnabled: config.autoImportEnabled,
      socialPublishEnabled: config.socialPublishEnabled,
      automationEventHooksEnabled: config.automationEventHooksEnabled,
      defaultMode: config.defaultMode,
      verticals: Array.from(DEFAULT_VERTICALS),
      jobTypes: DEFAULT_JOB_TYPE_ARRAY,
      automationTriggers: Object.keys(AUTOMATION_TRIGGER_DEFAULTS),
      automationGroups: AUTOMATION_GROUPS,
      reviewStatuses: Array.from(REVIEW_STATUSES),
    });
  }));

  app.get('/api/admin/swarm/health', verifyAdminToken, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    const cacheStats = await getCacheStats(models);
    if (!config.enabled) {
      return res.status(200).json({
        ok: true,
        swarmReachable: false,
        enabled: false,
        message: 'Backend swarm gateway is installed, but SWARM_BASE_URL/SWARM_ENABLED are not active yet.',
        cache: cacheStats,
      });
    }

    const startedAt = Date.now();
    try {
      const health = await callSwarm(config, axios, crypto, 'GET', '/health');
      const readiness = await callSwarm(config, axios, crypto, 'GET', '/readiness').catch((error) => ({ ok: false, error: summarizeError(error) }));
      return res.json({
        ok: true,
        enabled: true,
        swarmReachable: true,
        latencyMs: Date.now() - startedAt,
        health,
        readiness,
        cache: cacheStats,
      });
    } catch (error) {
      return res.status(502).json({
        ok: false,
        enabled: true,
        swarmReachable: false,
        message: 'Backend could not reach the IONOS swarm service.',
        error: summarizeError(error),
        cache: cacheStats,
      });
    }
  }));

  app.get('/api/admin/swarm/agents', verifyAdminToken, requireSwarmEnabled, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    const result = await callSwarm(config, axios, crypto, 'GET', '/internal/v1/agents');
    res.json(result);
  }));

  app.get('/api/admin/swarm/job-types', verifyAdminToken, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    if (config.enabled && String(req.query.source || '').toLowerCase() !== 'local') {
      try {
        const result = await callSwarm(config, axios, crypto, 'GET', '/internal/v1/job-types');
        return res.json({ ok: true, source: 'swarm', jobTypes: result.jobTypes || DEFAULT_JOB_TYPE_ARRAY, swarm: sanitizeSwarmEnvelope(result) });
      } catch (error) {
        if (String(req.query.fallbackLocal || 'true').toLowerCase() === 'false') throw error;
        return res.status(206).json({ ok: true, source: 'local', jobTypes: DEFAULT_JOB_TYPE_ARRAY, warning: 'Swarm unavailable; returned backend job-type fallback.', error: summarizeError(error) });
      }
    }
    res.json({ ok: true, source: 'local', jobTypes: DEFAULT_JOB_TYPE_ARRAY });
  }));

  app.get('/api/admin/swarm/catalog', verifyAdminToken, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    if (config.enabled && String(req.query.source || '').toLowerCase() !== 'local') {
      try {
        const result = await callSwarm(config, axios, crypto, 'GET', '/internal/v1/catalog');
        return res.json({ ok: true, source: 'swarm', ...result });
      } catch (error) {
        if (String(req.query.fallbackLocal || 'true').toLowerCase() === 'false') throw error;
        return res.status(206).json({ ok: true, source: 'local', warning: 'Swarm unavailable; returned backend catalog fallback.', error: summarizeError(error), ...buildLocalAutomationCatalog() });
      }
    }
    res.json({ ok: true, source: 'local', ...buildLocalAutomationCatalog() });
  }));

  app.get('/api/admin/swarm/settings', verifyAdminToken, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    if (config.enabled && String(req.query.source || '').toLowerCase() !== 'local') {
      try {
        const result = await callSwarm(config, axios, crypto, 'GET', '/internal/v1/settings');
        return res.json({ ok: true, source: 'swarm', ...result });
      } catch (error) {
        if (String(req.query.fallbackLocal || 'true').toLowerCase() === 'false') throw error;
        return res.status(206).json({ ok: true, source: 'local', warning: 'Swarm unavailable; returned backend settings fallback.', error: summarizeError(error), settings: buildDefaultAutomationSettings() });
      }
    }
    res.json({ ok: true, source: 'local', settings: buildDefaultAutomationSettings() });
  }));

  const updateSettingsHandler = asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    if (!config.enabled) {
      return res.status(503).json({ ok: false, code: 'SWARM_DISABLED', message: 'Automation settings live inside the IONOS swarm; configure SWARM_BASE_URL first.' });
    }
    const body = normalizeSettingsUpdateBody(req.body, req.admin);
    const result = await callSwarm(config, axios, crypto, req.method, '/internal/v1/settings', body);
    res.json({ ok: true, source: 'swarm', ...result });
  });
  app.patch('/api/admin/swarm/settings', verifyAdminToken, updateSettingsHandler);
  app.put('/api/admin/swarm/settings', verifyAdminToken, updateSettingsHandler);

  app.get('/api/admin/swarm/dashboard', verifyAdminToken, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    const cache = await getCacheStats(models);
    const recentEvents = await listLocalAutomationEvents(models, { limit: 10 });
    if (config.enabled && String(req.query.source || '').toLowerCase() !== 'cache') {
      try {
        const result = await callSwarm(config, axios, crypto, 'GET', '/internal/v1/dashboard');
        return res.json({ ok: true, source: 'swarm', backendCache: cache, backendEvents: recentEvents.items, ...result });
      } catch (error) {
        if (String(req.query.fallbackCache || 'true').toLowerCase() === 'false') throw error;
        return res.status(206).json({ ok: true, source: 'cache', warning: 'Swarm unavailable; returned backend dashboard cache.', error: summarizeError(error), backendCache: cache, backendEvents: recentEvents.items });
      }
    }
    res.json({ ok: true, source: 'cache', backendCache: cache, backendEvents: recentEvents.items });
  }));

  app.get('/api/admin/swarm/events', verifyAdminToken, asyncHandler(async (req, res) => {
    const result = await listLocalAutomationEvents(models, req.query);
    res.json({ ok: true, source: 'backend', ...result });
  }));

  const triggerAutomationEventHandler = asyncHandler(async (req, res) => {
    const trigger = normalizeAutomationTrigger(req.params.trigger || req.body?.trigger);
    const result = await triggerAutomationEvent({
      config: getSwarmConfig(),
      axios,
      crypto,
      mongoose,
      models,
      admin: req.admin,
      trigger,
      vertical: req.body?.vertical,
      mode: req.body?.mode,
      sourceEntity: req.body?.sourceEntity,
      input: req.body?.input || req.body?.context || {},
      metadata: { ...(isPlainObject(req.body?.metadata) ? req.body.metadata : {}), submittedFromRoute: req.originalUrl },
      requestedJobTypes: Array.isArray(req.body?.jobTypes) ? req.body.jobTypes : undefined,
      reason: req.body?.reason || 'admin-triggered-automation-event',
    });
    res.status(result.createdJobs.length ? 202 : 200).json({ ok: true, ...result });
  });
  app.post('/api/admin/swarm/events/trigger', verifyAdminToken, requireSwarmEnabled, triggerAutomationEventHandler);
  app.post('/api/admin/swarm/events/:trigger', verifyAdminToken, requireSwarmEnabled, triggerAutomationEventHandler);

  app.post('/api/admin/swarm/automations/:jobType/run', verifyAdminToken, requireSwarmEnabled, asyncHandler(async (req, res) => {
    const jobType = String(req.params.jobType || '').trim();
    if (!DEFAULT_JOB_TYPES.has(jobType)) throw httpError(400, 'INVALID_SWARM_JOB_TYPE', 'Unsupported swarm jobType.');
    req.body = {
      ...req.body,
      jobType,
      vertical: req.body?.vertical || inferVerticalForJobType(jobType),
      sourceEntity: req.body?.sourceEntity || { type: 'manual_automation', label: jobType },
      metadata: { ...(isPlainObject(req.body?.metadata) ? req.body.metadata : {}), manualAutomationRun: true },
    };
    const config = getSwarmConfig();
    const normalized = normalizeCreateJobBody(req.body, req.admin, config, mongoose);
    const localId = new mongoose.Types.ObjectId();
    const backendCorrelationId = String(localId);
    const idempotencyKey = createIdempotencyKey({ crypto, normalized, backendCorrelationId });
    const submitted = await submitNormalizedJobToSwarm({ config, axios, crypto, mongoose, models, normalized, localId, backendCorrelationId, idempotencyKey, submitReason: 'manual-automation-run' });
    res.status(202).json({ ok: true, job: serializeLocalJob(submitted.localJob), swarm: sanitizeSwarmEnvelope(submitted.swarmResult) });
  }));

  app.post('/api/admin/swarm/jobs', verifyAdminToken, requireSwarmEnabled, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    const normalized = normalizeCreateJobBody(req.body, req.admin, config, mongoose);
    const localId = new mongoose.Types.ObjectId();
    const backendCorrelationId = String(req.body?.backendCorrelationId || localId);
    const idempotencyKey = normalized.idempotencyKey || createIdempotencyKey({ crypto, normalized, backendCorrelationId });
    const localJob = await models.SwarmBackendJob.create({
      _id: localId,
      backendCorrelationId,
      idempotencyKey,
      vertical: normalized.vertical,
      jobType: normalized.jobType,
      mode: normalized.mode,
      priority: normalized.priority,
      status: 'submitting',
      requestedBy: normalized.requestedBy,
      sourceEntity: normalized.sourceEntity,
      input: normalized.input,
      metadata: normalized.metadata,
      statusHistory: [{ status: 'submitting', at: new Date(), reason: 'backend-submit-started' }],
    });

    const swarmPayload = {
      ...normalized,
      idempotencyKey,
      backendCorrelationId,
    };

    try {
      const result = await callSwarm(config, axios, crypto, 'POST', '/internal/v1/jobs', swarmPayload);
      const swarmJob = result.job || result.data?.job || result;
      await upsertJobFromSwarm(models, swarmJob, {
        localId,
        idempotencyKey,
        backendCorrelationId,
        requestedBy: normalized.requestedBy,
        sourceEntity: normalized.sourceEntity,
        input: normalized.input,
        metadata: normalized.metadata,
      });
      const updated = await models.SwarmBackendJob.findById(localId).lean();
      return res.status(result.created === false ? 200 : 202).json({
        ok: true,
        created: result.created !== false,
        job: serializeLocalJob(updated),
        swarm: sanitizeSwarmEnvelope(result),
      });
    } catch (error) {
      localJob.status = 'failed_to_submit';
      localJob.error = summarizeError(error);
      localJob.statusHistory.push({ status: 'failed_to_submit', at: new Date(), reason: 'swarm-submit-failed' });
      await localJob.save();
      return res.status(error.httpStatus || 502).json({
        ok: false,
        code: 'SWARM_JOB_SUBMIT_FAILED',
        message: 'Could not submit job to the IONOS swarm.',
        error: summarizeError(error),
        localJob: serializeLocalJob(localJob),
      });
    }
  }));

  app.get('/api/admin/swarm/jobs', verifyAdminToken, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    const useCacheOnly = String(req.query.source || '').toLowerCase() === 'cache' || !config.enabled;
    if (!useCacheOnly) {
      try {
        const remote = await callSwarm(config, axios, crypto, 'GET', '/internal/v1/jobs', undefined, pickQuery(req.query, ['status', 'vertical', 'jobType', 'page', 'limit']));
        const items = Array.isArray(remote.items) ? remote.items : [];
        await Promise.all(items.map((job) => upsertJobFromSwarm(models, job)));
        return res.json({ ok: true, source: 'swarm', ...remote });
      } catch (error) {
        if (String(req.query.fallbackCache || 'true').toLowerCase() === 'false') throw error;
        const cache = await listLocalJobs(models, req.query);
        return res.status(206).json({ ok: true, source: 'cache', warning: 'Swarm unavailable; returned backend cache.', error: summarizeError(error), ...cache });
      }
    }

    const cache = await listLocalJobs(models, req.query);
    res.json({ ok: true, source: 'cache', ...cache });
  }));

  app.get('/api/admin/swarm/jobs/:jobId', verifyAdminToken, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    let remoteError = null;
    if (config.enabled && String(req.query.source || '').toLowerCase() !== 'cache') {
      try {
        const remote = await callSwarm(config, axios, crypto, 'GET', `/internal/v1/jobs/${encodeURIComponent(req.params.jobId)}`);
        const swarmJob = remote.job || remote.data?.job || remote;
        await upsertJobFromSwarm(models, swarmJob);
      } catch (error) {
        remoteError = summarizeError(error);
      }
    }

    const local = await models.SwarmBackendJob.findOne({ jobId: req.params.jobId }).lean();
    if (!local && remoteError) {
      return res.status(502).json({ ok: false, code: 'SWARM_JOB_LOOKUP_FAILED', error: remoteError });
    }
    if (!local) return res.status(404).json({ ok: false, code: 'SWARM_JOB_NOT_FOUND', message: 'Job not found.' });
    res.json({ ok: true, job: serializeLocalJob(local), remoteError });
  }));

  app.post('/api/admin/swarm/jobs/:jobId/cancel', verifyAdminToken, requireSwarmEnabled, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    const payload = { reason: String(req.body?.reason || 'admin-cancel-requested') };
    const result = await callSwarm(config, axios, crypto, 'POST', `/internal/v1/jobs/${encodeURIComponent(req.params.jobId)}/cancel`, payload);
    const swarmJob = result.job || result.data?.job || result;
    await upsertJobFromSwarm(models, swarmJob, { reviewedBy: adminActor(req.admin) });
    res.json({ ok: true, job: swarmJob, swarm: sanitizeSwarmEnvelope(result) });
  }));

  app.post('/api/admin/swarm/jobs/:jobId/retry', verifyAdminToken, requireSwarmEnabled, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    const payload = { reason: String(req.body?.reason || 'admin-retry-requested') };
    const result = await callSwarm(config, axios, crypto, 'POST', `/internal/v1/jobs/${encodeURIComponent(req.params.jobId)}/retry`, payload);
    const swarmJob = result.job || result.data?.job || result;
    await upsertJobFromSwarm(models, swarmJob, { reviewedBy: adminActor(req.admin) });
    res.json({ ok: true, job: swarmJob, swarm: sanitizeSwarmEnvelope(result) });
  }));

  app.get('/api/admin/swarm/artifacts', verifyAdminToken, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    const useCacheOnly = String(req.query.source || '').toLowerCase() === 'cache' || !config.enabled;
    if (!useCacheOnly) {
      try {
        const remote = await callSwarm(config, axios, crypto, 'GET', '/internal/v1/artifacts', undefined, pickQuery(req.query, ['vertical', 'artifactType', 'reviewStatus', 'page', 'limit']));
        const items = Array.isArray(remote.items) ? remote.items : [];
        await Promise.all(items.map((artifact) => upsertArtifactFromSwarm(models, artifact)));
        return res.json({ ok: true, source: 'swarm', ...remote });
      } catch (error) {
        if (String(req.query.fallbackCache || 'true').toLowerCase() === 'false') throw error;
        const cache = await listLocalArtifacts(models, req.query);
        return res.status(206).json({ ok: true, source: 'cache', warning: 'Swarm unavailable; returned backend cache.', error: summarizeError(error), ...cache });
      }
    }

    const cache = await listLocalArtifacts(models, req.query);
    res.json({ ok: true, source: 'cache', ...cache });
  }));

  app.get('/api/admin/swarm/artifacts/:artifactId', verifyAdminToken, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    let remoteError = null;
    if (config.enabled && String(req.query.source || '').toLowerCase() !== 'cache') {
      try {
        const remote = await callSwarm(config, axios, crypto, 'GET', `/internal/v1/artifacts/${encodeURIComponent(req.params.artifactId)}`);
        const swarmArtifact = remote.artifact || remote.data?.artifact || remote;
        await upsertArtifactFromSwarm(models, swarmArtifact);
      } catch (error) {
        remoteError = summarizeError(error);
      }
    }

    const local = await models.SwarmBackendArtifact.findOne({ artifactId: req.params.artifactId }).lean();
    if (!local && remoteError) {
      return res.status(502).json({ ok: false, code: 'SWARM_ARTIFACT_LOOKUP_FAILED', error: remoteError });
    }
    if (!local) return res.status(404).json({ ok: false, code: 'SWARM_ARTIFACT_NOT_FOUND', message: 'Artifact not found.' });
    res.json({ ok: true, artifact: serializeLocalArtifact(local), remoteError });
  }));

  app.post('/api/admin/swarm/artifacts/:artifactId/approve', verifyAdminToken, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    const artifact = await loadArtifactForReview({ config, axios, crypto, models, artifactId: req.params.artifactId });
    const admin = adminActor(req.admin);
    const publish = req.body?.publish !== false;

    let remoteReview = null;
    if (config.enabled) {
      remoteReview = await reviewRemoteArtifact({ config, axios, crypto, artifactId: req.params.artifactId, reviewStatus: 'APPROVED', reviewedBy: admin, reason: req.body?.reason });
      const reviewedArtifact = remoteReview.artifact || remoteReview.data?.artifact;
      if (reviewedArtifact) await upsertArtifactFromSwarm(models, reviewedArtifact);
    }

    const latest = await models.SwarmBackendArtifact.findOne({ artifactId: req.params.artifactId }) || artifact;
    latest.reviewStatus = 'APPROVED';
    latest.reviewedBy = admin;
    latest.reviewedAt = new Date();
    latest.reviewReason = req.body?.reason;

    let published = null;
    let automationEvent = null;
    if (publish && isBlogArtifact(latest)) {
      published = await publishBlogArtifact({ artifact: latest, Blog, Notification, admin, mongoose, publishOptions: { updateExisting: req.body?.updateExisting === true } });
      latest.reviewStatus = 'PUBLISHED';
      latest.publishedEntity = published.entity;
      latest.publishedAt = new Date();
      await models.SwarmBackendJob.updateOne(
        { jobId: latest.jobId },
        { $set: { status: 'published', artifactId: latest.artifactId, publishedEntity: published.entity, updatedAt: new Date() }, $push: { statusHistory: { status: 'published', at: new Date(), reason: 'artifact-approved-and-published' } } },
      );

      if (published?.entity?.id) {
        try {
          automationEvent = await triggerAutomationEvent({
            config,
            axios,
            crypto,
            mongoose,
            models,
            admin: req.admin,
            trigger: 'blog_approved',
            vertical: latest.vertical || 'combat',
            sourceEntity: { type: 'blog', id: published.entity.id, label: published.entity.metaTitle || latest.title },
            input: {
              blogId: published.entity.id,
              blogTitle: published.entity.metaTitle || latest.title,
              artifactId: latest.artifactId,
              originalJobType: latest.jobType,
              publishAction: published.action,
            },
            metadata: { artifactId: latest.artifactId, submittedFrom: 'artifact-approval' },
            reason: 'blog-approved-after-swarm-artifact-publication',
          });
        } catch (error) {
          automationEvent = { ok: false, warning: 'Blog was published but follow-up blog_approved automations were not submitted.', error: summarizeError(error) };
        }
      }
    }

    await latest.save();
    res.json({ ok: true, artifact: serializeLocalArtifact(latest), published, automationEvent, remoteReview: sanitizeSwarmEnvelope(remoteReview) });
  }));

  app.post('/api/admin/swarm/artifacts/:artifactId/reject', verifyAdminToken, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    const artifact = await loadArtifactForReview({ config, axios, crypto, models, artifactId: req.params.artifactId });
    const admin = adminActor(req.admin);
    let remoteReview = null;
    if (config.enabled) {
      remoteReview = await reviewRemoteArtifact({ config, axios, crypto, artifactId: req.params.artifactId, reviewStatus: 'REJECTED', reviewedBy: admin, reason: req.body?.reason });
    }

    artifact.reviewStatus = 'REJECTED';
    artifact.reviewedBy = admin;
    artifact.reviewedAt = new Date();
    artifact.reviewReason = req.body?.reason;
    await artifact.save();
    await models.SwarmBackendJob.updateOne(
      { jobId: artifact.jobId },
      { $set: { status: 'rejected', updatedAt: new Date() }, $push: { statusHistory: { status: 'rejected', at: new Date(), reason: 'artifact-rejected' } } },
    );

    res.json({ ok: true, artifact: serializeLocalArtifact(artifact), remoteReview: sanitizeSwarmEnvelope(remoteReview) });
  }));

  app.post('/api/admin/swarm/artifacts/:artifactId/regenerate', verifyAdminToken, requireSwarmEnabled, asyncHandler(async (req, res) => {
    const artifact = await loadArtifactForReview({ config: getSwarmConfig(), axios, crypto, models, artifactId: req.params.artifactId });
    const linkedJob = await models.SwarmBackendJob.findOne({ jobId: artifact.jobId }).lean();
    if (!linkedJob) return res.status(404).json({ ok: false, code: 'SOURCE_JOB_NOT_FOUND', message: 'Source job was not found in backend cache.' });

    req.body = {
      vertical: linkedJob.vertical,
      jobType: linkedJob.jobType,
      mode: linkedJob.mode || 'DRAFT_ONLY',
      priority: linkedJob.priority || 50,
      sourceEntity: linkedJob.sourceEntity,
      input: { ...(linkedJob.input || {}), regenerateFromArtifactId: artifact.artifactId, regenerateReason: req.body?.reason || 'admin-regenerate' },
      metadata: { ...(linkedJob.metadata || {}), regeneratedFromJobId: linkedJob.jobId, regeneratedFromArtifactId: artifact.artifactId },
    };

    const config = getSwarmConfig();
    const normalized = normalizeCreateJobBody(req.body, req.admin, config, mongoose);
    const localId = new mongoose.Types.ObjectId();
    const backendCorrelationId = String(localId);
    const idempotencyKey = createIdempotencyKey({ crypto, normalized, backendCorrelationId });
    const localJob = await models.SwarmBackendJob.create({
      _id: localId,
      backendCorrelationId,
      idempotencyKey,
      vertical: normalized.vertical,
      jobType: normalized.jobType,
      mode: normalized.mode,
      priority: normalized.priority,
      status: 'submitting',
      requestedBy: normalized.requestedBy,
      sourceEntity: normalized.sourceEntity,
      input: normalized.input,
      metadata: normalized.metadata,
      statusHistory: [{ status: 'submitting', at: new Date(), reason: 'artifact-regenerate-submit-started' }],
    });

    try {
      const result = await callSwarm(config, axios, crypto, 'POST', '/internal/v1/jobs', { ...normalized, idempotencyKey, backendCorrelationId });
      const swarmJob = result.job || result.data?.job || result;
      await upsertJobFromSwarm(models, swarmJob, { localId, idempotencyKey, backendCorrelationId, requestedBy: normalized.requestedBy, sourceEntity: normalized.sourceEntity, input: normalized.input, metadata: normalized.metadata });
      const updated = await models.SwarmBackendJob.findById(localId).lean();
      return res.status(202).json({ ok: true, job: serializeLocalJob(updated), swarm: sanitizeSwarmEnvelope(result) });
    } catch (error) {
      localJob.status = 'failed_to_submit';
      localJob.error = summarizeError(error);
      localJob.statusHistory.push({ status: 'failed_to_submit', at: new Date(), reason: 'regenerate-submit-failed' });
      await localJob.save();
      return res.status(error.httpStatus || 502).json({ ok: false, code: 'SWARM_REGENERATE_FAILED', error: summarizeError(error), localJob: serializeLocalJob(localJob) });
    }
  }));

  app.post('/api/internal/swarm/webhooks/job-completed', asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    await verifyWebhookRequest({ req, models, crypto, config });
    const event = req.body || {};
    if (event.event && event.event !== 'swarm.job.completed') {
      return res.status(400).json({ ok: false, code: 'INVALID_SWARM_EVENT', message: 'Unsupported webhook event.' });
    }

    let artifactSnapshot = null;
    if (event.artifactId && config.enabled) {
      try {
        const remote = await callSwarm(config, axios, crypto, 'GET', `/internal/v1/artifacts/${encodeURIComponent(event.artifactId)}`);
        artifactSnapshot = remote.artifact || remote.data?.artifact || remote;
        await upsertArtifactFromSwarm(models, artifactSnapshot);
      } catch (error) {
        artifactSnapshot = { artifactId: event.artifactId, fetchError: summarizeError(error) };
      }
    }

    await models.SwarmBackendJob.updateOne(
      buildWebhookJobFilter(event),
      {
        $set: {
          jobId: event.jobId,
          backendCorrelationId: event.backendCorrelationId,
          artifactId: event.artifactId,
          vertical: event.vertical,
          jobType: event.jobType,
          status: 'awaiting_review',
          completedAt: event.completedAt ? new Date(event.completedAt) : new Date(),
          swarmJob: event,
          updatedAt: new Date(),
        },
        $push: { statusHistory: { status: 'awaiting_review', at: new Date(), reason: 'swarm-completed-webhook' } },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );

    res.json({ ok: true, received: true, artifactCached: Boolean(artifactSnapshot && !artifactSnapshot.fetchError) });
  }));

  app.post('/api/internal/swarm/webhooks/job-failed', asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    await verifyWebhookRequest({ req, models, crypto, config });
    const event = req.body || {};
    if (event.event && event.event !== 'swarm.job.failed') {
      return res.status(400).json({ ok: false, code: 'INVALID_SWARM_EVENT', message: 'Unsupported webhook event.' });
    }

    await models.SwarmBackendJob.updateOne(
      buildWebhookJobFilter(event),
      {
        $set: {
          jobId: event.jobId,
          backendCorrelationId: event.backendCorrelationId,
          vertical: event.vertical,
          jobType: event.jobType,
          status: event.status || 'failed',
          error: event.error || { message: 'Swarm job failed.' },
          completedAt: event.failedAt ? new Date(event.failedAt) : new Date(),
          swarmJob: event,
          updatedAt: new Date(),
        },
        $push: { statusHistory: { status: event.status || 'failed', at: new Date(), reason: 'swarm-failed-webhook' } },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );

    res.json({ ok: true, received: true });
  }));

  app.use((err, req, res, next) => {
    if (!req.path || !req.path.includes('/swarm')) return next(err);
    const status = err.status || err.httpStatus || 500;
    return res.status(status).json({
      ok: false,
      code: err.code || 'SWARM_BACKEND_ERROR',
      message: err.message || 'Swarm backend integration failed.',
      details: err.details,
    });
  });
}

function buildSwarmModels(mongoose) {
  const Mixed = mongoose.Schema.Types.Mixed;

  const jobSchema = new mongoose.Schema({
    jobId: { type: String, index: true, unique: true, sparse: true },
    backendCorrelationId: { type: String, index: true },
    idempotencyKey: { type: String, index: true, unique: true, sparse: true },
    vertical: { type: String, index: true },
    jobType: { type: String, index: true },
    mode: String,
    status: { type: String, index: true },
    priority: Number,
    requestedBy: Mixed,
    sourceEntity: Mixed,
    input: Mixed,
    artifactId: { type: String, index: true },
    artifact: Mixed,
    swarmJob: Mixed,
    metadata: Mixed,
    error: Mixed,
    publishedEntity: Mixed,
    scheduledAt: Date,
    startedAt: Date,
    completedAt: Date,
    statusHistory: [{ status: String, at: Date, reason: String }],
  }, { timestamps: true, minimize: false });

  const artifactSchema = new mongoose.Schema({
    artifactId: { type: String, index: true, unique: true, required: true },
    jobId: { type: String, index: true },
    vertical: { type: String, index: true },
    jobType: { type: String, index: true },
    artifactType: { type: String, index: true },
    title: String,
    summary: String,
    reviewStatus: { type: String, index: true },
    payload: Mixed,
    provenance: Mixed,
    quality: Mixed,
    swarmArtifact: Mixed,
    reviewedBy: Mixed,
    reviewedAt: Date,
    reviewReason: String,
    publishedEntity: Mixed,
    publishedAt: Date,
    metadata: Mixed,
  }, { timestamps: true, minimize: false });

  const automationEventSchema = new mongoose.Schema({
    eventId: { type: String, index: true, unique: true, required: true },
    trigger: { type: String, index: true, required: true },
    vertical: { type: String, index: true },
    status: { type: String, index: true },
    requestedBy: Mixed,
    sourceEntity: Mixed,
    input: Mixed,
    metadata: Mixed,
    selectedJobTypes: [String],
    createdJobs: [Mixed],
    skippedJobs: [Mixed],
    errors: [Mixed],
    reason: String,
    completedAt: Date,
  }, { timestamps: true, minimize: false });

  const nonceSchema = new mongoose.Schema({
    keyId: { type: String, required: true },
    nonce: { type: String, required: true },
    expiresAt: { type: Date, required: true, expires: 0 },
  }, { timestamps: true });
  nonceSchema.index({ keyId: 1, nonce: 1 }, { unique: true });

  return {
    SwarmBackendJob: mongoose.models.SwarmBackendJob || mongoose.model('SwarmBackendJob', jobSchema, 'swarm_backend_jobs'),
    SwarmBackendArtifact: mongoose.models.SwarmBackendArtifact || mongoose.model('SwarmBackendArtifact', artifactSchema, 'swarm_backend_artifacts'),
    SwarmBackendAutomationEvent: mongoose.models.SwarmBackendAutomationEvent || mongoose.model('SwarmBackendAutomationEvent', automationEventSchema, 'swarm_backend_automation_events'),
    SwarmBackendWebhookNonce: mongoose.models.SwarmBackendWebhookNonce || mongoose.model('SwarmBackendWebhookNonce', nonceSchema, 'swarm_backend_webhook_nonces'),
  };
}

function getSwarmConfig() {
  const baseUrl = stripTrailingSlash(process.env.SWARM_BASE_URL || process.env.IONOS_SWARM_URL || '');
  const enabledFromEnv = String(process.env.SWARM_ENABLED || (baseUrl ? 'true' : 'false')).toLowerCase() !== 'false';
  return {
    enabled: enabledFromEnv && Boolean(baseUrl),
    baseUrl,
    timeoutMs: toInt(process.env.SWARM_REQUEST_TIMEOUT_MS, 45000),
    apiKey: cleanString(process.env.SWARM_API_KEY),
    hmacKeyId: cleanString(process.env.SWARM_HMAC_KEY_ID) || 'swarm-v1',
    hmacSecret: cleanString(process.env.SWARM_HMAC_SECRET),
    callbackKeyId: cleanString(process.env.BACKEND_HMAC_KEY_ID) || 'backend-v1',
    callbackSecret: cleanString(process.env.BACKEND_HMAC_SECRET) || cleanString(process.env.SWARM_CALLBACK_HMAC_SECRET) || cleanString(process.env.SWARM_HMAC_SECRET),
    webhookRequireHmac: String(process.env.SWARM_WEBHOOK_REQUIRE_HMAC || 'true').toLowerCase() !== 'false',
    hmacMaxSkewSeconds: toInt(process.env.SWARM_HMAC_MAX_SKEW_SECONDS, 300),
    defaultMode: cleanString(process.env.SWARM_DEFAULT_MODE) || 'DRAFT_ONLY',
    autoPublishEnabled: String(process.env.SWARM_AUTO_PUBLISH_ENABLED || 'false').toLowerCase() === 'true',
    autoImportEnabled: String(process.env.SWARM_AUTO_IMPORT_ENABLED || 'false').toLowerCase() === 'true',
    socialPublishEnabled: String(process.env.SWARM_SOCIAL_PUBLISH_ENABLED || 'false').toLowerCase() === 'true',
    automationEventHooksEnabled: String(process.env.SWARM_AUTOMATION_EVENT_HOOKS_ENABLED || 'true').toLowerCase() !== 'false',
  };
}

async function callSwarm(config, axios, crypto, method, path, body, query) {
  if (!config.enabled) {
    const error = new Error('Swarm is not configured.');
    error.httpStatus = 503;
    error.code = 'SWARM_DISABLED';
    throw error;
  }

  const url = new URL(path, `${config.baseUrl}/`);
  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    });
  }

  const hasBody = body !== undefined && body !== null && !['GET', 'HEAD'].includes(String(method).toUpperCase());
  const serializedBody = hasBody ? JSON.stringify(body) : '';
  const headers = {
    Accept: 'application/json',
  };
  if (hasBody) headers['Content-Type'] = 'application/json';
  if (config.apiKey) headers['x-swarm-api-key'] = config.apiKey;
  if (config.hmacSecret) {
    const timestamp = new Date().toISOString();
    const nonce = crypto.randomBytes(24).toString('base64url');
    headers['x-swarm-key-id'] = config.hmacKeyId;
    headers['x-swarm-timestamp'] = timestamp;
    headers['x-swarm-nonce'] = nonce;
    headers['x-swarm-signature'] = signRequest({
      crypto,
      method,
      pathWithQuery: `${url.pathname}${url.search}`,
      timestamp,
      nonce,
      body: serializedBody,
      secret: config.hmacSecret,
    });
  }

  const response = await axios({
    method,
    url: url.toString(),
    data: hasBody ? serializedBody : undefined,
    headers,
    timeout: config.timeoutMs,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    const error = new Error(`Swarm responded with HTTP ${response.status}.`);
    error.httpStatus = response.status === 401 || response.status === 403 ? 502 : response.status;
    error.code = 'SWARM_HTTP_ERROR';
    error.details = {
      status: response.status,
      body: typeof response.data === 'string' ? response.data.slice(0, 1000) : response.data,
    };
    throw error;
  }

  return response.data;
}

function normalizeCreateJobBody(body, admin, config) {
  const raw = body || {};
  const vertical = normalizeVertical(raw.vertical || raw.gameMode || raw.domain);
  if (!DEFAULT_VERTICALS.has(vertical)) throw httpError(400, 'INVALID_SWARM_VERTICAL', 'vertical must be combat or pro_wrestling.');

  const jobType = String(raw.jobType || inferJobType(raw, vertical)).trim();
  if (!DEFAULT_JOB_TYPES.has(jobType)) throw httpError(400, 'INVALID_SWARM_JOB_TYPE', 'Unsupported swarm jobType.');

  const mode = normalizeMode(raw.mode || raw.statusMode || raw.publishMode || config.defaultMode || 'DRAFT_ONLY');
  if (!DEFAULT_MODES.has(mode)) throw httpError(400, 'INVALID_SWARM_MODE', 'Unsupported swarm mode.');

  const priority = clamp(toInt(raw.priority, 50), 0, 100);
  const input = normalizeInput(raw);
  const sourceEntity = normalizeSourceEntity(raw, input, vertical, jobType);

  return {
    vertical,
    jobType,
    mode,
    priority,
    idempotencyKey: raw.idempotencyKey ? String(raw.idempotencyKey).slice(0, 200) : undefined,
    requestedBy: {
      id: admin?.id ? String(admin.id) : undefined,
      email: admin?.email ? String(admin.email) : undefined,
      role: 'admin',
      source: 'backend',
    },
    sourceEntity,
    input,
    scheduledAt: raw.scheduledAt,
    maxAttempts: raw.maxAttempts,
    metadata: {
      ...(isPlainObject(raw.metadata) ? raw.metadata : {}),
      submittedFrom: 'fantasymmadness-backend',
      submittedAt: new Date().toISOString(),
    },
  };
}

function normalizeMode(value) {
  const raw = cleanString(value) || 'DRAFT_ONLY';
  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliases = {
    dry: 'DRY_RUN',
    dry_run: 'DRY_RUN',
    dryrun: 'DRY_RUN',
    test: 'DRY_RUN',
    shadow: 'SHADOW',
    draft: 'DRAFT_ONLY',
    drafts: 'DRAFT_ONLY',
    draft_only: 'DRAFT_ONLY',
    draftonly: 'DRAFT_ONLY',
    draft_mode: 'DRAFT_ONLY',
    approval: 'APPROVAL_REQUIRED',
    approve: 'APPROVAL_REQUIRED',
    approval_required: 'APPROVAL_REQUIRED',
    review: 'APPROVAL_REQUIRED',
    review_required: 'APPROVAL_REQUIRED',
    awaiting_review: 'APPROVAL_REQUIRED',
    auto: 'AUTOMATED',
    automated: 'AUTOMATED',
    automation: 'AUTOMATED',
    publish: 'AUTOMATED',
    auto_publish: 'AUTOMATED',
  };
  return aliases[normalized] || raw.trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function normalizeSourceEntity(raw, input, vertical, jobType) {
  const provided = isPlainObject(raw.sourceEntity) ? raw.sourceEntity : {};
  const hasMeaningfulProvidedValue = Object.values(provided).some((value) => {
    if (value === undefined || value === null) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    return true;
  });

  if (hasMeaningfulProvidedValue) {
    return {
      ...provided,
      type: cleanString(provided.type) || inferSourceEntityType(input, vertical, jobType),
      label: cleanString(provided.label) || buildSourceEntityLabel(input, raw, vertical, jobType),
    };
  }

  const id = cleanString(input.matchId || input.fightId || input.eventId || input.wrestlerId || input.fighterId || raw.matchId || raw.fightId || raw.eventId || raw.wrestlerId || raw.fighterId);
  return {
    type: inferSourceEntityType(input, vertical, jobType),
    id: id || undefined,
    label: buildSourceEntityLabel(input, raw, vertical, jobType),
    origin: 'backend_default',
  };
}

function inferSourceEntityType(input, vertical, jobType) {
  if (cleanString(input.matchId)) return vertical === 'pro_wrestling' ? 'pro_wrestling_match' : 'combat_match';
  if (cleanString(input.fightId)) return 'combat_fight';
  if (cleanString(input.eventId)) return vertical === 'pro_wrestling' ? 'pro_wrestling_event' : 'combat_event';
  if (cleanString(input.wrestlerId)) return 'pro_wrestling_wrestler';
  if (cleanString(input.fighterId)) return 'combat_fighter';
  if (jobType.startsWith('seo.')) return 'seo_request';
  if (jobType.startsWith('social.')) return 'social_request';
  if (jobType.startsWith('data.')) return 'data_request';
  return 'manual_prompt';
}

function buildSourceEntityLabel(input, raw, vertical, jobType) {
  const label = cleanString(raw.label)
    || cleanString(input.title)
    || cleanString(input.topic)
    || cleanString(input.prompt)
    || cleanString(input.eventName)
    || cleanString(input.wrestlerName)
    || cleanString(input.fighterName);
  if (label) return label.slice(0, 180);
  return `${vertical}:${jobType}`;
}

function inferJobType(raw, vertical) {
  const type = String(raw.type || raw.intent || '').toLowerCase();
  if (vertical === 'pro_wrestling') {
    if (type.includes('score')) return 'wrestling.scorecard-suggestion';
    if (type.includes('profile') || raw.wrestlerId || raw.wrestlerName) return 'wrestling.wrestler-profile';
    if (type.includes('analysis')) return 'wrestling.match-analysis';
  }
  if (type.includes('seo')) return 'seo.audit';
  if (type.includes('social')) return 'social.draft';
  if (type.includes('data') || type.includes('candidate')) return 'data.external-candidate';
  if (type.includes('recap')) return 'content.event-recap';
  if (type.includes('preview')) return 'content.match-preview';
  return 'content.article';
}

function normalizeInput(raw) {
  if (isPlainObject(raw.input)) return raw.input;
  const input = {};
  ['topic', 'title', 'prompt', 'keywords', 'fighters', 'wrestlers', 'eventName', 'matchId', 'fighterA', 'fighterB', 'competitorA', 'competitorB', 'platforms'].forEach((key) => {
    if (raw[key] !== undefined) input[key] = raw[key];
  });
  if (!Object.keys(input).length && raw.topicText) input.topic = raw.topicText;
  return input;
}

async function upsertJobFromSwarm(models, swarmJob, fallback) {
  if (!swarmJob || !swarmJob.jobId) return null;
  const set = {
    jobId: swarmJob.jobId,
    backendCorrelationId: swarmJob.backendCorrelationId || fallback?.backendCorrelationId,
    idempotencyKey: swarmJob.idempotencyKey || fallback?.idempotencyKey,
    vertical: swarmJob.vertical || fallback?.vertical,
    jobType: swarmJob.jobType || fallback?.jobType,
    mode: swarmJob.mode || fallback?.mode,
    status: swarmJob.status || fallback?.status || 'unknown',
    priority: swarmJob.priority ?? fallback?.priority,
    requestedBy: swarmJob.requestedBy || fallback?.requestedBy,
    sourceEntity: swarmJob.sourceEntity || fallback?.sourceEntity,
    input: swarmJob.input || fallback?.input,
    artifactId: swarmJob.artifactId || fallback?.artifactId,
    swarmJob,
    metadata: swarmJob.metadata || fallback?.metadata,
    error: swarmJob.error || fallback?.error,
    scheduledAt: toDateOrUndefined(swarmJob.scheduledAt),
    startedAt: toDateOrUndefined(swarmJob.startedAt),
    completedAt: toDateOrUndefined(swarmJob.completedAt),
    updatedAt: new Date(),
  };
  Object.keys(set).forEach((key) => set[key] === undefined && delete set[key]);

  const filter = fallback?.localId ? { _id: fallback.localId } : { jobId: swarmJob.jobId };
  await models.SwarmBackendJob.updateOne(filter, {
    $set: set,
    $setOnInsert: { createdAt: new Date() },
    $push: { statusHistory: { status: set.status, at: new Date(), reason: 'swarm-sync' } },
  }, { upsert: true });
  return models.SwarmBackendJob.findOne({ jobId: swarmJob.jobId });
}

async function upsertArtifactFromSwarm(models, swarmArtifact) {
  if (!swarmArtifact || !swarmArtifact.artifactId) return null;
  const set = {
    artifactId: swarmArtifact.artifactId,
    jobId: swarmArtifact.jobId,
    vertical: swarmArtifact.vertical,
    jobType: swarmArtifact.jobType,
    artifactType: swarmArtifact.artifactType,
    title: swarmArtifact.title,
    summary: swarmArtifact.summary,
    reviewStatus: swarmArtifact.reviewStatus || 'AWAITING_REVIEW',
    payload: swarmArtifact.payload || {},
    provenance: swarmArtifact.provenance || {},
    quality: swarmArtifact.quality || {},
    reviewedBy: swarmArtifact.reviewedBy,
    reviewedAt: toDateOrUndefined(swarmArtifact.reviewedAt),
    reviewReason: swarmArtifact.reviewReason,
    metadata: swarmArtifact.metadata || {},
    swarmArtifact,
    updatedAt: new Date(),
  };
  Object.keys(set).forEach((key) => set[key] === undefined && delete set[key]);
  await models.SwarmBackendArtifact.updateOne({ artifactId: swarmArtifact.artifactId }, { $set: set, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
  return models.SwarmBackendArtifact.findOne({ artifactId: swarmArtifact.artifactId });
}

async function loadArtifactForReview({ config, axios, crypto, models, artifactId }) {
  if (config.enabled) {
    try {
      const remote = await callSwarm(config, axios, crypto, 'GET', `/internal/v1/artifacts/${encodeURIComponent(artifactId)}`);
      const artifact = remote.artifact || remote.data?.artifact || remote;
      await upsertArtifactFromSwarm(models, artifact);
    } catch (error) {
      const cached = await models.SwarmBackendArtifact.findOne({ artifactId });
      if (!cached) throw error;
    }
  }
  const artifact = await models.SwarmBackendArtifact.findOne({ artifactId });
  if (!artifact) throw httpError(404, 'SWARM_ARTIFACT_NOT_FOUND', 'Artifact not found.');
  return artifact;
}

async function reviewRemoteArtifact({ config, axios, crypto, artifactId, reviewStatus, reviewedBy, reason }) {
  if (!REVIEW_STATUSES.has(reviewStatus)) throw httpError(400, 'INVALID_REVIEW_STATUS', 'Invalid review status.');
  return callSwarm(config, axios, crypto, 'POST', `/internal/v1/artifacts/${encodeURIComponent(artifactId)}/review`, {
    reviewStatus,
    reviewedBy,
    reason,
  });
}

function isBlogArtifact(artifact) {
  const type = String(artifact.artifactType || '');
  const jobType = String(artifact.jobType || '');
  if (type.startsWith('content.') && type.endsWith('-draft')) return true;
  return jobType.startsWith('content.') && !jobType.includes('image-prompt');
}

async function publishBlogArtifact({ artifact, Blog, Notification, admin, publishOptions }) {
  if (!Blog) throw httpError(500, 'BLOG_MODEL_UNAVAILABLE', 'Blog model is not available for publishing.');
  if (artifact.publishedEntity?.id) {
    return { action: 'already_published', entity: artifact.publishedEntity };
  }

  const payload = artifact.payload || {};
  const blogData = mapArtifactToBlog(payload, artifact);
  if (!blogData.metaTitle || !blogData.header) {
    throw httpError(400, 'INVALID_BLOG_ARTIFACT', 'Content artifact does not contain enough data to publish a blog.');
  }

  const targetBlogId = cleanString(payload.targetBlogId || payload.blogId || artifact.sourceEntity?.id);
  const targetBlog = targetBlogId ? await Blog.findById(targetBlogId).catch(() => null) : null;
  const existing = targetBlog || await Blog.findOne({ metaTitle: blogData.metaTitle });
  if (existing) {
    if (publishOptions?.updateExisting === true || artifact.jobType === 'content.old-blog-refresh' || payload.updateExisting === true) {
      existing.metaTitle = blogData.metaTitle || existing.metaTitle;
      existing.metaDescription = blogData.metaDescription || existing.metaDescription;
      existing.header = blogData.header || existing.header;
      if (blogData.blogHeaderImage) existing.blogHeaderImage = blogData.blogHeaderImage;
      if (blogData.blogHeaderImagePublicId) existing.blogHeaderImagePublicId = blogData.blogHeaderImagePublicId;
      if (blogData.sections && blogData.sections.length) existing.sections = blogData.sections;
      await existing.save();
      const entity = { type: 'Blog', id: String(existing._id), updatedExisting: true, metaTitle: existing.metaTitle };
      return { action: 'updated_existing_blog', entity };
    }
    const entity = { type: 'Blog', id: String(existing._id), reusedExisting: true, metaTitle: existing.metaTitle };
    return { action: 'attached_existing_blog', entity };
  }

  const blog = new Blog(blogData);
  await blog.save();

  if (Notification) {
    try {
      await new Notification({ title: `Blog Added: ${blog.metaTitle}` }).save();
    } catch (error) {
      // Non-critical: publishing should not fail because notification creation failed.
    }
  }

  return {
    action: 'published_blog',
    entity: {
      type: 'Blog',
      id: String(blog._id),
      metaTitle: blog.metaTitle,
      createdBy: admin,
    },
  };
}

function mapArtifactToBlog(payload, artifact) {
  const sections = Array.isArray(payload.sections) ? payload.sections : buildSectionsFromBody(payload.body || payload.content || artifact.summary);
  return {
    metaTitle: cleanString(payload.metaTitle) || cleanString(payload.seoTitle) || cleanString(payload.title) || cleanString(artifact.title),
    metaDescription: cleanString(payload.metaDescription) || cleanString(payload.description) || cleanString(artifact.summary) || '',
    header: cleanString(payload.header) || cleanString(payload.title) || cleanString(artifact.title),
    blogHeaderImage: cleanString(payload.blogHeaderImage) || cleanString(payload.image) || '',
    blogHeaderImagePublicId: cleanString(payload.blogHeaderImagePublicId) || '',
    sections: normalizeBlogSections(sections),
  };
}

function buildSectionsFromBody(body) {
  const text = cleanString(body);
  if (!text) return [];
  return [{ title: 'Overview', content: text, headings: [] }];
}

function normalizeBlogSections(sections) {
  return (Array.isArray(sections) ? sections : [])
    .map((section, index) => ({
      title: cleanString(section?.title) || `Section ${index + 1}`,
      content: cleanString(section?.content || section?.body || section?.text) || '',
      image: cleanString(section?.image) || '',
      imagePublicId: cleanString(section?.imagePublicId) || '',
      headings: Array.isArray(section?.headings) ? section.headings.map((heading) => ({
        title: cleanString(heading?.title) || '',
        content: cleanString(heading?.content || heading?.body || heading?.text) || '',
      })).filter((heading) => heading.title || heading.content) : [],
    }))
    .filter((section) => section.title || section.content);
}

async function listLocalJobs(models, query) {
  const page = clamp(toInt(query.page, 1), 1, 100000);
  const limit = clamp(toInt(query.limit, 25), 1, 100);
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.vertical) filter.vertical = normalizeVertical(query.vertical);
  if (query.jobType) filter.jobType = query.jobType;
  const [rows, total] = await Promise.all([
    models.SwarmBackendJob.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    models.SwarmBackendJob.countDocuments(filter),
  ]);
  return { items: rows.map(serializeLocalJob), pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
}

async function listLocalArtifacts(models, query) {
  const page = clamp(toInt(query.page, 1), 1, 100000);
  const limit = clamp(toInt(query.limit, 25), 1, 100);
  const filter = {};
  if (query.vertical) filter.vertical = normalizeVertical(query.vertical);
  if (query.artifactType) filter.artifactType = query.artifactType;
  if (query.reviewStatus) filter.reviewStatus = String(query.reviewStatus).toUpperCase();
  const [rows, total] = await Promise.all([
    models.SwarmBackendArtifact.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    models.SwarmBackendArtifact.countDocuments(filter),
  ]);
  return { items: rows.map(serializeLocalArtifact), pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
}

async function getCacheStats(models) {
  const [jobs, artifacts, awaitingReview, failedJobs, automationEvents, failedAutomationEvents] = await Promise.all([
    models.SwarmBackendJob.countDocuments(),
    models.SwarmBackendArtifact.countDocuments(),
    models.SwarmBackendArtifact.countDocuments({ reviewStatus: { $in: ['DRAFT', 'AWAITING_REVIEW'] } }),
    models.SwarmBackendJob.countDocuments({ status: { $in: ['failed', 'dead_letter', 'failed_to_submit'] } }),
    models.SwarmBackendAutomationEvent.countDocuments(),
    models.SwarmBackendAutomationEvent.countDocuments({ status: 'failed' }),
  ]);
  return { jobs, artifacts, awaitingReview, failedJobs, automationEvents, failedAutomationEvents };
}

function buildLocalAutomationCatalog() {
  const catalog = {};
  for (const jobType of DEFAULT_JOB_TYPE_ARRAY) {
    const group = inferJobGroup(jobType);
    catalog[jobType] = {
      label: buildAutomationLabel(jobType),
      group,
      description: buildAutomationDescription(jobType),
      suggestedTriggers: Object.entries(AUTOMATION_TRIGGER_DEFAULTS)
        .filter(([, jobTypes]) => Array.isArray(jobTypes) && jobTypes.includes(jobType))
        .map(([trigger]) => trigger),
      defaultMode: 'DRAFT_ONLY',
      adminControls: inferAdminControls(jobType),
    };
  }
  return { catalog, groups: AUTOMATION_GROUPS, triggerMap: AUTOMATION_TRIGGER_DEFAULTS, jobTypes: DEFAULT_JOB_TYPE_ARRAY };
}

function buildDefaultAutomationSettings() {
  const automations = {};
  for (const jobType of DEFAULT_JOB_TYPE_ARRAY) {
    const catalog = buildLocalAutomationCatalog().catalog[jobType];
    automations[jobType] = {
      enabled: true,
      defaultMode: catalog.defaultMode || 'DRAFT_ONLY',
      requiresApproval: true,
      allowAutomatedExecution: false,
      allowAutoPublish: false,
      allowSocialPublish: false,
      priority: 50,
      maxAttempts: 3,
      triggers: catalog.suggestedTriggers.length ? catalog.suggestedTriggers : ['manual'],
      notes: catalog.description,
    };
  }
  return {
    settingsId: 'backend-fallback',
    global: {
      paused: false,
      approvalRequiredByDefault: true,
      socialPublishEnabled: false,
      autoPublishEnabled: false,
      autoImportEnabled: false,
      dailySchedulerEnabled: false,
      weeklySchedulerEnabled: false,
      maxDailyJobs: 50,
      defaultMode: 'DRAFT_ONLY',
    },
    automations,
  };
}

function normalizeSettingsUpdateBody(body, admin) {
  const raw = isPlainObject(body) ? body : {};
  return {
    global: isPlainObject(raw.global) ? raw.global : undefined,
    automations: isPlainObject(raw.automations) ? raw.automations : undefined,
    updatedBy: raw.updatedBy || adminActor(admin),
    reason: cleanString(raw.reason) || 'backend-admin-settings-update',
  };
}

async function triggerAutomationEvent({ config, axios, crypto, mongoose, models, admin, trigger, vertical, mode, sourceEntity, input, metadata, requestedJobTypes, reason }) {
  if (!config.enabled) throw httpError(503, 'SWARM_DISABLED', 'Swarm integration is disabled.');
  const normalizedTrigger = normalizeAutomationTrigger(trigger);
  const normalizedVertical = normalizeVertical(vertical || inferVerticalForTrigger(normalizedTrigger));
  if (!DEFAULT_VERTICALS.has(normalizedVertical)) throw httpError(400, 'INVALID_SWARM_VERTICAL', 'Automation event vertical must be combat or pro_wrestling.');

  if (metadata?.route && config.automationEventHooksEnabled === false) {
    return {
      eventId: null,
      trigger: normalizedTrigger,
      vertical: normalizedVertical,
      status: 'skipped',
      createdJobs: [],
      skippedJobs: [{ reason: 'backend-event-hooks-disabled' }],
      errors: [],
    };
  }

  const eventId = `event_${new mongoose.Types.ObjectId().toString()}`;
  const actor = adminActor(admin) || { source: 'backend' };
  const normalizedSourceEntity = normalizeEventSourceEntity(sourceEntity, input, normalizedVertical, normalizedTrigger);
  const eventDoc = await models.SwarmBackendAutomationEvent.create({
    eventId,
    trigger: normalizedTrigger,
    vertical: normalizedVertical,
    status: 'running',
    requestedBy: actor,
    sourceEntity: normalizedSourceEntity,
    input: input || {},
    metadata: metadata || {},
    selectedJobTypes: [],
    createdJobs: [],
    skippedJobs: [],
    errors: [],
    reason: cleanString(reason) || 'automation-event-triggered',
  });

  let settingsEnvelope;
  try {
    settingsEnvelope = await callSwarm(config, axios, crypto, 'GET', '/internal/v1/settings');
  } catch (error) {
    settingsEnvelope = { ok: false, settings: buildDefaultAutomationSettings(), fallbackReason: summarizeError(error) };
  }

  const settings = settingsEnvelope.settings || settingsEnvelope.data?.settings || buildDefaultAutomationSettings();
  const globalSettings = settings.global || {};
  if (globalSettings.paused) {
    eventDoc.status = 'skipped';
    eventDoc.skippedJobs.push({ reason: 'global-automation-paused' });
    eventDoc.completedAt = new Date();
    await eventDoc.save();
    return serializeAutomationEvent(eventDoc);
  }

  const candidateJobTypes = resolveEventJobTypes({ trigger: normalizedTrigger, settings, requestedJobTypes });
  const createdJobs = [];
  const skippedJobs = [];
  const errors = [];

  for (const jobType of candidateJobTypes) {
    if (!DEFAULT_JOB_TYPES.has(jobType)) {
      skippedJobs.push({ jobType, reason: 'unknown-job-type' });
      continue;
    }

    const control = settings.automations?.[jobType] || buildDefaultAutomationSettings().automations[jobType];
    if (!control?.enabled) {
      skippedJobs.push({ jobType, reason: 'automation-disabled' });
      continue;
    }

    const resolvedMode = resolveAutomationMode({ requestedMode: mode, control, config, globalSettings, jobType });
    const rawJob = {
      vertical: normalizedVertical,
      jobType,
      mode: resolvedMode,
      priority: control.priority ?? 50,
      maxAttempts: control.maxAttempts ?? 3,
      sourceEntity: normalizedSourceEntity,
      input: buildAutomationJobInput({ input, metadata, trigger: normalizedTrigger, eventId, jobType, vertical: normalizedVertical }),
      metadata: {
        ...(metadata || {}),
        automationEventId: eventId,
        automationTrigger: normalizedTrigger,
        automationJobType: jobType,
        submittedFrom: 'fantasymmadness-backend-automation-event',
      },
    };

    try {
      const normalized = normalizeCreateJobBody(rawJob, admin || actor, config, mongoose);
      const localId = new mongoose.Types.ObjectId();
      const backendCorrelationId = String(localId);
      const idempotencyKey = createAutomationIdempotencyKey({ crypto, eventId, jobType, normalized });
      const submitted = await submitNormalizedJobToSwarm({ config, axios, crypto, mongoose, models, normalized, localId, backendCorrelationId, idempotencyKey, submitReason: `automation-event:${normalizedTrigger}` });
      createdJobs.push({ jobType, mode: resolvedMode, job: serializeLocalJob(submitted.localJob), swarm: sanitizeSwarmEnvelope(submitted.swarmResult) });
    } catch (error) {
      errors.push({ jobType, error: summarizeError(error) });
    }
  }

  eventDoc.selectedJobTypes = candidateJobTypes;
  eventDoc.createdJobs = createdJobs;
  eventDoc.skippedJobs = skippedJobs;
  eventDoc.errors = errors;
  eventDoc.status = errors.length && !createdJobs.length ? 'failed' : (createdJobs.length ? 'submitted' : 'skipped');
  eventDoc.completedAt = new Date();
  await eventDoc.save();
  return serializeAutomationEvent(eventDoc);
}

async function submitNormalizedJobToSwarm({ config, axios, crypto, mongoose, models, normalized, localId, backendCorrelationId, idempotencyKey, submitReason }) {
  const localJob = await models.SwarmBackendJob.create({
    _id: localId,
    backendCorrelationId,
    idempotencyKey,
    vertical: normalized.vertical,
    jobType: normalized.jobType,
    mode: normalized.mode,
    priority: normalized.priority,
    status: 'submitting',
    requestedBy: normalized.requestedBy,
    sourceEntity: normalized.sourceEntity,
    input: normalized.input,
    metadata: normalized.metadata,
    statusHistory: [{ status: 'submitting', at: new Date(), reason: submitReason || 'backend-submit-started' }],
  });

  try {
    const swarmResult = await callSwarm(config, axios, crypto, 'POST', '/internal/v1/jobs', {
      ...normalized,
      idempotencyKey,
      backendCorrelationId,
    });
    const swarmJob = swarmResult.job || swarmResult.data?.job || swarmResult;
    await upsertJobFromSwarm(models, swarmJob, {
      localId,
      idempotencyKey,
      backendCorrelationId,
      requestedBy: normalized.requestedBy,
      sourceEntity: normalized.sourceEntity,
      input: normalized.input,
      metadata: normalized.metadata,
    });
    const updated = await models.SwarmBackendJob.findById(localId).lean();
    return { localJob: updated || localJob, swarmResult };
  } catch (error) {
    localJob.status = 'failed_to_submit';
    localJob.error = summarizeError(error);
    localJob.statusHistory.push({ status: 'failed_to_submit', at: new Date(), reason: 'swarm-submit-failed' });
    await localJob.save();
    throw error;
  }
}

function resolveEventJobTypes({ trigger, settings, requestedJobTypes }) {
  const requested = Array.isArray(requestedJobTypes) ? requestedJobTypes.map((item) => String(item).trim()).filter(Boolean) : [];
  if (requested.length) return [...new Set(requested)];
  const fromSettings = Object.entries(settings.automations || {})
    .filter(([, control]) => control && control.enabled !== false && Array.isArray(control.triggers) && control.triggers.includes(trigger))
    .map(([jobType]) => jobType);
  if (fromSettings.length) return [...new Set(fromSettings)];
  return [...new Set(AUTOMATION_TRIGGER_DEFAULTS[trigger] || [])];
}

function resolveAutomationMode({ requestedMode, control, config, globalSettings, jobType }) {
  const requested = requestedMode ? normalizeMode(requestedMode) : null;
  let mode = requested || normalizeMode(control?.defaultMode || globalSettings?.defaultMode || config.defaultMode || 'DRAFT_ONLY');
  if (!DEFAULT_MODES.has(mode)) mode = 'DRAFT_ONLY';

  const isSocial = String(jobType || '').startsWith('social.');
  const automatedBlocked = mode === 'AUTOMATED' && (
    control?.allowAutomatedExecution !== true
    || (isSocial && (!config.socialPublishEnabled || !globalSettings?.socialPublishEnabled || control?.allowSocialPublish !== true))
    || (!isSocial && (!config.autoPublishEnabled || !globalSettings?.autoPublishEnabled || control?.allowAutoPublish !== true))
  );
  if (automatedBlocked) return control?.requiresApproval === false ? 'DRAFT_ONLY' : 'APPROVAL_REQUIRED';
  if (control?.requiresApproval !== false && mode === 'DRAFT_ONLY' && globalSettings?.approvalRequiredByDefault === false) return 'DRAFT_ONLY';
  return mode;
}

function normalizeAutomationTrigger(value) {
  const normalized = cleanString(value).toLowerCase().replace(/[-\s]+/g, '_');
  if (!normalized) throw httpError(400, 'AUTOMATION_TRIGGER_REQUIRED', 'Automation trigger is required.');
  const aliases = {
    fight_publish: 'fight_published',
    match_published: 'fight_published',
    fight_result: 'fight_result_updated',
    result_updated: 'fight_result_updated',
    event_upcoming: 'upcoming_event',
    pro_wrestling_publish: 'pro_wrestling_match_published',
    wrestling_match_published: 'pro_wrestling_match_published',
    wrestling_result_updated: 'pro_wrestling_result_updated',
    blog_publish: 'blog_approved',
    blog_published: 'blog_approved',
    daily: 'daily_schedule',
    weekly: 'weekly_schedule',
  };
  return aliases[normalized] || normalized;
}

function normalizeEventSourceEntity(sourceEntity, input, vertical, trigger) {
  const raw = isPlainObject(sourceEntity) ? sourceEntity : {};
  const sourceInput = isPlainObject(input) ? input : {};
  const type = cleanString(raw.type) || inferEventSourceType({ input: sourceInput, vertical, trigger });
  const id = cleanString(raw.id || raw._id || sourceInput.matchId || sourceInput.fightId || sourceInput.eventId || sourceInput.blogId || sourceInput.contestId || sourceInput.wrestlerId || sourceInput.fighterId);
  const label = cleanString(raw.label)
    || cleanString(sourceInput.title)
    || cleanString(sourceInput.matchName)
    || cleanString(sourceInput.eventName)
    || cleanString(sourceInput.blogTitle)
    || cleanString(sourceInput.topic)
    || `${vertical}:${trigger}`;
  return { ...raw, type, id: id || undefined, label: label.slice(0, 180), trigger, origin: raw.origin || 'backend_automation_event' };
}

function inferEventSourceType({ input, vertical, trigger }) {
  if (trigger.includes('blog')) return 'blog';
  if (trigger.includes('contest')) return vertical === 'pro_wrestling' ? 'pro_wrestling_contest' : 'contest';
  if (trigger.includes('wrestler')) return 'pro_wrestling_wrestler';
  if (trigger.includes('fighter')) return 'combat_fighter';
  if (trigger.includes('event')) return vertical === 'pro_wrestling' ? 'pro_wrestling_event' : 'combat_event';
  if (trigger.includes('wrestling')) return 'pro_wrestling_match';
  if (cleanString(input.blogId)) return 'blog';
  if (cleanString(input.matchId)) return vertical === 'pro_wrestling' ? 'pro_wrestling_match' : 'combat_match';
  return 'automation_event';
}

function buildAutomationJobInput({ input, metadata, trigger, eventId, jobType, vertical }) {
  return {
    ...(isPlainObject(input) ? input : {}),
    automationTrigger: trigger,
    automationEventId: eventId,
    requestedAutomation: jobType,
    vertical,
    requestedOutput: buildRequestedOutput(jobType),
    metadata: isPlainObject(metadata) ? metadata : {},
  };
}

function buildRequestedOutput(jobType) {
  if (jobType.startsWith('content.')) return 'structured content draft with SEO fields, sections, and admin review notes';
  if (jobType.startsWith('seo.')) return 'SEO recommendation artifact with exact fields to review/apply';
  if (jobType.startsWith('social.')) return 'platform-ready social draft; do not publish without backend approval flags';
  if (jobType.startsWith('data.')) return 'data/report artifact with candidates, assumptions, and review notes';
  if (jobType.startsWith('wrestling.')) return 'advisory pro-wrestling analysis artifact; backend remains authoritative';
  return 'automation report artifact';
}

function inferVerticalForTrigger(trigger) {
  return String(trigger || '').includes('wrestling') || String(trigger || '').includes('wrestler') ? 'pro_wrestling' : 'combat';
}

function inferVerticalForJobType(jobType) {
  const value = String(jobType || '');
  if (value.includes('wrestling') || value.includes('wrestler')) return 'pro_wrestling';
  return 'combat';
}

function inferJobGroup(jobType) {
  const prefix = String(jobType || '').split('.')[0];
  return AUTOMATION_GROUPS[prefix] ? prefix : 'system';
}

function buildAutomationLabel(jobType) {
  return String(jobType || '')
    .replace(/\./g, ' → ')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildAutomationDescription(jobType) {
  if (jobType.startsWith('content.')) return 'Creates a content draft for admin review and optional publishing.';
  if (jobType.startsWith('seo.')) return 'Creates SEO recommendations or metadata/schema artifacts.';
  if (jobType.startsWith('social.')) return 'Creates social-media copy; real publishing remains gated by backend settings.';
  if (jobType.startsWith('data.')) return 'Creates data, trend, calendar, or reporting artifacts.';
  if (jobType.startsWith('wrestling.')) return 'Creates advisory pro-wrestling analysis artifacts.';
  if (jobType.startsWith('automation.')) return 'Creates automation dashboard/control artifacts.';
  return 'System automation task.';
}

function inferAdminControls(jobType) {
  const controls = ['review'];
  if (jobType.startsWith('social.')) controls.push('platforms', 'publishFlag');
  if (jobType.startsWith('seo.')) controls.push('applySeo');
  if (jobType.startsWith('content.')) controls.push('publishBlog');
  if (jobType.includes('calendar') || jobType.includes('schedule')) controls.push('schedule');
  if (jobType.startsWith('automation.')) controls.push('dashboard');
  return [...new Set(controls)];
}

function createAutomationIdempotencyKey({ crypto, eventId, jobType, normalized }) {
  const hash = crypto.createHash('sha256').update(JSON.stringify({ eventId, jobType, sourceEntity: normalized.sourceEntity, input: normalized.input })).digest('hex').slice(0, 24);
  return `event:${eventId}:${jobType}:${hash}`.slice(0, 200);
}

function serializeAutomationEvent(event) {
  if (!event) return null;
  return {
    id: String(event._id),
    eventId: event.eventId,
    trigger: event.trigger,
    vertical: event.vertical,
    status: event.status,
    requestedBy: event.requestedBy,
    sourceEntity: event.sourceEntity,
    input: event.input,
    metadata: event.metadata,
    selectedJobTypes: event.selectedJobTypes || [],
    createdJobs: event.createdJobs || [],
    skippedJobs: event.skippedJobs || [],
    errors: event.errors || [],
    reason: event.reason,
    completedAt: event.completedAt,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

async function listLocalAutomationEvents(models, query) {
  const page = clamp(toInt(query?.page, 1), 1, 100000);
  const limit = clamp(toInt(query?.limit, 25), 1, 100);
  const filter = {};
  if (query?.trigger) filter.trigger = normalizeAutomationTrigger(query.trigger);
  if (query?.vertical) filter.vertical = normalizeVertical(query.vertical);
  if (query?.status) filter.status = String(query.status);
  const [rows, total] = await Promise.all([
    models.SwarmBackendAutomationEvent.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    models.SwarmBackendAutomationEvent.countDocuments(filter),
  ]);
  return { items: rows.map(serializeAutomationEvent), pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
}

async function verifyWebhookRequest({ req, models, crypto, config }) {
  if (!config.webhookRequireHmac) return true;
  if (!config.callbackSecret) throw httpError(401, 'SWARM_WEBHOOK_SECRET_MISSING', 'Backend webhook secret is not configured.');

  const keyId = req.header('x-swarm-key-id');
  const timestamp = req.header('x-swarm-timestamp');
  const nonce = req.header('x-swarm-nonce');
  const signature = req.header('x-swarm-signature');
  if (!keyId || !timestamp || !nonce || !signature) throw httpError(401, 'SWARM_WEBHOOK_HMAC_REQUIRED', 'Missing swarm webhook HMAC headers.');
  if (keyId !== config.callbackKeyId) throw httpError(401, 'SWARM_WEBHOOK_INVALID_KEY_ID', 'Invalid swarm webhook key id.');

  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) / 1000 > config.hmacMaxSkewSeconds) {
    throw httpError(401, 'SWARM_WEBHOOK_STALE_SIGNATURE', 'Webhook signature timestamp is stale.');
  }

  const rawBody = req.rawBody || JSON.stringify(req.body || {});
  const expected = signRequest({
    crypto,
    method: req.method,
    pathWithQuery: req.originalUrl,
    timestamp,
    nonce,
    body: rawBody,
    secret: config.callbackSecret,
  });

  if (!timingSafeEqual(crypto, normalizeSignature(signature), expected)) {
    throw httpError(401, 'SWARM_WEBHOOK_INVALID_SIGNATURE', 'Invalid swarm webhook signature.');
  }

  try {
    await models.SwarmBackendWebhookNonce.create({
      keyId,
      nonce,
      expiresAt: new Date(Date.now() + config.hmacMaxSkewSeconds * 1000),
    });
  } catch (error) {
    throw httpError(401, 'SWARM_WEBHOOK_REPLAYED_NONCE', 'Webhook nonce was already used.');
  }
  return true;
}

function buildWebhookJobFilter(event) {
  if (event.backendCorrelationId) return { backendCorrelationId: String(event.backendCorrelationId) };
  if (event.jobId) return { jobId: String(event.jobId) };
  return { backendCorrelationId: `unknown:${Date.now()}` };
}

function serializeLocalJob(job) {
  if (!job) return null;
  return {
    id: String(job._id),
    jobId: job.jobId,
    backendCorrelationId: job.backendCorrelationId,
    idempotencyKey: job.idempotencyKey,
    vertical: job.vertical,
    jobType: job.jobType,
    mode: job.mode,
    status: job.status,
    priority: job.priority,
    requestedBy: job.requestedBy,
    sourceEntity: job.sourceEntity,
    input: job.input,
    artifactId: job.artifactId,
    metadata: job.metadata,
    error: job.error,
    publishedEntity: job.publishedEntity,
    statusHistory: job.statusHistory,
    scheduledAt: job.scheduledAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    swarmJob: job.swarmJob,
  };
}

function serializeLocalArtifact(artifact) {
  if (!artifact) return null;
  return {
    id: String(artifact._id),
    artifactId: artifact.artifactId,
    jobId: artifact.jobId,
    vertical: artifact.vertical,
    jobType: artifact.jobType,
    artifactType: artifact.artifactType,
    title: artifact.title,
    summary: artifact.summary,
    reviewStatus: artifact.reviewStatus,
    payload: artifact.payload,
    provenance: artifact.provenance,
    quality: artifact.quality,
    reviewedBy: artifact.reviewedBy,
    reviewedAt: artifact.reviewedAt,
    reviewReason: artifact.reviewReason,
    publishedEntity: artifact.publishedEntity,
    publishedAt: artifact.publishedAt,
    metadata: artifact.metadata,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    swarmArtifact: artifact.swarmArtifact,
  };
}

function sanitizeSwarmEnvelope(value) {
  if (!value) return value;
  return value;
}

function summarizeError(error) {
  if (!error) return undefined;
  return {
    message: error.message || 'Unknown error',
    code: error.code,
    status: error.status,
    httpStatus: error.httpStatus,
    details: error.details,
    response: error.response ? {
      status: error.response.status,
      data: typeof error.response.data === 'string' ? error.response.data.slice(0, 1000) : error.response.data,
    } : undefined,
  };
}

function signRequest({ crypto, method, pathWithQuery, timestamp, nonce, body, secret }) {
  const canonical = [String(method).toUpperCase(), pathWithQuery, timestamp, nonce, sha256Hex(crypto, body || '')].join('\n');
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

function sha256Hex(crypto, body) {
  return crypto.createHash('sha256').update(body || '').digest('hex');
}

function timingSafeEqual(crypto, left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeSignature(signature) {
  const value = String(signature || '');
  return value.startsWith('sha256=') ? value.slice('sha256='.length) : value;
}

function createIdempotencyKey({ crypto, normalized, backendCorrelationId }) {
  const hash = crypto.createHash('sha256').update(JSON.stringify({
    vertical: normalized.vertical,
    jobType: normalized.jobType,
    mode: normalized.mode,
    input: normalized.input,
    backendCorrelationId,
  })).digest('hex').slice(0, 24);
  return `backend:${normalized.vertical}:${normalized.jobType}:${hash}`;
}

function adminActor(admin) {
  return {
    id: admin?.id ? String(admin.id) : undefined,
    email: admin?.email ? String(admin.email) : undefined,
    role: 'admin',
    source: 'backend',
  };
}

function pickQuery(query, keys) {
  const picked = {};
  keys.forEach((key) => {
    if (query[key] !== undefined) picked[key] = query[key];
  });
  return picked;
}

function normalizeVertical(value) {
  const normalized = String(value || 'combat').trim().toLowerCase().replace(/-/g, '_');
  if (['wrestling', 'prowrestling', 'pro_wrestling'].includes(normalized)) return 'pro_wrestling';
  if (['mma', 'fight', 'fights', 'combat_sports'].includes(normalized)) return 'combat';
  return normalized;
}

function stripTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function cleanString(value) {
  if (value === undefined || value === null) return '';
  const text = String(value).trim();
  return text.length ? text : '';
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toDateOrUndefined(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function httpError(status, code, message, details) {
  const error = new Error(message);
  error.status = status;
  error.httpStatus = status;
  error.code = code;
  error.details = details;
  return error;
}

module.exports = {
  registerSwarmPhase2Routes,
  // Exported for lightweight regression tests.
  _private: {
    normalizeVertical,
    mapArtifactToBlog,
    normalizeCreateJobBody,
    normalizeMode,
    normalizeSourceEntity,
    normalizeAutomationTrigger,
    resolveEventJobTypes,
    buildLocalAutomationCatalog,
    buildDefaultAutomationSettings,
    inferVerticalForJobType,
    signRequest,
    sha256Hex,
  },
};
