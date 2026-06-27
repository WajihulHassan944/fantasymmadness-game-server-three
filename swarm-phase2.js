'use strict';

/**
 * Phase 2 Swarm Gateway for FantasyMMAdness backend.
 *
 * This file intentionally lives beside server.js so the existing backend structure
 * remains unchanged. It adds authenticated admin routes that proxy controlled work
 * to the Phase 1 IONOS swarm service and webhook routes for async callbacks.
 */

const DEFAULT_JOB_TYPES = new Set([
  'content.article',
  'content.match-preview',
  'content.event-recap',
  'seo.audit',
  'social.draft',
  'data.external-candidate',
  'wrestling.scorecard-suggestion',
  'wrestling.match-analysis',
  'wrestling.wrestler-profile',
  'system.health-check',
]);

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
      defaultMode: config.defaultMode,
      verticals: Array.from(DEFAULT_VERTICALS),
      jobTypes: Array.from(DEFAULT_JOB_TYPES),
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
    if (publish && isBlogArtifact(latest)) {
      published = await publishBlogArtifact({ artifact: latest, Blog, Notification, admin, mongoose });
      latest.reviewStatus = 'PUBLISHED';
      latest.publishedEntity = published.entity;
      latest.publishedAt = new Date();
      await models.SwarmBackendJob.updateOne(
        { jobId: latest.jobId },
        { $set: { status: 'published', artifactId: latest.artifactId, publishedEntity: published.entity, updatedAt: new Date() }, $push: { statusHistory: { status: 'published', at: new Date(), reason: 'artifact-approved-and-published' } } },
      );
    }

    await latest.save();
    res.json({ ok: true, artifact: serializeLocalArtifact(latest), published, remoteReview: sanitizeSwarmEnvelope(remoteReview) });
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

  const nonceSchema = new mongoose.Schema({
    keyId: { type: String, required: true },
    nonce: { type: String, required: true },
    expiresAt: { type: Date, required: true, expires: 0 },
  }, { timestamps: true });
  nonceSchema.index({ keyId: 1, nonce: 1 }, { unique: true });

  return {
    SwarmBackendJob: mongoose.models.SwarmBackendJob || mongoose.model('SwarmBackendJob', jobSchema, 'swarm_backend_jobs'),
    SwarmBackendArtifact: mongoose.models.SwarmBackendArtifact || mongoose.model('SwarmBackendArtifact', artifactSchema, 'swarm_backend_artifacts'),
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
  return type === 'content.article-draft' || type === 'content.match-preview-draft' || type === 'content.event-recap-draft';
}

async function publishBlogArtifact({ artifact, Blog, Notification, admin }) {
  if (!Blog) throw httpError(500, 'BLOG_MODEL_UNAVAILABLE', 'Blog model is not available for publishing.');
  if (artifact.publishedEntity?.id) {
    return { action: 'already_published', entity: artifact.publishedEntity };
  }

  const payload = artifact.payload || {};
  const blogData = mapArtifactToBlog(payload, artifact);
  if (!blogData.metaTitle || !blogData.header) {
    throw httpError(400, 'INVALID_BLOG_ARTIFACT', 'Content artifact does not contain enough data to publish a blog.');
  }

  const existing = await Blog.findOne({ metaTitle: blogData.metaTitle });
  if (existing) {
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
  const [jobs, artifacts, awaitingReview, failedJobs] = await Promise.all([
    models.SwarmBackendJob.countDocuments(),
    models.SwarmBackendArtifact.countDocuments(),
    models.SwarmBackendArtifact.countDocuments({ reviewStatus: { $in: ['DRAFT', 'AWAITING_REVIEW'] } }),
    models.SwarmBackendJob.countDocuments({ status: { $in: ['failed', 'dead_letter', 'failed_to_submit'] } }),
  ]);
  return { jobs, artifacts, awaitingReview, failedJobs };
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
    signRequest,
    sha256Hex,
  },
};
