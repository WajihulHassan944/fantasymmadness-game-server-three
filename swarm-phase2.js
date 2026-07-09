'use strict';

/**
 * Phase 2 Swarm Gateway for FantasyMMAdness backend.
 *
 * This file intentionally lives beside server.js so the existing backend structure
 * remains unchanged. It adds authenticated admin routes that proxy controlled work
 * to the Phase 1 IONOS swarm service and webhook routes for async callbacks.
 */

const DEFAULT_JOB_TYPE_ARRAY = [
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
  'content.fight-publish-blog-draft',
  'social.fight-publish-post',
  'seo.metadata',
  'seo.schema-markup',
  'seo.sitemap-refresh',
  'seo.internal-links',
  'content.newsletter-draft',
  'content.fight-result-recap',
  'social.result-post',
  'analytics.leaderboard-summary',
  'content.upcoming-event-preview',
  'content.fight-card-article',
  'social.event-promotional-posts',
  'content.homepage-feature',
  'content.fighter-profile',
  'seo.fighter-refresh',
  'content.fighter-update-suggestion',
  'content.pro-wrestling-match-preview',
  'content.pro-wrestling-result-recap',
  'content.wrestler-profile',
  'content.contest-rules-explainer',
  'social.contest-reminder',
  'social.winners-announcement',
  'social.blog-approved-post',
  'seo.blog-audit',
  'seo.related-post-linking',
  'media.image-prompt',
  'content.blog-newsletter-draft',
  'seo.daily-audit',
  'seo.weekly-traffic-opportunity',
  'seo.missing-pages-detector',
  'seo.low-quality-page-detector',
  'seo.broken-link-detector',
  'seo.missing-meta-detector',
  'seo.duplicate-content-detector',
  'seo.keyword-opportunity',
  'data.trending-mma-topics',
  'data.trending-wrestling-topics',
  'content.calendar',
  'content.blog-topic-suggestions',
  'social.calendar',
  'automation.draft-queue-generation',
  'automation.settings-export',
  'automation.prompt-management',
  'automation.failed-job-retry-plan',
  'analytics.agent-performance',
  'analytics.traffic-growth-dashboard',
  'seo.content-freshness-monitor',
  'content.old-blog-update-suggestion',
  'content.old-blog-refresh',
  'content.faq',
  'content.how-to-play',
  'content.landing-page-suggestion',
  'seo.canonical-checks',
  'seo.opengraph-twitter-cards',
  'seo.fight-event-structured-data',
  'seo.fighter-wrestler-structured-data',
  'social.youtube-caption-draft',
  'social.discord-announcement-draft',
  'notification.traffic-issues',
  'notification.failed-automations',
  'social.instagram-post-draft',
  'social.facebook-post-draft',
  'social.multi-platform-daily-posts',
  'data.fight-calendar-refresh',
  'content.user-dashboard-opportunities',
  'analytics.user-growth-1000-plan',
  'seo.competitor-gap-report',
];

const DEFAULT_JOB_TYPES = new Set(DEFAULT_JOB_TYPE_ARRAY);

const JULY_10000_GROWTH_JOB_TYPES = Object.freeze([
  'analytics.july-10000-signup-growth-plan',
  'data.event-calendar-daily-update',
  'content.fight-card-daily-package',
  'content.blog-seo-daily-articles',
  'social.instagram-growth-posts',
  'social.facebook-growth-posts',
  'social.x-growth-posts',
  'social.youtube-growth-video-draft',
  'social.short-form-video-pack',
  'notification.community-retention-daily',
  'media.branded-post-image-prompt',
]);

const JULY_10000_GROWTH_AUTOMATION_KEYS = Object.freeze([
  'growth.july10000SystemPlan',
  'event.calendarDailyUpdate',
  'fightCard.dailyPackage',
  'blogSeo.dailyArticles',
  'social.instagramGrowthPosts',
  'social.facebookGrowthPosts',
  'social.xGrowthPosts',
  'social.youtubeGrowthVideoDraft',
  'social.shortFormVideoPack',
  'community.retentionDaily',
  'media.brandedPostImagePrompt',
]);

const JULY_10000_REQUIRED_YOUTUBE_CTA = 'Make your picks on Fantasy MMadness before the event starts.';

const PHASE1_SEO_FOUNDATION_JOB_TYPES = Object.freeze([
  'seo.technical-foundation-audit',
  'seo.sitemap-robots-audit',
  'seo.pagination-opportunity-report',
  'seo.image-performance-audit',
  'seo.core-web-vitals-plan',
  'seo.landing-page-roadmap',
  'seo.fight-detail-seo-roadmap',
  'seo.fighter-profile-seo-roadmap',
  'seo.blog-architecture-audit',
  'seo.footer-internal-link-audit',
  'seo.conversion-cta-audit',
  'seo.trust-compliance-content-plan',
  'content.sport-landing-page-brief',
  'content.fight-detail-page-brief',
  'content.fighter-profile-page-brief',
  'media.blog-featured-image-prompt',
]);

for (const jobType of [...PHASE1_SEO_FOUNDATION_JOB_TYPES, ...JULY_10000_GROWTH_JOB_TYPES]) {
  if (!DEFAULT_JOB_TYPES.has(jobType)) {
    DEFAULT_JOB_TYPE_ARRAY.push(jobType);
    DEFAULT_JOB_TYPES.add(jobType);
  }
}

const DEFAULT_SPORTS = new Set(['mma', 'boxing', 'kickboxing', 'combat', 'pro_wrestling']);

const CAMPAIGN_TYPES = new Set([
  'fight_full_campaign',
  'fight_tonight_campaign',
  'fight_result_campaign',
  'boxing_fight_campaign',
  'pro_wrestling_match_campaign',
  'blog_promotion_campaign',
  'contest_promotion_campaign',
  'july_10000_signup_growth_system',
  'custom_campaign',
]);

const CAMPAIGN_SECTIONS = new Set(['content', 'seo', 'social', 'media', 'analytics', 'notification', 'data', 'admin']);

const LOCAL_CAMPAIGN_PACKS = Object.freeze([
  {
    campaignType: 'fight_full_campaign',
    label: 'Fight full campaign',
    description: 'Run blog, SEO, social, newsletter, homepage, image, and traffic agents for one fight.',
    defaultVertical: 'combat',
    defaultSport: 'mma',
    defaultSections: ['content', 'seo', 'social', 'media', 'data'],
  },
  {
    campaignType: 'fight_tonight_campaign',
    label: 'Promote tonight fight',
    description: 'Run same-day fight promotion agents for a fight that needs attention now.',
    defaultVertical: 'combat',
    defaultSport: 'mma',
    defaultSections: ['content', 'seo', 'social', 'media', 'data'],
  },
  {
    campaignType: 'boxing_fight_campaign',
    label: 'Boxing fight campaign',
    description: 'Run the fight campaign pack with Boxing-specific wording, tags, SEO, and social copy.',
    defaultVertical: 'combat',
    defaultSport: 'boxing',
    defaultSections: ['content', 'seo', 'social', 'media', 'data'],
  },
  {
    campaignType: 'fight_result_campaign',
    label: 'Fight result campaign',
    description: 'Run recap, result social, and leaderboard-summary agents after a fight result update.',
    defaultVertical: 'combat',
    defaultSport: 'mma',
    defaultSections: ['content', 'social', 'analytics'],
  },
  {
    campaignType: 'pro_wrestling_match_campaign',
    label: 'Pro-wrestling match campaign',
    description: 'Run preview/recap, wrestling analysis, social, SEO, schema, and newsletter agents.',
    defaultVertical: 'pro_wrestling',
    defaultSport: 'pro_wrestling',
    defaultSections: ['content', 'seo', 'social', 'media'],
  },
  {
    campaignType: 'blog_promotion_campaign',
    label: 'Blog promotion campaign',
    description: 'Run social, SEO audit, related links, image prompt, and newsletter agents for an approved blog.',
    defaultVertical: 'combat',
    defaultSport: 'mma',
    defaultSections: ['seo', 'social', 'media', 'content'],
  },
  {
    campaignType: 'contest_promotion_campaign',
    label: 'Contest promotion campaign',
    description: 'Run contest explainer, reminder, winners announcement, and social promotion agents.',
    defaultVertical: 'combat',
    defaultSport: 'mma',
    defaultSections: ['content', 'social', 'notification'],
  },
  {
    campaignType: 'july_10000_signup_growth_system',
    label: 'July 10,000 signup growth system',
    description: 'Run the safe daily growth pack: event calendar, fight card, Instagram, Facebook, X, YouTube, Shorts, blog/SEO, media, and retention draft agents.',
    defaultVertical: 'combat',
    defaultSport: 'combat',
    defaultSections: ['content', 'seo', 'social', 'media', 'analytics', 'notification', 'data'],
    automationKeys: JULY_10000_GROWTH_AUTOMATION_KEYS,
    dailyOutputTargets: buildJulyGrowthOutputTargets(),
  },
  {
    campaignType: 'custom_campaign',
    label: 'Custom campaign',
    description: 'Run selected sections or selected automation keys as one grouped campaign.',
    defaultVertical: 'combat',
    defaultSport: 'mma',
    defaultSections: ['content', 'seo', 'social'],
  },
]);

const AUTOMATION_TRIGGER_DEFAULTS = Object.freeze({
  manual: [],
  fight_published: [
    'content.fight-publish-blog-draft',
    'social.fight-publish-post',
    'seo.metadata',
    'seo.schema-markup',
    'seo.sitemap-refresh',
    'seo.internal-links',
    'content.newsletter-draft',
    'seo.fight-event-structured-data',
  ],
  fight_result_updated: [
    'content.fight-result-recap',
    'social.result-post',
    'analytics.leaderboard-summary',
  ],
  upcoming_event: [
    'content.upcoming-event-preview',
    'content.fight-card-article',
    'social.event-promotional-posts',
    'content.homepage-feature',
    'seo.fight-event-structured-data',
  ],
  fighter_added: [
    'content.fighter-profile',
    'seo.fighter-wrestler-structured-data',
  ],
  fighter_updated: [
    'seo.fighter-refresh',
    'seo.content-freshness-monitor',
  ],
  fighter_record_changed: [
    'content.fighter-update-suggestion',
  ],
  pro_wrestling_match_published: [
    'content.pro-wrestling-match-preview',
    'wrestling.match-analysis',
    'social.blog-approved-post',
    'seo.schema-markup',
  ],
  pro_wrestling_result_updated: [
    'content.pro-wrestling-result-recap',
    'social.result-post',
  ],
  wrestler_added: [
    'content.wrestler-profile',
    'wrestling.wrestler-profile',
    'seo.fighter-wrestler-structured-data',
  ],
  contest_created: [
    'content.contest-rules-explainer',
    'social.discord-announcement-draft',
  ],
  contest_closing_soon: [
    'social.contest-reminder',
  ],
  contest_completed: [
    'social.winners-announcement',
  ],
  blog_approved: [
    'social.blog-approved-post',
    'seo.blog-audit',
    'seo.related-post-linking',
    'media.image-prompt',
    'content.blog-newsletter-draft',
    'seo.opengraph-twitter-cards',
  ],
  daily_schedule: [
    'seo.daily-audit',
    'seo.missing-pages-detector',
    'seo.low-quality-page-detector',
    'seo.broken-link-detector',
    'seo.missing-meta-detector',
    'seo.keyword-opportunity',
    'data.trending-mma-topics',
    'data.trending-wrestling-topics',
    'automation.draft-queue-generation',
    'analytics.agent-performance',
    'data.fight-calendar-refresh',
    'content.user-dashboard-opportunities',
    'social.multi-platform-daily-posts',
    'social.instagram-post-draft',
    'social.facebook-post-draft',
  ],
  july_growth_daily: JULY_10000_GROWTH_JOB_TYPES,
  weekly_schedule: [
    'seo.weekly-traffic-opportunity',
    'seo.duplicate-content-detector',
    'content.calendar',
    'social.calendar',
    'seo.competitor-gap-report',
    'analytics.traffic-growth-dashboard',
    'seo.content-freshness-monitor',
    'analytics.user-growth-1000-plan',
  ],
  schedule_daily: [
    'seo.daily-audit',
    'data.fight-calendar-refresh',
    'content.user-dashboard-opportunities',
    'social.multi-platform-daily-posts',
    'social.instagram-post-draft',
    'social.facebook-post-draft',
  ],
  schedule_weekly: [
    'seo.weekly-traffic-opportunity',
    'analytics.traffic-growth-dashboard',
    'analytics.user-growth-1000-plan',
    'seo.competitor-gap-report',
  ],
});

const AUTOMATION_GROUPS = Object.freeze({
  content: 'Content automation',
  seo: 'SEO automation',
  social: 'Social automation',
  data: 'Data and traffic automation',
  analytics: 'Analytics and dashboards',
  media: 'Media and image prompt automation',
  notification: 'Admin notification automation',
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
    upload,
    cloudinary,
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
      sport: event?.sport || event?.discipline,
      mode: event?.mode,
      sourceEntity: event?.sourceEntity,
      input: event?.input || {},
      metadata: { ...(isPlainObject(event?.metadata) ? event.metadata : {}), submittedFrom: event?.submittedFrom || 'backend-hook' },
      requestedJobTypes: Array.isArray(event?.jobTypes) ? event.jobTypes : undefined,
      reason: event?.reason || 'backend-hook-triggered-automation-event',
    }),
    triggerCampaign: (campaign) => createSwarmCampaign({
      config: getSwarmConfig(),
      axios,
      crypto,
      mongoose,
      models,
      body: campaign || {},
      admin: campaign?.admin || campaign?.requestedBy,
      reason: campaign?.reason || 'backend-hook-triggered-campaign',
    }),
  };

  const artifactUpload = upload?.fields ? upload.fields([{ name: 'blogHeaderImage', maxCount: 1 }]) : (req, res, next) => next();

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
      socialDefaultPlatforms: config.socialDefaultPlatforms,
      dailySocialDraftCount: config.dailySocialDraftCount,
      metaSocialConfigured: config.metaSocialConfigured,
      twitterConfigured: config.twitterConfigured,
      automationEventHooksEnabled: config.automationEventHooksEnabled,
      defaultMode: config.defaultMode,
      verticals: Array.from(DEFAULT_VERTICALS),
      sports: Array.from(DEFAULT_SPORTS),
      jobTypes: DEFAULT_JOB_TYPE_ARRAY,
      automationTriggers: Object.keys(AUTOMATION_TRIGGER_DEFAULTS),
      automationGroups: AUTOMATION_GROUPS,
      campaignTypes: Array.from(CAMPAIGN_TYPES),
      campaignPacks: LOCAL_CAMPAIGN_PACKS,
      julyGrowth: buildJulyGrowthConfig(),
      reviewStatuses: Array.from(REVIEW_STATUSES),
    });
  }));

  app.get('/api/admin/swarm/growth/july-10000/config', verifyAdminToken, asyncHandler(async (req, res) => {
    res.json({ ok: true, source: 'backend', config: buildJulyGrowthConfig() });
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
        const result = await callSwarm(config, axios, crypto, 'GET', '/internal/v1/automations');
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
        const result = await callSwarm(config, axios, crypto, 'GET', '/internal/v1/automations');
        return res.json({ ok: true, source: 'swarm', settings: buildSettingsFromAutomationItems(result.items || result.automations || []), automations: result.items || result.automations || [], swarm: sanitizeSwarmEnvelope(result) });
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
    const result = await callSwarm(config, axios, crypto, 'POST', '/internal/v1/automations/settings/bulk', body);
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
        const result = await callSwarm(config, axios, crypto, 'GET', '/internal/v1/automations/dashboard');
        return res.json({ ok: true, source: 'swarm', backendCache: cache, backendEvents: recentEvents.items, ...result });
      } catch (error) {
        if (String(req.query.fallbackCache || 'true').toLowerCase() === 'false') throw error;
        return res.status(206).json({ ok: true, source: 'cache', warning: 'Swarm unavailable; returned backend dashboard cache.', error: summarizeError(error), backendCache: cache, backendEvents: recentEvents.items });
      }
    }
    res.json({ ok: true, source: 'cache', backendCache: cache, backendEvents: recentEvents.items });
  }));


  app.get('/api/admin/swarm/automations', verifyAdminToken, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    if (config.enabled && String(req.query.source || '').toLowerCase() !== 'local') {
      try {
        const result = await callSwarm(config, axios, crypto, 'GET', '/internal/v1/automations', undefined, pickQuery(req.query, ['trigger', 'category', 'vertical']));
        return res.json({ ok: true, source: 'swarm', ...result });
      } catch (error) {
        if (String(req.query.fallbackLocal || 'true').toLowerCase() === 'false') throw error;
        return res.status(206).json({ ok: true, source: 'local', warning: 'Swarm unavailable; returned backend automation fallback.', error: summarizeError(error), ...buildLocalAutomationCatalog() });
      }
    }
    res.json({ ok: true, source: 'local', ...buildLocalAutomationCatalog() });
  }));

  app.get('/api/admin/swarm/automations/dashboard', verifyAdminToken, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    const cache = await getCacheStats(models);
    if (config.enabled && String(req.query.source || '').toLowerCase() !== 'cache') {
      try {
        const result = await callSwarm(config, axios, crypto, 'GET', '/internal/v1/automations/dashboard');
        return res.json({ ok: true, source: 'swarm', backendCache: cache, ...result });
      } catch (error) {
        if (String(req.query.fallbackCache || 'true').toLowerCase() === 'false') throw error;
        return res.status(206).json({ ok: true, source: 'cache', warning: 'Swarm unavailable; returned backend automation dashboard cache.', error: summarizeError(error), backendCache: cache });
      }
    }
    res.json({ ok: true, source: 'cache', backendCache: cache });
  }));

  app.get('/api/admin/swarm/automations/logs', verifyAdminToken, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    if (config.enabled && String(req.query.source || '').toLowerCase() !== 'local') {
      try {
        const result = await callSwarm(config, axios, crypto, 'GET', '/internal/v1/automations/logs', undefined, pickQuery(req.query, ['key', 'trigger', 'limit']));
        return res.json({ ok: true, source: 'swarm', ...result });
      } catch (error) {
        if (String(req.query.fallbackLocal || 'true').toLowerCase() === 'false') throw error;
        const events = await listLocalAutomationEvents(models, { limit: req.query.limit || 50, trigger: req.query.trigger });
        return res.status(206).json({ ok: true, source: 'local', warning: 'Swarm unavailable; returned backend event fallback.', error: summarizeError(error), items: events.items });
      }
    }
    const events = await listLocalAutomationEvents(models, { limit: req.query.limit || 50, trigger: req.query.trigger });
    res.json({ ok: true, source: 'local', items: events.items });
  }));

  app.patch('/api/admin/swarm/automations/:key/settings', verifyAdminToken, requireSwarmEnabled, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    const result = await callSwarm(config, axios, crypto, 'PATCH', `/internal/v1/automations/${encodeURIComponent(req.params.key)}/settings`, {
      ...(req.body || {}),
      updatedBy: req.body?.updatedBy || adminActor(req.admin),
    });
    res.json({ ok: true, source: 'swarm', ...result });
  }));

  app.post('/api/admin/swarm/automations/settings/bulk', verifyAdminToken, requireSwarmEnabled, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    const result = await callSwarm(config, axios, crypto, 'POST', '/internal/v1/automations/settings/bulk', {
      ...(req.body || {}),
      items: Array.isArray(req.body?.items) ? req.body.items.map((item) => ({ ...item, updatedBy: item.updatedBy || adminActor(req.admin) })) : [],
    });
    res.json({ ok: true, source: 'swarm', ...result });
  }));

  app.post('/api/admin/swarm/automations/:key/reset', verifyAdminToken, requireSwarmEnabled, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    const result = await callSwarm(config, axios, crypto, 'POST', `/internal/v1/automations/${encodeURIComponent(req.params.key)}/reset`, {
      ...(req.body || {}),
      actor: req.body?.actor || adminActor(req.admin),
    });
    res.json({ ok: true, source: 'swarm', ...result });
  }));

  app.post('/api/admin/swarm/schedules/daily/run', verifyAdminToken, requireSwarmEnabled, asyncHandler(async (req, res) => {
    const result = await runSchedulePreset({ config: getSwarmConfig(), axios, crypto, mongoose, models, admin: req.admin, body: req.body || {}, preset: 'daily' });
    res.status(result.createdJobs?.length ? 202 : 200).json({ ok: true, ...result });
  }));

  app.post('/api/admin/swarm/schedules/weekly/run', verifyAdminToken, requireSwarmEnabled, asyncHandler(async (req, res) => {
    const result = await runSchedulePreset({ config: getSwarmConfig(), axios, crypto, mongoose, models, admin: req.admin, body: req.body || {}, preset: 'weekly' });
    res.status(result.createdJobs?.length ? 202 : 200).json({ ok: true, ...result });
  }));

  app.post('/api/admin/swarm/schedules/daily/seo', verifyAdminToken, requireSwarmEnabled, asyncHandler(async (req, res) => {
    const result = await runExplicitAutomationJobs({ config: getSwarmConfig(), axios, crypto, mongoose, models, admin: req.admin, body: req.body || {}, trigger: 'daily_schedule', jobTypes: ['seo.daily-audit', 'seo.keyword-opportunity', 'seo.missing-pages-detector', 'seo.low-quality-page-detector', 'seo.broken-link-detector', 'seo.missing-meta-detector'] });
    res.status(result.createdJobs?.length ? 202 : 200).json({ ok: true, ...result });
  }));

  app.post('/api/admin/swarm/schedules/daily/social', verifyAdminToken, requireSwarmEnabled, asyncHandler(async (req, res) => {
    const result = await runExplicitAutomationJobs({ config: getSwarmConfig(), axios, crypto, mongoose, models, admin: req.admin, body: req.body || {}, trigger: 'daily_schedule', jobTypes: ['social.multi-platform-daily-posts', 'social.instagram-post-draft', 'social.facebook-post-draft', 'social.blog-approved-post'] });
    res.status(result.createdJobs?.length ? 202 : 200).json({ ok: true, ...result });
  }));

  app.post('/api/admin/swarm/schedules/daily/calendar-refresh', verifyAdminToken, requireSwarmEnabled, asyncHandler(async (req, res) => {
    const result = await runExplicitAutomationJobs({ config: getSwarmConfig(), axios, crypto, mongoose, models, admin: req.admin, body: req.body || {}, trigger: 'daily_schedule', jobTypes: ['data.fight-calendar-refresh', 'content.user-dashboard-opportunities'] });
    res.status(result.createdJobs?.length ? 202 : 200).json({ ok: true, ...result });
  }));

  const runJulyGrowthDailyHandler = asyncHandler(async (req, res) => {
    const body = mergeJulyGrowthBody(req.body || {});
    const result = await runExplicitAutomationJobs({
      config: getSwarmConfig(),
      axios,
      crypto,
      mongoose,
      models,
      admin: req.admin,
      body,
      trigger: 'july_growth_daily',
      jobTypes: JULY_10000_GROWTH_JOB_TYPES,
    });
    res.status(result.createdJobs?.length ? 202 : 200).json({ ok: true, growthConfig: buildJulyGrowthConfig(), ...result });
  });

  app.post('/api/admin/swarm/schedules/daily/july-growth', verifyAdminToken, requireSwarmEnabled, runJulyGrowthDailyHandler);
  app.post('/api/admin/swarm/growth/july-10000/run', verifyAdminToken, requireSwarmEnabled, runJulyGrowthDailyHandler);

  app.get('/api/admin/swarm/growth/july-10000/dashboard', verifyAdminToken, asyncHandler(async (req, res) => {
    const growthFilter = {
      $or: [
        { 'metadata.growthSystem': 'july-10000-signups' },
        { jobType: { $in: JULY_10000_GROWTH_JOB_TYPES } },
      ],
    };
    const [jobs, artifacts, campaigns, awaitingReview, latestJobs, latestArtifacts] = await Promise.all([
      models.SwarmBackendJob.countDocuments(growthFilter),
      models.SwarmBackendArtifact.countDocuments(growthFilter),
      models.SwarmBackendCampaign.countDocuments({ campaignType: 'july_10000_signup_growth_system' }),
      models.SwarmBackendArtifact.countDocuments({ ...growthFilter, reviewStatus: { $in: ['DRAFT', 'AWAITING_REVIEW'] } }),
      models.SwarmBackendJob.find(growthFilter).sort({ createdAt: -1 }).limit(10).lean(),
      models.SwarmBackendArtifact.find(growthFilter).sort({ createdAt: -1 }).limit(10).lean(),
    ]);

    res.json({
      ok: true,
      source: 'backend-cache',
      config: buildJulyGrowthConfig(),
      counts: { jobs, artifacts, campaigns, awaitingReview },
      latestJobs: latestJobs.map(serializeLocalJob),
      latestArtifacts: latestArtifacts.map(serializeLocalArtifact),
    });
  }));

  app.get('/api/admin/swarm/campaigns/packs', verifyAdminToken, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    if (config.enabled && String(req.query.source || '').toLowerCase() !== 'local') {
      try {
        const result = await callSwarm(config, axios, crypto, 'GET', '/internal/v1/campaigns/packs');
        return res.json({ ok: true, source: 'swarm', items: result.items || result.packs || LOCAL_CAMPAIGN_PACKS, swarm: sanitizeSwarmEnvelope(result) });
      } catch (error) {
        if (String(req.query.fallbackLocal || 'true').toLowerCase() === 'false') throw error;
        return res.status(206).json({ ok: true, source: 'local', warning: 'Swarm unavailable; returned backend campaign-pack fallback.', error: summarizeError(error), items: LOCAL_CAMPAIGN_PACKS });
      }
    }
    res.json({ ok: true, source: 'local', items: LOCAL_CAMPAIGN_PACKS });
  }));

  app.get('/api/admin/swarm/campaigns', verifyAdminToken, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    const useCacheOnly = String(req.query.source || '').toLowerCase() === 'cache' || !config.enabled;
    const needsLocalSearch = Boolean(
      cleanString(req.query.search)
      || cleanString(req.query.fightId)
      || cleanString(req.query.matchId)
      || cleanString(req.query.entityId)
      || cleanString(req.query.sourceEntityId)
      || cleanString(req.query.campaignId)
    );
    if (!useCacheOnly && !needsLocalSearch) {
      try {
        const result = await callSwarm(config, axios, crypto, 'GET', '/internal/v1/campaigns', undefined, pickQuery(req.query, ['status', 'campaignType', 'vertical', 'sport', 'page', 'limit']));
        const items = Array.isArray(result.items) ? result.items : [];
        await Promise.all(items.map((campaign) => upsertCampaignFromSwarm(models, campaign)));
        return res.json({ ok: true, source: 'swarm', ...result });
      } catch (error) {
        if (String(req.query.fallbackCache || 'true').toLowerCase() === 'false') throw error;
        const cache = await listLocalCampaigns(models, req.query);
        return res.status(206).json({ ok: true, source: 'cache', warning: 'Swarm unavailable; returned backend campaign cache.', error: summarizeError(error), ...cache });
      }
    }

    if (!useCacheOnly && needsLocalSearch) {
      try {
        const result = await callSwarm(config, axios, crypto, 'GET', '/internal/v1/campaigns', undefined, pickQuery(req.query, ['status', 'campaignType', 'vertical', 'sport', 'page', 'limit']));
        const items = Array.isArray(result.items) ? result.items : [];
        await Promise.all(items.map((campaign) => upsertCampaignFromSwarm(models, campaign)));
      } catch (error) {
        if (String(req.query.fallbackCache || 'true').toLowerCase() === 'false') throw error;
      }
    }

    const cache = await listLocalCampaigns(models, req.query);
    res.json({ ok: true, source: needsLocalSearch ? 'cache-search' : 'cache', ...cache });
  }));

  app.get('/api/admin/swarm/campaigns/:campaignId', verifyAdminToken, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    let remoteError = null;
    if (config.enabled && String(req.query.source || '').toLowerCase() !== 'cache') {
      try {
        const result = await callSwarm(config, axios, crypto, 'GET', `/internal/v1/campaigns/${encodeURIComponent(req.params.campaignId)}`);
        const campaign = result.campaign || result.data?.campaign || result;
        await upsertCampaignFromSwarm(models, campaign);
      } catch (error) {
        remoteError = summarizeError(error);
      }
    }
    const local = await models.SwarmBackendCampaign.findOne({ campaignId: req.params.campaignId }).lean();
    if (!local && remoteError) return res.status(502).json({ ok: false, code: 'SWARM_CAMPAIGN_LOOKUP_FAILED', error: remoteError });
    if (!local) return res.status(404).json({ ok: false, code: 'SWARM_CAMPAIGN_NOT_FOUND', message: 'Campaign not found.' });
    res.json({ ok: true, source: 'cache', campaign: serializeLocalCampaign(local), remoteError });
  }));

  app.post('/api/admin/swarm/campaigns', verifyAdminToken, requireSwarmEnabled, asyncHandler(async (req, res) => {
    const result = await createSwarmCampaign({
      config: getSwarmConfig(),
      axios,
      crypto,
      mongoose,
      models,
      body: req.body || {},
      admin: req.admin,
      reason: req.body?.reason || 'admin-created-campaign',
    });
    res.status(202).json({ ok: true, ...result });
  }));

  app.post('/api/admin/swarm/campaigns/fight', verifyAdminToken, requireSwarmEnabled, asyncHandler(async (req, res) => {
    const body = { ...(req.body || {}) };
    const sport = normalizeSport(body.sport || body.discipline || body.combatSport || body.vertical);
    body.sport = sport;
    body.vertical = sport === 'pro_wrestling' ? 'pro_wrestling' : 'combat';
    body.campaignType = body.campaignType || (sport === 'boxing' ? 'boxing_fight_campaign' : (body.tonight ? 'fight_tonight_campaign' : 'fight_full_campaign'));
    body.includeAll = body.includeAll !== false;
    const result = await createSwarmCampaign({
      config: getSwarmConfig(),
      axios,
      crypto,
      mongoose,
      models,
      body,
      admin: req.admin,
      reason: body.reason || 'admin-created-fight-campaign',
    });
    res.status(202).json({ ok: true, ...result });
  }));

  app.post('/api/admin/swarm/campaigns/fight/full', verifyAdminToken, requireSwarmEnabled, asyncHandler(async (req, res) => {
    const result = await createSwarmCampaign({ config: getSwarmConfig(), axios, crypto, mongoose, models, body: { ...(req.body || {}), campaignType: 'fight_full_campaign', includeAll: true }, admin: req.admin, reason: 'admin-created-full-fight-campaign' });
    res.status(202).json({ ok: true, ...result });
  }));

  app.post('/api/admin/swarm/campaigns/fight/tonight', verifyAdminToken, requireSwarmEnabled, asyncHandler(async (req, res) => {
    const result = await createSwarmCampaign({ config: getSwarmConfig(), axios, crypto, mongoose, models, body: { ...(req.body || {}), campaignType: 'fight_tonight_campaign', includeAll: true, tonight: true }, admin: req.admin, reason: 'admin-created-tonight-fight-campaign' });
    res.status(202).json({ ok: true, ...result });
  }));

  app.post('/api/admin/swarm/campaigns/boxing', verifyAdminToken, requireSwarmEnabled, asyncHandler(async (req, res) => {
    const result = await createSwarmCampaign({ config: getSwarmConfig(), axios, crypto, mongoose, models, body: { ...(req.body || {}), campaignType: 'boxing_fight_campaign', sport: 'boxing', vertical: 'combat', includeAll: req.body?.includeAll !== false }, admin: req.admin, reason: 'admin-created-boxing-campaign' });
    res.status(202).json({ ok: true, ...result });
  }));

  app.post('/api/admin/swarm/campaigns/july-growth', verifyAdminToken, requireSwarmEnabled, asyncHandler(async (req, res) => {
    const body = mergeJulyGrowthCampaignBody(req.body || {});
    const result = await createSwarmCampaign({
      config: getSwarmConfig(),
      axios,
      crypto,
      mongoose,
      models,
      body,
      admin: req.admin,
      reason: body.reason || 'admin-created-july-10000-growth-campaign',
    });
    res.status(202).json({ ok: true, growthConfig: buildJulyGrowthConfig(), ...result });
  }));

  app.get('/api/admin/swarm/events', verifyAdminToken, asyncHandler(async (req, res) => {
    const result = await listLocalAutomationEvents(models, req.query);
    res.json({ ok: true, source: 'backend', ...result });
  }));

  const triggerAutomationEventHandler = asyncHandler(async (req, res) => {
    const trigger = normalizeAutomationTrigger(req.params.trigger || req.body?.trigger);
    if (shouldRunEventAsCampaign(req.body)) {
      const campaignBody = buildCampaignBodyFromEvent({ trigger, body: req.body || {}, admin: req.admin });
      const campaignResult = await createSwarmCampaign({
        config: getSwarmConfig(),
        axios,
        crypto,
        mongoose,
        models,
        body: campaignBody,
        admin: req.admin,
        reason: req.body?.reason || 'admin-triggered-campaign-event',
      });
      return res.status(202).json({ ok: true, trigger, campaignMode: true, ...campaignResult });
    }

    const result = await triggerAutomationEvent({
      config: getSwarmConfig(),
      axios,
      crypto,
      mongoose,
      models,
      admin: req.admin,
      trigger,
      vertical: req.body?.vertical,
      sport: req.body?.sport || req.body?.discipline,
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
    const needsLocalSearch = Boolean(
      cleanString(req.query.search)
      || cleanString(req.query.fightId)
      || cleanString(req.query.matchId)
      || cleanString(req.query.entityId)
      || cleanString(req.query.sourceEntityId)
      || cleanString(req.query.campaignId)
    );
    if (!useCacheOnly && !needsLocalSearch) {
      try {
        const remote = await callSwarm(config, axios, crypto, 'GET', '/internal/v1/jobs', undefined, pickQuery(req.query, ['status', 'vertical', 'jobType', 'campaignId', 'sport', 'page', 'limit']));
        const items = Array.isArray(remote.items) ? remote.items : [];
        await Promise.all(items.map((job) => upsertJobFromSwarm(models, job)));
        return res.json({ ok: true, source: 'swarm', ...remote });
      } catch (error) {
        if (String(req.query.fallbackCache || 'true').toLowerCase() === 'false') throw error;
        const cache = await listLocalJobs(models, req.query);
        return res.status(206).json({ ok: true, source: 'cache', warning: 'Swarm unavailable; returned backend cache.', error: summarizeError(error), ...cache });
      }
    }

    if (!useCacheOnly && needsLocalSearch) {
      try {
        const remote = await callSwarm(config, axios, crypto, 'GET', '/internal/v1/jobs', undefined, pickQuery(req.query, ['status', 'vertical', 'jobType', 'campaignId', 'sport', 'page', 'limit']));
        const items = Array.isArray(remote.items) ? remote.items : [];
        await Promise.all(items.map((job) => upsertJobFromSwarm(models, job)));
      } catch (error) {
        if (String(req.query.fallbackCache || 'true').toLowerCase() === 'false') throw error;
      }
    }

    const cache = await listLocalJobs(models, req.query);
    res.json({ ok: true, source: needsLocalSearch ? 'cache-search' : 'cache', ...cache });
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

  app.get('/api/admin/swarm/jobs/:jobId/summary', verifyAdminToken, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    const jobId = String(req.params.jobId || '').trim();
    let remoteError = null;

    if (config.enabled && String(req.query.source || '').toLowerCase() !== 'cache') {
      try {
        const remote = await callSwarm(config, axios, crypto, 'GET', `/internal/v1/jobs/${encodeURIComponent(jobId)}`);
        const swarmJob = remote.job || remote.data?.job || remote;
        await upsertJobFromSwarm(models, swarmJob);
      } catch (error) {
        remoteError = summarizeError(error);
      }
    }

    const local = await models.SwarmBackendJob.findOne({
      $or: [{ jobId }, { backendCorrelationId: jobId }, { artifactId: jobId }],
    }).lean();

    if (!local && remoteError) {
      return res.status(502).json({ ok: false, code: 'SWARM_JOB_SUMMARY_LOOKUP_FAILED', error: remoteError });
    }
    if (!local) return res.status(404).json({ ok: false, code: 'SWARM_JOB_NOT_FOUND', message: 'Job not found.' });

    const serializedJob = serializeLocalJob(local);
    const campaignId = cleanString(req.query.campaignId || serializedJob.campaignId || local.metadata?.campaignId || local.input?.campaignId || local.sourceEntity?.campaignId);
    const fightId = cleanString(req.query.fightId || req.query.matchId || serializedJob.fightId || serializedJob.matchId || local.metadata?.fightId || local.metadata?.matchId || local.input?.fightId || local.input?.matchId || local.sourceEntity?.fightId || local.sourceEntity?.matchId || local.sourceEntity?.id);
    const artifactOr = [
      { jobId: local.jobId },
      { jobId },
      { 'metadata.jobId': local.jobId },
      { 'metadata.backendCorrelationId': local.backendCorrelationId },
    ];
    if (local.artifactId) artifactOr.push({ artifactId: local.artifactId });
    if (campaignId) artifactOr.push({ 'metadata.campaignId': campaignId });
    if (fightId) {
      artifactOr.push({ 'metadata.fightId': fightId });
      artifactOr.push({ 'metadata.matchId': fightId });
      artifactOr.push({ 'payload.fightId': fightId });
      artifactOr.push({ 'payload.matchId': fightId });
    }

    if (local.artifactId && config.enabled && String(req.query.source || '').toLowerCase() !== 'cache') {
      try {
        const remoteArtifact = await callSwarm(config, axios, crypto, 'GET', `/internal/v1/artifacts/${encodeURIComponent(local.artifactId)}`);
        const swarmArtifact = remoteArtifact.artifact || remoteArtifact.data?.artifact || remoteArtifact;
        if (swarmArtifact?.artifactId) await upsertArtifactFromSwarm(models, swarmArtifact);
      } catch (artifactError) {
        // Keep the job summary usable even when the artifact is not ready or the swarm lookup fails.
      }
    }

    const relatedJobsFilter = campaignId
      ? buildCampaignScopeFilter(campaignId)
      : fightId
        ? buildFightScopeFilter(fightId)
        : null;
    const [artifacts, campaign, relatedJobs] = await Promise.all([
      models.SwarmBackendArtifact.find({ $or: artifactOr.filter(Boolean) }).sort({ updatedAt: -1, createdAt: -1 }).limit(40).lean(),
      campaignId ? models.SwarmBackendCampaign.findOne({ campaignId }).lean() : null,
      relatedJobsFilter ? models.SwarmBackendJob.find(relatedJobsFilter).sort({ createdAt: -1 }).limit(30).lean() : [],
    ]);

    res.json({
      ok: true,
      source: remoteError ? 'cache' : 'swarm-cache',
      job: serializedJob,
      artifacts: artifacts.map(serializeLocalArtifact),
      campaign: serializeLocalCampaign(campaign),
      fightId: fightId || undefined,
      campaignId: campaignId || undefined,
      relatedJobs: relatedJobs.map(serializeLocalJob),
      outputReady: artifacts.length > 0 || Boolean(local.artifactId),
      outputLink: local.artifactId ? `/administration/swarm/jobs/${encodeURIComponent(local.jobId)}#artifact-${encodeURIComponent(local.artifactId)}` : null,
      remoteError,
      generatedAt: new Date().toISOString(),
    });
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
    const requestedArtifactId = cleanString(req.query.artifactId || req.query.id);
    const useCacheOnly = String(req.query.source || '').toLowerCase() === 'cache' || !config.enabled;

    if (requestedArtifactId) {
      let remoteError = null;
      if (!useCacheOnly) {
        try {
          const remote = await callSwarm(config, axios, crypto, 'GET', `/internal/v1/artifacts/${encodeURIComponent(requestedArtifactId)}`);
          const swarmArtifact = remote.artifact || remote.data?.artifact || remote;
          if (swarmArtifact?.artifactId) await upsertArtifactFromSwarm(models, swarmArtifact);
        } catch (error) {
          remoteError = summarizeError(error);
          if (String(req.query.fallbackCache || 'true').toLowerCase() === 'false') throw error;
        }
      }
      const local = await models.SwarmBackendArtifact.findOne({ artifactId: requestedArtifactId }).lean();
      if (!local && remoteError) return res.status(206).json({ ok: true, source: 'cache', warning: 'Swarm unavailable; returned backend cache.', error: remoteError, items: [], pagination: { page: 1, limit: 1, total: 0, pages: 0 } });
      return res.json({ ok: true, source: remoteError ? 'cache' : 'swarm-cache', items: local ? [serializeLocalArtifact(local)] : [], pagination: { page: 1, limit: 1, total: local ? 1 : 0, pages: local ? 1 : 0 }, remoteError });
    }

    const needsLocalSearch = Boolean(
      cleanString(req.query.search)
      || cleanString(req.query.fightId)
      || cleanString(req.query.matchId)
      || cleanString(req.query.entityId)
      || cleanString(req.query.sourceEntityId)
      || cleanString(req.query.campaignId)
    );
    if (!useCacheOnly && !needsLocalSearch) {
      try {
        const remote = await callSwarm(config, axios, crypto, 'GET', '/internal/v1/artifacts', undefined, pickQuery(req.query, ['vertical', 'artifactType', 'reviewStatus', 'campaignId', 'sport', 'jobId', 'page', 'limit']));
        const items = Array.isArray(remote.items) ? remote.items : [];
        await Promise.all(items.map((artifact) => upsertArtifactFromSwarm(models, artifact)));
        return res.json({ ok: true, source: 'swarm', ...remote });
      } catch (error) {
        if (String(req.query.fallbackCache || 'true').toLowerCase() === 'false') throw error;
        const cache = await listLocalArtifacts(models, req.query);
        return res.status(206).json({ ok: true, source: 'cache', warning: 'Swarm unavailable; returned backend cache.', error: summarizeError(error), ...cache });
      }
    }

    if (!useCacheOnly && needsLocalSearch) {
      try {
        const remote = await callSwarm(config, axios, crypto, 'GET', '/internal/v1/artifacts', undefined, pickQuery(req.query, ['vertical', 'artifactType', 'reviewStatus', 'campaignId', 'sport', 'jobId', 'page', 'limit']));
        const items = Array.isArray(remote.items) ? remote.items : [];
        await Promise.all(items.map((artifact) => upsertArtifactFromSwarm(models, artifact)));
      } catch (error) {
        if (String(req.query.fallbackCache || 'true').toLowerCase() === 'false') throw error;
      }
    }

    const cache = await listLocalArtifacts(models, req.query);
    res.json({ ok: true, source: needsLocalSearch ? 'cache-search' : 'cache', ...cache });
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


  app.patch('/api/admin/swarm/artifacts/:artifactId', verifyAdminToken, artifactUpload, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    const artifact = await loadArtifactForReview({ config, axios, crypto, models, artifactId: req.params.artifactId });
    const admin = adminActor(req.admin);
    const patch = await buildArtifactEditPatch({ req, artifact, admin, cloudinary, mongoose, Blog });

    artifact.title = patch.title || artifact.title;
    artifact.summary = patch.summary || artifact.summary;
    artifact.payload = patch.payload || artifact.payload || {};
    artifact.metadata = patch.metadata || artifact.metadata || {};
    artifact.reviewedBy = patch.reviewedBy || artifact.reviewedBy;
    artifact.reviewedAt = patch.reviewedAt || artifact.reviewedAt;
    artifact.reviewReason = patch.reviewReason || artifact.reviewReason;

    if (patch.reviewStatus) artifact.reviewStatus = patch.reviewStatus;
    await artifact.save();

    let remoteUpdate = null;
    if (config.enabled) {
      try {
        remoteUpdate = await updateRemoteArtifact({
          config,
          axios,
          crypto,
          artifactId: artifact.artifactId,
          patch: {
            title: artifact.title,
            summary: artifact.summary,
            payload: artifact.payload,
            metadata: artifact.metadata,
            reviewStatus: artifact.reviewStatus,
          },
        });
        const remoteArtifact = remoteUpdate.artifact || remoteUpdate.data?.artifact;
        if (remoteArtifact?.artifactId) await upsertArtifactFromSwarm(models, remoteArtifact);
      } catch (error) {
        remoteUpdate = { ok: false, warning: 'Artifact was updated in backend cache but remote swarm patch failed.', error: summarizeError(error) };
      }
    }

    const publishedBlog = await updatePublishedBlogFromArtifact({ artifact, Blog });
    await models.SwarmBackendJob.updateOne(
      { jobId: artifact.jobId },
      { $set: { artifactId: artifact.artifactId, updatedAt: new Date() }, $push: { statusHistory: { status: 'artifact_edited', at: new Date(), reason: 'artifact-edited-from-admin' } } },
    ).catch(() => null);

    res.json({ ok: true, artifact: serializeLocalArtifact(artifact), publishedBlog, remoteUpdate: sanitizeSwarmEnvelope(remoteUpdate) });
  }));

  app.post('/api/admin/swarm/artifacts/:artifactId/generate-blog-banner', verifyAdminToken, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    const artifact = await loadArtifactForReview({ config, axios, crypto, models, artifactId: req.params.artifactId });
    const bannerPatch = await buildGeneratedBlogBannerPatch({ artifact, mongoose, admin: req.admin, reason: req.body?.reason || 'admin-generated-blog-banner' });

    artifact.payload = bannerPatch.payload;
    artifact.summary = bannerPatch.summary || artifact.summary;
    artifact.metadata = bannerPatch.metadata;
    artifact.reviewedBy = adminActor(req.admin);
    artifact.reviewedAt = new Date();
    artifact.reviewReason = bannerPatch.reviewReason;
    await artifact.save();

    let remoteUpdate = null;
    if (config.enabled) {
      try {
        remoteUpdate = await updateRemoteArtifact({
          config,
          axios,
          crypto,
          artifactId: artifact.artifactId,
          patch: { payload: artifact.payload, summary: artifact.summary, metadata: artifact.metadata },
        });
        const remoteArtifact = remoteUpdate.artifact || remoteUpdate.data?.artifact;
        if (remoteArtifact?.artifactId) await upsertArtifactFromSwarm(models, remoteArtifact);
      } catch (error) {
        remoteUpdate = { ok: false, warning: 'Generated banner was stored in backend cache but remote swarm patch failed.', error: summarizeError(error) };
      }
    }

    const publishedBlog = await updatePublishedBlogFromArtifact({ artifact, Blog });
    res.json({ ok: true, artifact: serializeLocalArtifact(artifact), publishedBlog, remoteUpdate: sanitizeSwarmEnvelope(remoteUpdate) });
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
    let seoApplication = null;
    if (publish && isSeoArtifact(latest)) {
      seoApplication = await applySeoArtifact({ artifact: latest, Blog, admin, options: { targetBlogId: req.body?.targetBlogId, applyToBlog: req.body?.applyToBlog !== false } });
      latest.reviewStatus = seoApplication.applied ? 'PUBLISHED' : 'APPROVED';
      latest.publishedEntity = seoApplication.entity || latest.publishedEntity;
      if (seoApplication.applied) latest.publishedAt = new Date();
      await models.SwarmBackendJob.updateOne(
        { jobId: latest.jobId },
        { $set: { status: seoApplication.applied ? 'published' : 'approved', artifactId: latest.artifactId, publishedEntity: seoApplication.entity, updatedAt: new Date() }, $push: { statusHistory: { status: seoApplication.applied ? 'published' : 'approved', at: new Date(), reason: seoApplication.applied ? 'seo-artifact-approved-and-applied' : 'seo-artifact-approved-for-review' } } },
      );
    } else if (publish && isBlogArtifact(latest)) {
      await ensureArtifactBlogBanner({ artifact: latest, mongoose, admin: req.admin });
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
    res.json({ ok: true, artifact: serializeLocalArtifact(latest), published, seoApplication, automationEvent, remoteReview: sanitizeSwarmEnvelope(remoteReview) });
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

  app.post('/api/admin/swarm/artifacts/:artifactId/apply-seo', verifyAdminToken, asyncHandler(async (req, res) => {
    const config = getSwarmConfig();
    const artifact = await loadArtifactForReview({ config, axios, crypto, models, artifactId: req.params.artifactId });
    if (!isSeoArtifact(artifact)) return res.status(400).json({ ok: false, code: 'NOT_SEO_ARTIFACT', message: 'Only SEO artifacts can be applied through this endpoint.' });
    const admin = adminActor(req.admin);
    const seoApplication = await applySeoArtifact({ artifact, Blog, admin, options: { targetBlogId: req.body?.targetBlogId, applyToBlog: req.body?.applyToBlog !== false } });
    artifact.reviewStatus = seoApplication.applied ? 'PUBLISHED' : 'APPROVED';
    artifact.reviewedBy = admin;
    artifact.reviewedAt = new Date();
    artifact.publishedEntity = seoApplication.entity || artifact.publishedEntity;
    artifact.publishedAt = seoApplication.applied ? new Date() : artifact.publishedAt;
    await artifact.save();
    await models.SwarmBackendJob.updateOne(
      { jobId: artifact.jobId },
      { $set: { status: seoApplication.applied ? 'published' : 'approved', artifactId: artifact.artifactId, publishedEntity: seoApplication.entity, updatedAt: new Date() }, $push: { statusHistory: { status: seoApplication.applied ? 'published' : 'approved', at: new Date(), reason: seoApplication.applied ? 'seo-application-endpoint' : 'seo-application-no-target' } } },
    );
    res.json({ ok: true, artifact: serializeLocalArtifact(artifact), seoApplication });
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

  const campaignSchema = new mongoose.Schema({
    campaignId: { type: String, index: true, unique: true, required: true },
    campaignType: { type: String, index: true },
    title: String,
    vertical: { type: String, index: true },
    sport: { type: String, index: true },
    mode: String,
    status: { type: String, index: true },
    priority: Number,
    requestedBy: Mixed,
    sourceEntity: Mixed,
    input: Mixed,
    sections: [String],
    automationKeys: [String],
    jobIds: [String],
    counts: Mixed,
    callbackUrl: String,
    backendCorrelationId: { type: String, index: true },
    idempotencyKey: { type: String, index: true, unique: true, sparse: true },
    metadata: Mixed,
    swarmCampaign: Mixed,
    error: Mixed,
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
    SwarmBackendCampaign: mongoose.models.SwarmBackendCampaign || mongoose.model('SwarmBackendCampaign', campaignSchema, 'swarm_backend_campaigns'),
    SwarmBackendWebhookNonce: mongoose.models.SwarmBackendWebhookNonce || mongoose.model('SwarmBackendWebhookNonce', nonceSchema, 'swarm_backend_webhook_nonces'),
  };
}

function parseExternalFightSources() {
  const urls = parseCsv(process.env.EXTERNAL_FIGHT_SOURCE_URLS || process.env.SWARM_EXTERNAL_FIGHT_SOURCE_URLS || '');
  const names = parseCsv(process.env.EXTERNAL_FIGHT_SOURCE_NAMES || process.env.SWARM_EXTERNAL_FIGHT_SOURCE_NAMES || '');
  return urls.map((url, index) => ({
    name: names[index] || `External fight source ${index + 1}`,
    url,
    refreshCadence: 'daily',
    sourceType: 'client_provided_external_fight_link',
  })).filter((source) => source.url);
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
    socialDefaultPlatforms: parseCsv(process.env.SOCIAL_DEFAULT_PLATFORMS || 'x,instagram,facebook'),
    externalFightSources: parseExternalFightSources(),
    dailySocialDraftCount: toInt(process.env.SWARM_DAILY_SOCIAL_DRAFT_COUNT || process.env.DAILY_SOCIAL_DRAFT_COUNT, 3),
    metaSocialConfigured: Boolean(cleanString(process.env.META_APP_ID) || cleanString(process.env.FACEBOOK_PAGE_ID) || cleanString(process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID)),
    twitterConfigured: Boolean(cleanString(process.env.TWITTER_API_KEY) || cleanString(process.env.X_API_KEY)),
    automationEventHooksEnabled: String(process.env.SWARM_AUTOMATION_EVENT_HOOKS_ENABLED || 'true').toLowerCase() !== 'false',
  };
}

function buildJulyGrowthOutputTargets() {
  return {
    instagramPosts: toInt(process.env.GROWTH_DAILY_INSTAGRAM_POSTS, 6),
    facebookPosts: toInt(process.env.GROWTH_DAILY_FACEBOOK_POSTS, 5),
    xPosts: toInt(process.env.GROWTH_DAILY_X_POSTS, 15),
    youtubeVideos: toInt(process.env.GROWTH_DAILY_YOUTUBE_VIDEOS, 2),
    shorts: toInt(process.env.GROWTH_DAILY_SHORTS, 8),
    blogs: toInt(process.env.GROWTH_DAILY_BLOGS, 4),
    stories: toInt(process.env.GROWTH_DAILY_STORIES, 10),
    notifications: toInt(process.env.GROWTH_DAILY_NOTIFICATIONS, 3),
    dailyAssetCap: toInt(process.env.SWARM_DAILY_CONTENT_ASSET_CAP, 60),
  };
}

function buildJulyGrowthConfig() {
  const outputTargets = buildJulyGrowthOutputTargets();
  return {
    enabled: String(process.env.JULY_GROWTH_SYSTEM_ENABLED || 'true').toLowerCase() !== 'false',
    campaignType: 'july_10000_signup_growth_system',
    growthSystem: 'july-10000-signups',
    julySignupGoal: toInt(process.env.JULY_SIGNUP_GOAL, 10000),
    timezone: cleanString(process.env.GROWTH_TIMEZONE) || 'America/New_York',
    outputTargets,
    jobTypes: JULY_10000_GROWTH_JOB_TYPES,
    automationKeys: JULY_10000_GROWTH_AUTOMATION_KEYS,
    requiredYouTubeEndingLine: JULY_10000_REQUIRED_YOUTUBE_CTA,
    brandLogo: {
      url: cleanString(process.env.BRAND_LOGO_URL),
      corner: cleanString(process.env.BRAND_LOGO_CORNER) || 'bottom-right',
      opacity: Number(process.env.BRAND_LOGO_OPACITY || 0.86),
    },
    schedule: {
      calendarUpdate: '8 AM',
      youtubeVideo: '10 AM',
      facebookPost: '12 PM',
      blogAndXThread: '2 PM',
      shortVideos: '5 PM',
      liveContent: '7 PM',
      resultsAndYoutubeRecap: '10 PM',
    },
    safety: {
      autoPublishEnabled: String(process.env.SWARM_AUTO_PUBLISH_ENABLED || 'false').toLowerCase() === 'true',
      socialPublishEnabled: String(process.env.SWARM_SOCIAL_PUBLISH_ENABLED || 'false').toLowerCase() === 'true',
      youtubeUploadEnabled: String(process.env.YOUTUBE_UPLOAD_ENABLED || 'false').toLowerCase() === 'true',
      approvalRequiredByDefault: true,
      backendDoesNotChangeWalletsOrPredictions: true,
    },
  };
}

function buildJulyGrowthInput(rawBody) {
  const raw = isPlainObject(rawBody) ? rawBody : {};
  const input = isPlainObject(raw.input) ? raw.input : {};
  const config = buildJulyGrowthConfig();
  const topic = cleanString(raw.topic || input.topic || raw.title || input.title) || 'Fantasy MMadness July 10,000 signup growth system';
  return {
    ...input,
    topic,
    title: cleanString(raw.title || input.title) || topic,
    sport: normalizeSport(raw.sport || input.sport || raw.discipline || input.discipline || 'combat'),
    discipline: normalizeSport(raw.discipline || input.discipline || raw.sport || input.sport || 'combat'),
    signupGoal: toInt(raw.signupGoal || input.signupGoal, config.julySignupGoal),
    growthSystem: config.growthSystem,
    timezone: cleanString(raw.timezone || input.timezone) || config.timezone,
    dailyOutputTargets: { ...config.outputTargets, ...(isPlainObject(raw.dailyOutputTargets) ? raw.dailyOutputTargets : {}), ...(isPlainObject(input.dailyOutputTargets) ? input.dailyOutputTargets : {}) },
    requiredYouTubeEndingLine: cleanString(raw.requiredYouTubeEndingLine || input.requiredYouTubeEndingLine) || config.requiredYouTubeEndingLine,
    brandLogo: { ...config.brandLogo, ...(isPlainObject(raw.brandLogo) ? raw.brandLogo : {}), ...(isPlainObject(input.brandLogo) ? input.brandLogo : {}) },
    publishingSchedule: config.schedule,
    approvalMode: 'approval-first',
  };
}

function mergeJulyGrowthBody(rawBody) {
  const raw = isPlainObject(rawBody) ? rawBody : {};
  const growthInput = buildJulyGrowthInput(raw);
  return {
    ...raw,
    title: raw.title || growthInput.title,
    topic: raw.topic || growthInput.topic,
    vertical: 'combat',
    sport: growthInput.sport || 'combat',
    mode: normalizeMode(raw.mode || 'APPROVAL_REQUIRED'),
    sourceEntity: raw.sourceEntity || { type: 'growth_campaign', id: 'july-10000-signups', label: growthInput.title, origin: 'backend_july_growth_system' },
    input: growthInput,
    metadata: {
      ...(isPlainObject(raw.metadata) ? raw.metadata : {}),
      growthSystem: 'july-10000-signups',
      julySignupGoal: growthInput.signupGoal,
      requiredYouTubeEndingLine: growthInput.requiredYouTubeEndingLine,
      submittedFrom: 'backend-july-growth-system',
    },
  };
}

function mergeJulyGrowthCampaignBody(rawBody) {
  const raw = mergeJulyGrowthBody(rawBody);
  return {
    ...raw,
    campaignType: 'july_10000_signup_growth_system',
    title: raw.title || 'Fantasy MMadness July 10,000 signup growth system',
    includeAll: raw.includeAll !== false,
    sections: normalizeCampaignSections(raw.sections) || ['content', 'seo', 'social', 'media', 'analytics', 'notification', 'data'],
    automationKeys: normalizeStringArray(raw.automationKeys) || JULY_10000_GROWTH_AUTOMATION_KEYS,
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
  const sport = normalizeSport(raw.sport || raw.discipline || raw.combatSport || raw.category || raw.vertical || raw.gameMode);
  const vertical = normalizeVertical(raw.vertical || raw.gameMode || raw.domain || sport);
  if (!DEFAULT_VERTICALS.has(vertical)) throw httpError(400, 'INVALID_SWARM_VERTICAL', 'vertical must be combat or pro_wrestling. Use sport=boxing for Boxing campaigns.');

  const jobType = String(raw.jobType || inferJobType(raw, vertical)).trim();
  if (!DEFAULT_JOB_TYPES.has(jobType)) throw httpError(400, 'INVALID_SWARM_JOB_TYPE', 'Unsupported swarm jobType.');

  const mode = normalizeMode(raw.mode || raw.statusMode || raw.publishMode || config.defaultMode || 'DRAFT_ONLY');
  if (!DEFAULT_MODES.has(mode)) throw httpError(400, 'INVALID_SWARM_MODE', 'Unsupported swarm mode.');

  const priority = clamp(toInt(raw.priority, 50), 0, 100);
  const input = normalizeInput(raw);
  input.sport = normalizeSport(input.sport || input.discipline || sport || vertical);
  input.discipline = input.discipline || input.sport;
  const scopeFightId = cleanString(input.fightId || input.matchId || raw.fightId || raw.matchId || raw.sourceEntity?.id || raw.sourceEntity?.fightId || raw.sourceEntity?.matchId);
  if (scopeFightId) {
    input.fightId = input.fightId || scopeFightId;
    input.matchId = input.matchId || scopeFightId;
  }
  const sourceEntity = { ...normalizeSourceEntity(raw, input, vertical, jobType) };
  if (scopeFightId) {
    sourceEntity.id = sourceEntity.id || scopeFightId;
    sourceEntity.fightId = sourceEntity.fightId || scopeFightId;
    sourceEntity.matchId = sourceEntity.matchId || scopeFightId;
  }

  return {
    vertical,
    sport: input.sport,
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
      ...(scopeFightId ? { fightId: scopeFightId, matchId: scopeFightId, sourceEntityId: scopeFightId } : {}),
      sport: input.sport,
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
  if (cleanString(input.growthSystem) || String(jobType || '').includes('growth') || String(jobType || '').includes('july-10000')) return 'growth_campaign';
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
  ['topic', 'title', 'prompt', 'keywords', 'fighters', 'wrestlers', 'eventName', 'matchName', 'blogTitle', 'matchId', 'fightId', 'eventId', 'blogId', 'contestId', 'fighterId', 'wrestlerId', 'fighterA', 'fighterB', 'competitorA', 'competitorB', 'platforms', 'sport', 'discipline', 'campaignId', 'campaignType', 'automationKey', 'targetOutput'].forEach((key) => {
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


async function updateRemoteArtifact({ config, axios, crypto, artifactId, patch }) {
  return callSwarm(config, axios, crypto, 'PATCH', `/internal/v1/artifacts/${encodeURIComponent(artifactId)}`, patch || {});
}

function parseJsonField(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch (_error) { return fallback; }
}

function isTruthyFormValue(value) {
  return ['true', '1', 'yes', 'y', 'on'].includes(String(value || '').trim().toLowerCase());
}

async function uploadSwarmArtifactImage({ file, cloudinary, folder = 'swarm/blog-banners' }) {
  if (!file?.buffer || !cloudinary?.uploader?.upload_stream) return null;
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream({ folder }, (error, result) => {
      if (error) return reject(error);
      return resolve({ url: result.secure_url, publicId: result.public_id });
    }).end(file.buffer);
  });
}

async function buildArtifactEditPatch({ req, artifact, admin, cloudinary, mongoose, Blog }) {
  const body = req.body || {};
  const existingPayload = artifact.payload || {};
  const nextPayload = { ...existingPayload };
  const title = cleanString(body.title) || cleanString(body.header) || cleanString(body.metaTitle) || artifact.title;
  const summary = cleanString(body.summary) || cleanString(body.metaDescription) || artifact.summary;

  if (body.metaTitle !== undefined) nextPayload.metaTitle = cleanString(body.metaTitle);
  if (body.metaDescription !== undefined) nextPayload.metaDescription = cleanString(body.metaDescription);
  if (body.header !== undefined) nextPayload.header = cleanString(body.header);
  if (body.blogHeaderImageUrl !== undefined) nextPayload.blogHeaderImage = cleanString(body.blogHeaderImageUrl);
  if (body.blogHeaderImageAlt !== undefined) nextPayload.blogHeaderImageAlt = cleanString(body.blogHeaderImageAlt);
  if (body.blogImagePrompt !== undefined) nextPayload.blogImagePrompt = cleanString(body.blogImagePrompt);
  if (body.tags !== undefined) nextPayload.tags = parseJsonField(body.tags, normalizeStringArray(body.tags) || nextPayload.tags || []);

  const parsedSections = parseJsonField(body.sections, undefined);
  if (Array.isArray(parsedSections)) nextPayload.sections = normalizeBlogSections(parsedSections);

  const headerImageFile = req.files?.blogHeaderImage?.[0];
  const uploadedHeader = await uploadSwarmArtifactImage({ file: headerImageFile, cloudinary });
  if (uploadedHeader?.url) {
    nextPayload.blogHeaderImage = uploadedHeader.url;
    nextPayload.blogHeaderImagePublicId = uploadedHeader.publicId;
    nextPayload.blogImage = {
      ...(isPlainObject(nextPayload.blogImage) ? nextPayload.blogImage : {}),
      url: uploadedHeader.url,
      publicId: uploadedHeader.publicId,
      source: 'admin_upload',
      updatedAt: new Date().toISOString(),
    };
  }

  if (isTruthyFormValue(body.generateBanner)) {
    const generated = await buildGeneratedBlogBannerPayload({ artifact: { ...artifact.toObject?.() || artifact, payload: nextPayload }, mongoose });
    Object.assign(nextPayload, generated.payload);
  }

  const nextMetadata = {
    ...(artifact.metadata || {}),
    lastEditedAt: new Date().toISOString(),
    lastEditedBy: admin,
    editableFromAdmin: true,
  };

  const resetReview = isTruthyFormValue(body.resetReview);
  return {
    title,
    summary,
    payload: nextPayload,
    metadata: nextMetadata,
    reviewStatus: resetReview ? 'AWAITING_REVIEW' : undefined,
    reviewedBy: admin,
    reviewedAt: new Date(),
    reviewReason: cleanString(body.reason) || 'artifact-edited-from-admin',
  };
}

async function ensureArtifactBlogBanner({ artifact, mongoose, admin }) {
  if (!artifact || !isBlogArtifact(artifact)) return artifact;
  const payload = artifact.payload || {};
  if (cleanString(payload.blogHeaderImage) || cleanString(payload.blogImage?.url)) return artifact;
  const patch = await buildGeneratedBlogBannerPatch({ artifact, mongoose, admin, reason: 'auto-generated-banner-before-blog-publish' });
  artifact.payload = patch.payload;
  artifact.metadata = patch.metadata;
  artifact.summary = patch.summary || artifact.summary;
  return artifact;
}

async function buildGeneratedBlogBannerPatch({ artifact, mongoose, admin, reason }) {
  const generated = await buildGeneratedBlogBannerPayload({ artifact, mongoose });
  return {
    payload: generated.payload,
    metadata: {
      ...(artifact.metadata || {}),
      blogBannerGeneratedAt: new Date().toISOString(),
      blogBannerGeneratedBy: adminActor(admin),
      blogBannerGenerationMode: generated.mode,
      editableFromAdmin: true,
    },
    summary: artifact.summary || generated.payload.metaDescription || generated.payload.header || artifact.title,
    reviewReason: reason || 'blog-banner-generated',
  };
}

async function buildGeneratedBlogBannerPayload({ artifact, mongoose }) {
  const payload = { ...(artifact.payload || {}) };
  const fight = await loadFightContextForArtifact({ artifact, mongoose });
  const title = cleanString(payload.header || payload.metaTitle || artifact.title || fight?.title || 'Fantasy MMADNESS Fight Card');
  const fighterAName = cleanString(fight?.fighterAName || payload.fighterAName || payload.fighterA || payload.matchFighterA || 'Fighter A');
  const fighterBName = cleanString(fight?.fighterBName || payload.fighterBName || payload.fighterB || payload.matchFighterB || 'Fighter B');
  const fighterAImage = cleanString(fight?.fighterAImage || payload.fighterAImage || payload.fighterAImageUrl || payload.sourceImages?.[0]);
  const fighterBImage = cleanString(fight?.fighterBImage || payload.fighterBImage || payload.fighterBImageUrl || payload.sourceImages?.[1]);
  const category = cleanString(fight?.category || payload.sport || payload.discipline || artifact.vertical || 'combat');
  const bannerPrompt = buildBlogBannerPrompt({ title, fighterAName, fighterBName, category, fighterAImage, fighterBImage });
  const bannerDataUri = buildSvgFightBannerDataUri({ title, fighterAName, fighterBName, category, fighterAImage, fighterBImage });
  payload.blogHeaderImage = payload.blogHeaderImage || bannerDataUri;
  payload.blogHeaderImageAlt = payload.blogHeaderImageAlt || `${fighterAName} vs ${fighterBName} Fantasy MMADNESS fight-card banner`;
  payload.blogImagePrompt = payload.blogImagePrompt || bannerPrompt;
  payload.blogImage = {
    ...(isPlainObject(payload.blogImage) ? payload.blogImage : {}),
    url: payload.blogHeaderImage,
    alt: payload.blogHeaderImageAlt,
    prompt: bannerPrompt,
    source: 'backend_generated_svg_from_fighter_images',
    sourceImageUrls: [fighterAImage, fighterBImage].filter(Boolean),
    bannerText: `${fighterAName} vs ${fighterBName}`,
    category,
    generatedAt: new Date().toISOString(),
  };
  payload.fighterAName = payload.fighterAName || fighterAName;
  payload.fighterBName = payload.fighterBName || fighterBName;
  if (fighterAImage) payload.fighterAImage = payload.fighterAImage || fighterAImage;
  if (fighterBImage) payload.fighterBImage = payload.fighterBImage || fighterBImage;
  return { payload, mode: 'svg_fighter_banner' };
}

async function loadFightContextForArtifact({ artifact, mongoose }) {
  const payload = artifact.payload || {};
  const metadata = artifact.metadata || {};
  let job = null;
  try {
    const JobModel = mongoose.models.SwarmBackendJob;
    if (JobModel && artifact.jobId) job = await JobModel.findOne({ jobId: artifact.jobId }).lean();
  } catch (_error) {}
  const source = job?.sourceEntity || {};
  const input = job?.input || {};
  const rawId = cleanString(metadata.fightId || metadata.matchId || payload.fightId || payload.matchId || input.fightId || input.matchId || source.fightId || source.matchId || source.id);
  const fallback = {
    title: cleanString(payload.matchTitle || payload.eventName || payload.header || artifact.title),
    fighterAName: cleanString(payload.fighterAName || payload.matchFighterA || input.fighterAName || input.matchFighterA),
    fighterBName: cleanString(payload.fighterBName || payload.matchFighterB || input.fighterBName || input.matchFighterB),
    fighterAImage: cleanString(payload.fighterAImage || input.fighterAImage || payload.sourceImages?.[0]),
    fighterBImage: cleanString(payload.fighterBImage || input.fighterBImage || payload.sourceImages?.[1]),
    category: cleanString(payload.sport || input.sport || metadata.sport),
  };
  if (!rawId || !mongoose.isValidObjectId(rawId)) return fallback;

  const Match = mongoose.models.Match;
  const Shadow = mongoose.models.Shadow;
  const ProWrestlingMatch = mongoose.models.ProWrestlingMatch;
  let fight = null;
  try {
    if (Match) fight = await Match.findById(rawId).populate('fighterAId fighterBId').lean();
    if (!fight && Shadow) fight = await Shadow.findById(rawId).populate('fighterAId fighterBId').lean();
    if (!fight && ProWrestlingMatch) fight = await ProWrestlingMatch.findById(rawId).lean();
  } catch (_error) {}
  if (!fight) return fallback;

  const fighterARef = isPlainObject(fight.fighterAId) ? fight.fighterAId : null;
  const fighterBRef = isPlainObject(fight.fighterBId) ? fight.fighterBId : null;
  return {
    title: cleanString(fight.matchName || fight.eventName || fight.title || fallback.title),
    fighterAName: cleanString(fighterARef?.displayName || fight.matchFighterA || fight.fighterAName || fallback.fighterAName),
    fighterBName: cleanString(fighterBRef?.displayName || fight.matchFighterB || fight.fighterBName || fallback.fighterBName),
    fighterAImage: cleanString(fighterARef?.primaryImage || fight.fighterAImage || fallback.fighterAImage),
    fighterBImage: cleanString(fighterBRef?.primaryImage || fight.fighterBImage || fallback.fighterBImage),
    category: cleanString(fight.matchCategoryTwo || fight.matchCategory || fight.sport || fallback.category),
  };
}

function buildBlogBannerPrompt({ title, fighterAName, fighterBName, category, fighterAImage, fighterBImage }) {
  return [
    `Create a premium Fantasy MMADNESS blog banner for ${title}.`,
    `Main matchup: ${fighterAName} vs ${fighterBName}.`,
    `Discipline: ${category}.`,
    'Use a dark arena background, red/blue fight lighting, cinematic contrast, strong sports-poster composition, and space for the blog headline.',
    fighterAImage ? `Use Fighter A reference image URL as the primary left-side source: ${fighterAImage}` : '',
    fighterBImage ? `Use Fighter B reference image URL as the primary right-side source: ${fighterBImage}` : '',
    'Do not change the fight rules, names, result, odds, wallet values, or scoring claims. Keep the visual promotional only.',
  ].filter(Boolean).join(' ');
}

function xmlEscape(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeSvgImageUrl(value) {
  const url = cleanString(value);
  if (!/^https?:\/\//i.test(url)) return '';
  return url.replace(/"/g, '%22');
}

function buildSvgFightBannerDataUri({ title, fighterAName, fighterBName, category, fighterAImage, fighterBImage }) {
  const aImg = safeSvgImageUrl(fighterAImage);
  const bImg = safeSvgImageUrl(fighterBImage);
  const headline = `${fighterAName} vs ${fighterBName}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#02060d"/><stop offset="0.48" stop-color="#07101d"/><stop offset="1" stop-color="#25040a"/></linearGradient>
    <radialGradient id="red" cx="76%" cy="24%" r="64%"><stop offset="0" stop-color="#df111b" stop-opacity="0.62"/><stop offset="1" stop-color="#df111b" stop-opacity="0"/></radialGradient>
    <radialGradient id="blue" cx="22%" cy="28%" r="58%"><stop offset="0" stop-color="#1d9bf0" stop-opacity="0.55"/><stop offset="1" stop-color="#1d9bf0" stop-opacity="0"/></radialGradient>
    <filter id="shadow"><feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#000" flood-opacity="0.65"/></filter>
  </defs>
  <rect width="1600" height="900" fill="url(#bg)"/>
  <rect width="1600" height="900" fill="url(#blue)"/>
  <rect width="1600" height="900" fill="url(#red)"/>
  <g opacity="0.22" stroke="#fff" stroke-width="1">${Array.from({ length: 18 }).map((_, i) => `<path d="M${i * 95} 0V900"/>`).join('')}${Array.from({ length: 10 }).map((_, i) => `<path d="M0 ${i * 95}H1600"/>`).join('')}</g>
  ${aImg ? `<image href="${aImg}" x="70" y="120" width="560" height="660" preserveAspectRatio="xMidYMid slice" opacity="0.92" filter="url(#shadow)"/>` : ''}
  ${bImg ? `<image href="${bImg}" x="970" y="120" width="560" height="660" preserveAspectRatio="xMidYMid slice" opacity="0.92" filter="url(#shadow)"/>` : ''}
  <rect x="0" y="0" width="1600" height="900" fill="rgba(0,0,0,0.18)"/>
  <circle cx="800" cy="444" r="86" fill="#e50914" stroke="#fff" stroke-opacity="0.18" stroke-width="3"/>
  <text x="800" y="462" text-anchor="middle" font-family="Impact, Arial Black, sans-serif" font-size="54" fill="#fff">VS</text>
  <text x="800" y="90" text-anchor="middle" font-family="Arial, sans-serif" font-size="28" fill="#f51b2b" letter-spacing="8">FANTASY MMADNESS</text>
  <text x="800" y="735" text-anchor="middle" font-family="Impact, Arial Black, sans-serif" font-size="78" fill="#ffffff">${xmlEscape(headline).slice(0, 80)}</text>
  <text x="800" y="798" text-anchor="middle" font-family="Arial, sans-serif" font-size="28" fill="#b8c0cc" letter-spacing="4">${xmlEscape(category).toUpperCase()} • FIGHT CARD ARTICLE</text>
  <text x="800" y="848" text-anchor="middle" font-family="Arial, sans-serif" font-size="25" fill="#f51b2b">${xmlEscape(title).slice(0, 110)}</text>
</svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

async function updatePublishedBlogFromArtifact({ artifact, Blog }) {
  if (!Blog || !artifact?.publishedEntity?.id) return null;
  const blog = await Blog.findById(artifact.publishedEntity.id).catch(() => null);
  if (!blog) return null;
  const blogData = mapArtifactToBlog(artifact.payload || {}, artifact);
  if (blogData.metaTitle) blog.metaTitle = blogData.metaTitle;
  if (blogData.metaDescription) blog.metaDescription = blogData.metaDescription;
  if (blogData.header) blog.header = blogData.header;
  if (blogData.blogHeaderImage) blog.blogHeaderImage = blogData.blogHeaderImage;
  if (blogData.blogHeaderImagePublicId) blog.blogHeaderImagePublicId = blogData.blogHeaderImagePublicId;
  if (Array.isArray(blogData.sections) && blogData.sections.length) blog.sections = blogData.sections;
  await blog.save();
  return { id: String(blog._id), metaTitle: blog.metaTitle, updated: true };
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
    blogHeaderImage: cleanString(payload.blogHeaderImage) || cleanString(payload.blogImage?.url) || cleanString(payload.generatedImageUrl) || cleanString(payload.image) || '',
    blogHeaderImagePublicId: cleanString(payload.blogHeaderImagePublicId) || cleanString(payload.blogImage?.publicId) || '',
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

function getScopedFightId(query = {}) {
  return cleanString(query.fightId || query.matchId || query.entityId || query.sourceEntityId || query.sourceId);
}

function buildFightScopeFilter(scopeId) {
  if (!scopeId) return null;
  return { $or: [
    { 'input.fightId': scopeId },
    { 'input.matchId': scopeId },
    { 'input.id': scopeId },
    { 'input._id': scopeId },
    { 'metadata.fightId': scopeId },
    { 'metadata.matchId': scopeId },
    { 'metadata.sourceEntityId': scopeId },
    { 'metadata.sourceFightId': scopeId },
    { 'sourceEntity.id': scopeId },
    { 'sourceEntity.fightId': scopeId },
    { 'sourceEntity.matchId': scopeId },
    { 'swarmJob.input.fightId': scopeId },
    { 'swarmJob.input.matchId': scopeId },
    { 'swarmJob.metadata.fightId': scopeId },
    { 'swarmJob.metadata.matchId': scopeId },
    { 'swarmJob.sourceEntity.id': scopeId },
    { 'swarmJob.sourceEntity.fightId': scopeId },
    { 'swarmJob.sourceEntity.matchId': scopeId },
  ] };
}

function buildCampaignScopeFilter(campaignId) {
  if (!campaignId) return null;
  return { $or: [
    { 'metadata.campaignId': campaignId },
    { 'input.campaignId': campaignId },
    { 'sourceEntity.campaignId': campaignId },
    { 'swarmJob.campaignId': campaignId },
    { 'swarmJob.metadata.campaignId': campaignId },
    { backendCorrelationId: campaignId },
  ] };
}

function buildArtifactFightScopeFilter(scopeId, relatedJobIds = [], relatedArtifactIds = []) {
  if (!scopeId) return null;
  const or = [
    { 'metadata.fightId': scopeId },
    { 'metadata.matchId': scopeId },
    { 'metadata.sourceEntityId': scopeId },
    { 'payload.fightId': scopeId },
    { 'payload.matchId': scopeId },
    { 'payload.id': scopeId },
    { 'provenance.fightId': scopeId },
    { 'provenance.matchId': scopeId },
    { 'swarmArtifact.metadata.fightId': scopeId },
    { 'swarmArtifact.metadata.matchId': scopeId },
    { 'swarmArtifact.payload.fightId': scopeId },
    { 'swarmArtifact.payload.matchId': scopeId },
  ];
  if (relatedJobIds.length) or.push({ jobId: { $in: relatedJobIds } });
  if (relatedArtifactIds.length) or.push({ artifactId: { $in: relatedArtifactIds } });
  return { $or: or };
}

async function listLocalJobs(models, query) {
  const page = clamp(toInt(query.page, 1), 1, 100000);
  const limit = clamp(toInt(query.limit, 25), 1, 100);
  const filter = {};
  const andFilters = [];
  if (query.status) filter.status = query.status;
  if (query.vertical) filter.vertical = normalizeVertical(query.vertical);
  if (query.jobType) filter.jobType = query.jobType;
  const campaignScope = buildCampaignScopeFilter(cleanString(query.campaignId));
  if (campaignScope) andFilters.push(campaignScope);
  const fightScope = buildFightScopeFilter(getScopedFightId(query));
  if (fightScope) andFilters.push(fightScope);
  if (query.sport) filter['metadata.sport'] = normalizeSport(query.sport);
  if (query.search) {
    const search = String(query.search).trim();
    const searchRegex = new RegExp(escapeRegExp(search), 'i');
    andFilters.push({ $or: [
      { jobId: searchRegex },
      { backendCorrelationId: searchRegex },
      { artifactId: searchRegex },
      { jobType: searchRegex },
      { status: searchRegex },
      { 'metadata.campaignId': searchRegex },
      { 'metadata.fightId': searchRegex },
      { 'metadata.matchId': searchRegex },
      { 'input.title': searchRegex },
      { 'input.topic': searchRegex },
      { 'input.fightId': searchRegex },
      { 'input.matchId': searchRegex },
      { 'sourceEntity.id': searchRegex },
      { 'sourceEntity.label': searchRegex },
    ] });
  }
  if (andFilters.length) filter.$and = andFilters;
  const [rows, total] = await Promise.all([
    models.SwarmBackendJob.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    models.SwarmBackendJob.countDocuments(filter),
  ]);
  return { items: rows.map(serializeLocalJob), pagination: { page, limit, total, pages: Math.ceil(total / limit) }, scope: { fightId: getScopedFightId(query) || undefined, campaignId: cleanString(query.campaignId) || undefined } };
}

async function listLocalArtifacts(models, query) {
  const page = clamp(toInt(query.page, 1), 1, 100000);
  const limit = clamp(toInt(query.limit, 25), 1, 100);
  const filter = {};
  const andFilters = [];
  if (query.vertical) filter.vertical = normalizeVertical(query.vertical);
  if (query.artifactType) filter.artifactType = query.artifactType;
  if (query.reviewStatus) filter.reviewStatus = String(query.reviewStatus).toUpperCase();
  const campaignId = cleanString(query.campaignId);
  if (campaignId) andFilters.push({ $or: [
    { 'metadata.campaignId': campaignId },
    { 'payload.campaignId': campaignId },
    { 'swarmArtifact.metadata.campaignId': campaignId },
    { 'swarmArtifact.payload.campaignId': campaignId },
  ] });
  if (query.sport) filter['metadata.sport'] = normalizeSport(query.sport);
  if (query.artifactId) andFilters.push({ artifactId: String(query.artifactId) });
  if (query.jobId) andFilters.push({ jobId: String(query.jobId) });

  const scopeId = getScopedFightId(query);
  if (scopeId) {
    const scopedJobs = await models.SwarmBackendJob.find(buildFightScopeFilter(scopeId)).select('jobId artifactId').limit(1000).lean();
    const relatedJobIds = scopedJobs.map((job) => job.jobId).filter(Boolean);
    const relatedArtifactIds = scopedJobs.map((job) => job.artifactId).filter(Boolean);
    const fightScope = buildArtifactFightScopeFilter(scopeId, relatedJobIds, relatedArtifactIds);
    if (fightScope) andFilters.push(fightScope);
  }

  if (query.search) {
    const search = String(query.search).trim();
    const searchRegex = new RegExp(escapeRegExp(search), 'i');
    andFilters.push({ $or: [
      { artifactId: searchRegex },
      { jobId: searchRegex },
      { jobType: searchRegex },
      { artifactType: searchRegex },
      { title: searchRegex },
      { summary: searchRegex },
      { reviewStatus: searchRegex },
      { 'metadata.campaignId': searchRegex },
      { 'metadata.fightId': searchRegex },
      { 'metadata.matchId': searchRegex },
      { 'payload.title': searchRegex },
      { 'payload.metaTitle': searchRegex },
      { 'payload.headline': searchRegex },
      { 'payload.fightId': searchRegex },
      { 'payload.matchId': searchRegex },
    ] });
  }
  if (andFilters.length) filter.$and = andFilters;
  const [rows, total] = await Promise.all([
    models.SwarmBackendArtifact.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    models.SwarmBackendArtifact.countDocuments(filter),
  ]);
  return { items: rows.map(serializeLocalArtifact), pagination: { page, limit, total, pages: Math.ceil(total / limit) }, scope: { fightId: scopeId || undefined, campaignId: campaignId || undefined } };
}

async function listLocalCampaigns(models, query) {
  const page = clamp(toInt(query?.page, 1), 1, 100000);
  const limit = clamp(toInt(query?.limit, 25), 1, 100);
  const filter = {};
  const andFilters = [];
  if (query?.status) filter.status = String(query.status);
  if (query?.campaignType) filter.campaignType = normalizeCampaignType(query.campaignType);
  if (query?.vertical) filter.vertical = normalizeVertical(query.vertical);
  if (query?.sport) filter.sport = normalizeSport(query.sport);
  const campaignId = cleanString(query?.campaignId);
  if (campaignId) andFilters.push({ $or: [{ campaignId }, { backendCorrelationId: campaignId }, { 'metadata.campaignId': campaignId }] });
  const scopeId = getScopedFightId(query || {});
  if (scopeId) andFilters.push({ $or: [
    { 'input.fightId': scopeId },
    { 'input.matchId': scopeId },
    { 'metadata.fightId': scopeId },
    { 'metadata.matchId': scopeId },
    { 'metadata.sourceEntityId': scopeId },
    { 'sourceEntity.id': scopeId },
    { 'sourceEntity.fightId': scopeId },
    { 'sourceEntity.matchId': scopeId },
    { 'swarmCampaign.input.fightId': scopeId },
    { 'swarmCampaign.input.matchId': scopeId },
  ] });
  if (query?.search) {
    const search = String(query.search).trim();
    const searchRegex = new RegExp(escapeRegExp(search), 'i');
    andFilters.push({ $or: [
      { campaignId: searchRegex },
      { campaignType: searchRegex },
      { title: searchRegex },
      { sport: searchRegex },
      { status: searchRegex },
      { 'input.title': searchRegex },
      { 'input.topic': searchRegex },
      { 'input.fightId': searchRegex },
      { 'input.matchId': searchRegex },
      { 'metadata.fightId': searchRegex },
      { 'metadata.matchId': searchRegex },
      { 'sourceEntity.id': searchRegex },
      { 'sourceEntity.label': searchRegex },
    ] });
  }
  if (andFilters.length) filter.$and = andFilters;
  const [rows, total] = await Promise.all([
    models.SwarmBackendCampaign.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    models.SwarmBackendCampaign.countDocuments(filter),
  ]);
  return { items: rows.map(serializeLocalCampaign), pagination: { page, limit, total, pages: Math.ceil(total / limit) }, scope: { fightId: scopeId || undefined, campaignId: campaignId || undefined } };
}

async function getCacheStats(models) {
  const [jobs, artifacts, awaitingReview, failedJobs, automationEvents, failedAutomationEvents, campaigns, activeCampaigns] = await Promise.all([
    models.SwarmBackendJob.countDocuments(),
    models.SwarmBackendArtifact.countDocuments(),
    models.SwarmBackendArtifact.countDocuments({ reviewStatus: { $in: ['DRAFT', 'AWAITING_REVIEW'] } }),
    models.SwarmBackendJob.countDocuments({ status: { $in: ['failed', 'dead_letter', 'failed_to_submit'] } }),
    models.SwarmBackendAutomationEvent.countDocuments(),
    models.SwarmBackendAutomationEvent.countDocuments({ status: 'failed' }),
    models.SwarmBackendCampaign.countDocuments(),
    models.SwarmBackendCampaign.countDocuments({ status: { $in: ['created', 'queued', 'running', 'awaiting_review', 'partially_failed', 'submitting'] } }),
  ]);
  return { jobs, artifacts, awaitingReview, failedJobs, automationEvents, failedAutomationEvents, campaigns, activeCampaigns };
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
  if (Array.isArray(raw.items)) {
    return {
      items: raw.items.map((item) => ({ ...item, updatedBy: item.updatedBy || adminActor(admin) })),
    };
  }

  const items = [];
  const automations = isPlainObject(raw.automations) ? raw.automations : {};
  for (const [key, value] of Object.entries(automations)) {
    if (!isPlainObject(value)) continue;
    items.push({
      key,
      enabled: value.enabled,
      mode: value.mode || value.defaultMode,
      approvalRequired: value.approvalRequired ?? value.requiresApproval,
      autoPublishAllowed: value.autoPublishAllowed ?? value.allowAutoPublish,
      socialPublishAllowed: value.socialPublishAllowed ?? value.allowSocialPublish,
      config: value.config,
      updatedBy: value.updatedBy || adminActor(admin),
    });
  }

  return {
    items,
    updatedBy: raw.updatedBy || adminActor(admin),
    reason: cleanString(raw.reason) || 'backend-admin-settings-update',
  };
}

function buildSettingsFromAutomationItems(items) {
  const automations = {};
  for (const item of Array.isArray(items) ? items : []) {
    const key = cleanString(item?.key || item?.jobType || item?.id);
    if (!key) continue;
    automations[key] = {
      enabled: item?.setting?.enabled ?? item?.enabled ?? item?.enabledByDefault ?? false,
      defaultMode: item?.setting?.mode || item?.mode || item?.defaultMode || 'DRAFT_ONLY',
      requiresApproval: item?.setting?.approvalRequired ?? item?.requiresApproval ?? true,
      allowAutomatedExecution: item?.supportsAutoMode === true,
      allowAutoPublish: item?.setting?.autoPublishAllowed ?? item?.autoPublishAllowed ?? false,
      allowSocialPublish: item?.setting?.socialPublishAllowed ?? item?.socialPublishAllowed ?? false,
      priority: item?.setting?.priority ?? 50,
      maxAttempts: item?.setting?.maxAttempts ?? 3,
      triggers: item?.trigger ? [item.trigger] : [],
      notes: item?.description || item?.label || key,
    };
  }
  return {
    settingsId: 'swarm-automation-settings',
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

function shouldRunEventAsCampaign(body) {
  const raw = isPlainObject(body) ? body : {};
  return Boolean(
    raw.campaignType
    || raw.includeAll === true
    || raw.allAgents === true
    || raw.runAllAgents === true
    || raw.runAsCampaign === true
    || raw.allOfTheAbove === true
    || (Array.isArray(raw.sections) && raw.sections.length > 1)
    || (Array.isArray(raw.automationKeys) && raw.automationKeys.length > 1)
  );
}

function buildCampaignBodyFromEvent({ trigger, body, admin }) {
  const raw = isPlainObject(body) ? body : {};
  const input = isPlainObject(raw.input) ? raw.input : (isPlainObject(raw.context) ? raw.context : {});
  const sport = normalizeSport(raw.sport || raw.discipline || input.sport || input.discipline || raw.vertical || raw.gameMode);
  const campaignType = normalizeCampaignType(raw.campaignType || inferCampaignTypeForTrigger(trigger, sport));
  return {
    campaignType,
    title: cleanString(raw.title) || cleanString(input.title) || cleanString(input.matchName) || cleanString(input.eventName) || cleanString(input.blogTitle) || undefined,
    vertical: normalizeVertical(raw.vertical || raw.gameMode || sport || inferVerticalForTrigger(trigger)),
    sport,
    mode: normalizeMode(raw.mode || raw.publishMode || raw.statusMode || 'APPROVAL_REQUIRED'),
    priority: clamp(toInt(raw.priority, 70), 0, 100),
    requestedBy: raw.requestedBy || adminActor(admin),
    sourceEntity: normalizeEventSourceEntity(raw.sourceEntity, input, normalizeVertical(raw.vertical || sport || inferVerticalForTrigger(trigger)), trigger),
    input: {
      ...input,
      sport,
      discipline: input.discipline || sport,
      automationTrigger: trigger,
      campaignRequestedFrom: 'backend-event-trigger',
    },
    sections: normalizeCampaignSections(raw.sections),
    automationKeys: normalizeStringArray(raw.automationKeys) || pack.automationKeys,
    includeAll: raw.includeAll !== false && (raw.includeAll === true || raw.allAgents === true || raw.runAllAgents === true || raw.allOfTheAbove === true || !Array.isArray(raw.automationKeys)),
    force: raw.force === true,
    backendCorrelationId: cleanString(raw.backendCorrelationId) || undefined,
    idempotencyKey: cleanString(raw.idempotencyKey) || undefined,
    metadata: { ...(isPlainObject(raw.metadata) ? raw.metadata : {}), trigger, submittedFrom: 'fantasymmadness-backend-campaign-event' },
  };
}

async function createSwarmCampaign({ config, axios, crypto, mongoose, models, body, admin, reason }) {
  if (!config.enabled) throw httpError(503, 'SWARM_DISABLED', 'Swarm integration is disabled.');
  const normalized = normalizeCreateCampaignBody(body || {}, admin, config, crypto);
  const localEventId = `campaign_event_${new mongoose.Types.ObjectId().toString()}`;
  let eventDoc = null;
  try {
    eventDoc = await models.SwarmBackendAutomationEvent.create({
      eventId: localEventId,
      trigger: `campaign.${normalized.campaignType}`,
      vertical: normalized.vertical,
      status: 'submitting',
      requestedBy: normalized.requestedBy,
      sourceEntity: normalized.sourceEntity,
      input: normalized.input,
      metadata: normalized.metadata,
      selectedJobTypes: [],
      createdJobs: [],
      skippedJobs: [],
      errors: [],
      reason: cleanString(reason) || 'campaign-created-from-backend',
    });
  } catch (error) {
    eventDoc = null;
  }

  try {
    const result = await callSwarm(config, axios, crypto, 'POST', '/internal/v1/campaigns', normalized);
    const campaign = result.campaign || result.data?.campaign || null;
    const jobs = Array.isArray(result.jobs) ? result.jobs : [];
    await upsertCampaignFromSwarm(models, campaign, {
      campaignId: campaign?.campaignId || normalized.backendCorrelationId || normalized.idempotencyKey,
      campaignType: normalized.campaignType,
      title: normalized.title,
      vertical: normalized.vertical,
      sport: normalized.sport,
      mode: normalized.mode,
      status: campaign?.status || 'queued',
      priority: normalized.priority,
      requestedBy: normalized.requestedBy,
      sourceEntity: normalized.sourceEntity,
      input: normalized.input,
      sections: normalized.sections,
      automationKeys: normalized.automationKeys,
      jobIds: jobs.map((job) => job.jobId).filter(Boolean),
      counts: campaign?.counts,
      backendCorrelationId: normalized.backendCorrelationId,
      idempotencyKey: normalized.idempotencyKey,
      metadata: normalized.metadata,
    });
    await Promise.all(jobs.map((job) => {
      if (!job?.jobId) return null;
      return upsertJobFromSwarm(models, {
        jobId: job.jobId,
        vertical: normalized.vertical,
        jobType: job.jobType,
        mode: job.mode || normalized.mode,
        status: job.status || 'queued',
        priority: normalized.priority,
        requestedBy: normalized.requestedBy,
        sourceEntity: normalized.sourceEntity,
        input: normalized.input,
        metadata: { ...normalized.metadata, campaignId: campaign?.campaignId || normalized.backendCorrelationId, automationKey: job.automationKey, campaignType: normalized.campaignType, sport: normalized.sport },
      });
    }));

    if (eventDoc) {
      eventDoc.status = jobs.length ? 'submitted' : 'skipped';
      eventDoc.selectedJobTypes = jobs.map((job) => job.jobType).filter(Boolean);
      eventDoc.createdJobs = jobs;
      eventDoc.skippedJobs = Array.isArray(result.skipped) ? result.skipped : [];
      eventDoc.metadata = { ...(eventDoc.metadata || {}), campaign: result.campaign || null };
      eventDoc.completedAt = new Date();
      await eventDoc.save();
    }

    return {
      source: 'swarm',
      campaign: campaign || null,
      jobs,
      skipped: Array.isArray(result.skipped) ? result.skipped : [],
      localEvent: serializeAutomationEvent(eventDoc),
      swarm: sanitizeSwarmEnvelope(result),
    };
  } catch (error) {
    if (eventDoc) {
      eventDoc.status = 'failed';
      eventDoc.errors = [summarizeError(error)];
      eventDoc.completedAt = new Date();
      await eventDoc.save();
    }
    throw error;
  }
}

function normalizeCreateCampaignBody(rawBody, admin, config, crypto) {
  const raw = isPlainObject(rawBody) ? rawBody : {};
  const sourceInput = isPlainObject(raw.input) ? raw.input : (isPlainObject(raw.context) ? raw.context : {});
  const sport = normalizeSport(raw.sport || raw.discipline || sourceInput.sport || sourceInput.discipline || raw.vertical || raw.gameMode);
  const campaignType = normalizeCampaignType(raw.campaignType || inferCampaignTypeFromBody(raw, sport));
  const vertical = normalizeVertical(raw.vertical || raw.gameMode || (sport === 'pro_wrestling' ? 'pro_wrestling' : 'combat'));
  if (!DEFAULT_VERTICALS.has(vertical)) throw httpError(400, 'INVALID_SWARM_VERTICAL', 'Campaign vertical must be combat or pro_wrestling. Use sport=boxing for Boxing.');
  if (!CAMPAIGN_TYPES.has(campaignType)) throw httpError(400, 'INVALID_CAMPAIGN_TYPE', 'Unsupported swarm campaign type.');

  const pack = LOCAL_CAMPAIGN_PACKS.find((item) => item.campaignType === campaignType) || LOCAL_CAMPAIGN_PACKS[0];
  const input = campaignType === 'july_10000_signup_growth_system'
    ? buildJulyGrowthInput({ ...raw, input: sourceInput })
    : {
      ...sourceInput,
      sport,
      discipline: sourceInput.discipline || sport,
      adminUXIntent: cleanString(raw.adminUXIntent) || cleanString(raw.intent) || buildCampaignIntent(campaignType, sport),
    };
  const scopeFightId = cleanString(sourceInput.fightId || sourceInput.matchId || raw.fightId || raw.matchId || raw.sourceEntity?.id || raw.sourceEntity?.fightId || raw.sourceEntity?.matchId);
  if (scopeFightId) {
    input.fightId = input.fightId || scopeFightId;
    input.matchId = input.matchId || scopeFightId;
  }
  const sourceEntity = { ...normalizeSourceEntity({ ...raw, sourceEntity: raw.sourceEntity, label: raw.label || raw.title }, input, vertical, 'content.article') };
  if (scopeFightId) {
    sourceEntity.id = sourceEntity.id || scopeFightId;
    sourceEntity.fightId = sourceEntity.fightId || scopeFightId;
    sourceEntity.matchId = sourceEntity.matchId || scopeFightId;
  }
  const title = cleanString(raw.title) || cleanString(input.title) || cleanString(input.matchName) || cleanString(input.eventName) || sourceEntity.label || pack.label;
  const normalized = {
    campaignType,
    title: title.slice(0, 200),
    vertical,
    sport,
    mode: normalizeMode(raw.mode || raw.statusMode || raw.publishMode || config.defaultMode || pack.defaultMode || 'APPROVAL_REQUIRED'),
    priority: clamp(toInt(raw.priority, 70), 0, 100),
    requestedBy: raw.requestedBy || adminActor(admin),
    sourceEntity,
    input,
    sections: normalizeCampaignSections(raw.sections) || pack.defaultSections,
    automationKeys: normalizeStringArray(raw.automationKeys) || pack.automationKeys,
    includeAll: raw.includeAll !== false && (raw.includeAll === true || raw.allAgents === true || raw.runAllAgents === true || raw.allOfTheAbove === true || !Array.isArray(raw.automationKeys)),
    force: raw.force === true,
    backendCorrelationId: cleanString(raw.backendCorrelationId) || undefined,
    idempotencyKey: cleanString(raw.idempotencyKey) || undefined,
    metadata: {
      ...(isPlainObject(raw.metadata) ? raw.metadata : {}),
      ...(scopeFightId ? { fightId: scopeFightId, matchId: scopeFightId, sourceEntityId: scopeFightId } : {}),
      submittedFrom: 'fantasymmadness-backend-campaign',
      submittedAt: new Date().toISOString(),
      campaignType,
      sport,
    },
  };
  if (!normalized.idempotencyKey) {
    normalized.idempotencyKey = createCampaignIdempotencyKey({ crypto, normalized });
  }
  return normalized;
}

function createCampaignIdempotencyKey({ crypto, normalized }) {
  const hash = crypto.createHash('sha256').update(JSON.stringify({
    campaignType: normalized.campaignType,
    title: normalized.title,
    sourceEntity: normalized.sourceEntity,
    input: normalized.input,
    sections: normalized.sections,
    automationKeys: normalized.automationKeys,
  })).digest('hex').slice(0, 24);
  return `backend:campaign:${normalized.campaignType}:${hash}`.slice(0, 200);
}

function normalizeCampaignType(value) {
  const normalized = cleanString(value).toLowerCase().replace(/[-\s]+/g, '_');
  const aliases = {
    fight: 'fight_full_campaign',
    fight_full: 'fight_full_campaign',
    full_fight: 'fight_full_campaign',
    full_campaign: 'fight_full_campaign',
    all_agents: 'fight_full_campaign',
    all_the_above: 'fight_full_campaign',
    tonight: 'fight_tonight_campaign',
    tonight_fight: 'fight_tonight_campaign',
    promote_tonight: 'fight_tonight_campaign',
    boxing: 'boxing_fight_campaign',
    boxing_fight: 'boxing_fight_campaign',
    result: 'fight_result_campaign',
    fight_result: 'fight_result_campaign',
    pro_wrestling: 'pro_wrestling_match_campaign',
    wrestling: 'pro_wrestling_match_campaign',
    blog: 'blog_promotion_campaign',
    blog_promotion: 'blog_promotion_campaign',
    contest: 'contest_promotion_campaign',
    july: 'july_10000_signup_growth_system',
    july_growth: 'july_10000_signup_growth_system',
    july_10000: 'july_10000_signup_growth_system',
    growth: 'july_10000_signup_growth_system',
    growth_system: 'july_10000_signup_growth_system',
    signup_growth: 'july_10000_signup_growth_system',
    ten_thousand_signups: 'july_10000_signup_growth_system',
    '10000_signups': 'july_10000_signup_growth_system',
    custom: 'custom_campaign',
  };
  return aliases[normalized] || normalized || 'fight_full_campaign';
}

function inferCampaignTypeFromBody(raw, sport) {
  if (sport === 'boxing') return 'boxing_fight_campaign';
  if (sport === 'pro_wrestling' || normalizeVertical(raw.vertical || raw.gameMode) === 'pro_wrestling') return 'pro_wrestling_match_campaign';
  if (raw.growthSystem || raw.julyGrowth || raw.july10000 || raw.signupGoal || raw.targetSignups) return 'july_10000_signup_growth_system';
  if (raw.result || raw.resultUpdated) return 'fight_result_campaign';
  if (raw.tonight || raw.promoteTonight) return 'fight_tonight_campaign';
  if (raw.blogId || raw.blogTitle) return 'blog_promotion_campaign';
  if (raw.contestId) return 'contest_promotion_campaign';
  return 'fight_full_campaign';
}

function inferCampaignTypeForTrigger(trigger, sport) {
  if (sport === 'boxing') return 'boxing_fight_campaign';
  const normalized = normalizeAutomationTrigger(trigger);
  if (normalized === 'fight_result_updated') return 'fight_result_campaign';
  if (normalized === 'upcoming_event' || normalized === 'fight_published') return 'fight_full_campaign';
  if (normalized.includes('wrestling')) return 'pro_wrestling_match_campaign';
  if (normalized === 'blog_approved') return 'blog_promotion_campaign';
  if (normalized.includes('contest')) return 'contest_promotion_campaign';
  return 'custom_campaign';
}

function buildCampaignIntent(campaignType, sport) {
  if (campaignType === 'boxing_fight_campaign') return 'Run all Boxing promotion agents for this fight.';
  if (campaignType === 'fight_tonight_campaign') return 'Promote this fight tonight across content, SEO, social, newsletter, and homepage artifacts.';
  if (campaignType === 'fight_result_campaign') return 'Create fight result recap and promotional artifacts.';
  if (campaignType === 'pro_wrestling_match_campaign') return 'Create pro-wrestling match campaign artifacts.';
  if (campaignType === 'blog_promotion_campaign') return 'Promote this approved blog with SEO and social artifacts.';
  if (campaignType === 'contest_promotion_campaign') return 'Promote this contest with explainers, reminders, and announcement artifacts.';
  if (campaignType === 'july_10000_signup_growth_system') return 'Run the safe July 10,000-signup growth system as draft/approval artifacts across content, social, YouTube, media, calendar, and retention.';
  return `Run the full ${sport || 'fight'} automation campaign.`;
}

function normalizeCampaignSections(value) {
  const rawItems = normalizeStringArray(value);
  if (!rawItems) return undefined;
  const items = rawItems.map((item) => item.toLowerCase().replace(/[-\s]+/g, '_'));
  const filtered = items.filter((item) => CAMPAIGN_SECTIONS.has(item));
  return filtered.length ? [...new Set(filtered)] : undefined;
}

function normalizeStringArray(value) {
  let rawItems = [];
  if (Array.isArray(value)) {
    rawItems = value;
  } else if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      rawItems = Array.isArray(parsed) ? parsed : value.split(',');
    } catch (error) {
      rawItems = value.split(',');
    }
  }
  const items = rawItems.map((item) => cleanString(item)).filter(Boolean);
  return items.length ? [...new Set(items)] : undefined;
}

async function upsertCampaignFromSwarm(models, swarmCampaign, fallback) {
  if (!swarmCampaign && !fallback) return null;
  const campaignId = swarmCampaign?.campaignId || fallback?.campaignId || fallback?.backendCorrelationId;
  if (!campaignId) return null;
  const set = {
    campaignId,
    campaignType: swarmCampaign?.campaignType || fallback?.campaignType,
    title: swarmCampaign?.title || fallback?.title,
    vertical: swarmCampaign?.vertical || fallback?.vertical,
    sport: swarmCampaign?.sport || fallback?.sport,
    mode: swarmCampaign?.mode || fallback?.mode,
    status: swarmCampaign?.status || fallback?.status || 'queued',
    priority: swarmCampaign?.priority ?? fallback?.priority,
    requestedBy: swarmCampaign?.requestedBy || fallback?.requestedBy,
    sourceEntity: swarmCampaign?.sourceEntity || fallback?.sourceEntity,
    input: swarmCampaign?.input || fallback?.input,
    sections: swarmCampaign?.sections || fallback?.sections,
    automationKeys: swarmCampaign?.automationKeys || fallback?.automationKeys,
    jobIds: swarmCampaign?.jobIds || fallback?.jobIds || [],
    counts: swarmCampaign?.counts || fallback?.counts,
    callbackUrl: swarmCampaign?.callbackUrl || fallback?.callbackUrl,
    backendCorrelationId: swarmCampaign?.backendCorrelationId || fallback?.backendCorrelationId,
    idempotencyKey: swarmCampaign?.idempotencyKey || fallback?.idempotencyKey,
    metadata: swarmCampaign?.metadata || fallback?.metadata,
    swarmCampaign: swarmCampaign || fallback?.swarmCampaign,
    error: fallback?.error,
    updatedAt: new Date(),
  };
  Object.keys(set).forEach((key) => set[key] === undefined && delete set[key]);
  await models.SwarmBackendCampaign.updateOne({ campaignId }, { $set: set, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
  return models.SwarmBackendCampaign.findOne({ campaignId });
}

function serializeLocalCampaign(campaign) {
  if (!campaign) return null;
  return {
    id: String(campaign._id),
    campaignId: campaign.campaignId,
    campaignType: campaign.campaignType,
    title: campaign.title,
    vertical: campaign.vertical,
    sport: campaign.sport,
    mode: campaign.mode,
    status: campaign.status,
    priority: campaign.priority,
    requestedBy: campaign.requestedBy,
    sourceEntity: campaign.sourceEntity,
    input: campaign.input,
    sections: campaign.sections || [],
    automationKeys: campaign.automationKeys || [],
    jobIds: campaign.jobIds || [],
    counts: campaign.counts,
    callbackUrl: campaign.callbackUrl,
    backendCorrelationId: campaign.backendCorrelationId,
    idempotencyKey: campaign.idempotencyKey,
    metadata: campaign.metadata,
    fightId: campaign.metadata?.fightId || campaign.input?.fightId || campaign.sourceEntity?.fightId || campaign.sourceEntity?.id,
    matchId: campaign.metadata?.matchId || campaign.input?.matchId || campaign.sourceEntity?.matchId || campaign.sourceEntity?.id,
    error: campaign.error,
    swarmCampaign: campaign.swarmCampaign,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
  };
}

function isSeoArtifact(artifact) {
  const type = String(artifact?.artifactType || '');
  const jobType = String(artifact?.jobType || '');
  return type.startsWith('seo.') || jobType.startsWith('seo.');
}

async function applySeoArtifact({ artifact, Blog, admin, options }) {
  const payload = artifact.payload || {};
  const targetBlogId = cleanString(options?.targetBlogId || payload.targetBlogId || payload.blogId || artifact.sourceEntity?.id || artifact.swarmArtifact?.sourceEntity?.id);
  const targetType = String(artifact.sourceEntity?.type || artifact.swarmArtifact?.sourceEntity?.type || payload.targetType || '').toLowerCase();
  const isBlogTarget = targetType.includes('blog') || Boolean(payload.blogId || payload.targetBlogId);
  const metaTitle = cleanString(payload.metaTitle || payload.titleTag || payload.openGraph?.title || payload.twitterCard?.title);
  const metaDescription = cleanString(payload.metaDescription || payload.description || payload.openGraph?.description || payload.twitterCard?.description);
  const applicationPlan = payload.applicationPlan || {
    managedBySwarm: true,
    requiresBackendApply: true,
    safeToAutoApply: false,
    backendAction: 'patch_page_seo_fields_after_admin_approval',
  };

  if (!options?.applyToBlog || !targetBlogId || !isBlogTarget) {
    return {
      applied: false,
      action: 'seo_approved_not_applied',
      reason: 'SEO artifact was approved and stored, but no blog target was provided. Fight/event schema, sitemap, and internal-link artifacts remain application plans until the frontend/backend target fields exist.',
      applicationPlan,
      recommendedFields: { metaTitle, metaDescription },
    };
  }
  if (!Blog) throw httpError(500, 'BLOG_MODEL_UNAVAILABLE', 'Blog model is not available for SEO application.');
  const blog = await Blog.findById(targetBlogId).catch(() => null);
  if (!blog) {
    return { applied: false, action: 'seo_target_not_found', reason: 'Target blog was not found.', targetBlogId, applicationPlan, recommendedFields: { metaTitle, metaDescription } };
  }
  const before = { metaTitle: blog.metaTitle, metaDescription: blog.metaDescription };
  if (metaTitle) blog.metaTitle = metaTitle;
  if (metaDescription) blog.metaDescription = metaDescription;
  await blog.save();
  return {
    applied: true,
    action: 'updated_blog_seo',
    entity: { type: 'Blog', id: String(blog._id), metaTitle: blog.metaTitle, updatedSeo: true },
    before,
    after: { metaTitle: blog.metaTitle, metaDescription: blog.metaDescription },
    reviewedBy: admin,
    applicationPlan,
  };
}

async function triggerAutomationEvent({ config, axios, crypto, mongoose, models, admin, trigger, vertical, sport, mode, sourceEntity, input, metadata, requestedJobTypes, reason }) {
  if (!config.enabled) throw httpError(503, 'SWARM_DISABLED', 'Swarm integration is disabled.');
  const normalizedTrigger = normalizeAutomationTrigger(trigger);
  const normalizedSport = normalizeSport(sport || input?.sport || input?.discipline || vertical || inferVerticalForTrigger(normalizedTrigger));
  const normalizedVertical = normalizeVertical(vertical || normalizedSport || inferVerticalForTrigger(normalizedTrigger));
  if (!DEFAULT_VERTICALS.has(normalizedVertical)) throw httpError(400, 'INVALID_SWARM_VERTICAL', 'Automation event vertical must be combat or pro_wrestling. Use sport=boxing for Boxing.');

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
    input: { ...(isPlainObject(input) ? input : {}), sport: normalizedSport, discipline: input?.discipline || normalizedSport },
    metadata: { ...(isPlainObject(metadata) ? metadata : {}), sport: normalizedSport },
    selectedJobTypes: [],
    createdJobs: [],
    skippedJobs: [],
    errors: [],
    reason: cleanString(reason) || 'automation-event-triggered',
  });

  let settingsEnvelope;
  try {
    settingsEnvelope = await callSwarm(config, axios, crypto, 'GET', '/internal/v1/automations');
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
      input: buildAutomationJobInput({ input: { ...(isPlainObject(input) ? input : {}), sport: normalizedSport, discipline: input?.discipline || normalizedSport }, metadata: { ...(isPlainObject(metadata) ? metadata : {}), sport: normalizedSport }, trigger: normalizedTrigger, eventId, jobType, vertical: normalizedVertical }),
      metadata: {
        ...(metadata || {}),
        automationEventId: eventId,
        automationTrigger: normalizedTrigger,
        automationJobType: jobType,
        submittedFrom: 'fantasymmadness-backend-automation-event',
        sport: normalizedSport,
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
  if (requested.some((item) => ['all', '*', 'all_agents', 'all_the_above'].includes(item.toLowerCase()))) return [...new Set(AUTOMATION_TRIGGER_DEFAULTS[trigger] || [])];
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


async function runSchedulePreset({ config, axios, crypto, mongoose, models, admin, body, preset }) {
  const trigger = preset === 'weekly' ? 'weekly_schedule' : 'daily_schedule';
  const requestedJobTypes = Array.isArray(body.jobTypes) && body.jobTypes.length ? body.jobTypes : AUTOMATION_TRIGGER_DEFAULTS[trigger];
  return triggerAutomationEvent({
    config,
    axios,
    crypto,
    mongoose,
    models,
    admin,
    trigger,
    vertical: body.vertical || 'combat',
    sport: body.sport || body.discipline || 'mma',
    mode: body.mode || 'APPROVAL_REQUIRED',
    sourceEntity: body.sourceEntity || { type: 'scheduled_automation', label: `${preset} automation run`, origin: 'backend_schedule_preset' },
    input: {
      ...(isPlainObject(body.input) ? body.input : {}),
      schedulePreset: preset,
      requestedOutput: preset === 'weekly' ? 'weekly traffic, calendar, and growth automation outputs' : 'daily SEO, social, calendar, and dashboard automation outputs',
      platforms: Array.isArray(body.platforms) ? body.platforms : getSwarmConfig().socialDefaultPlatforms,
      dailySocialDraftCount: toInt(body.dailySocialDraftCount, getSwarmConfig().dailySocialDraftCount),
      externalSources: Array.isArray(body.externalSources) ? body.externalSources : getSwarmConfig().externalFightSources,
      sourceMode: Array.isArray(body.externalSources) || getSwarmConfig().externalFightSources.length ? 'backend_plus_external_feeds' : 'backend_only',
    },
    metadata: { ...(isPlainObject(body.metadata) ? body.metadata : {}), schedulePreset: preset, submittedFrom: 'backend-schedule-preset' },
    requestedJobTypes,
    reason: body.reason || `admin-ran-${preset}-schedule-preset`,
  });
}

async function runExplicitAutomationJobs({ config, axios, crypto, mongoose, models, admin, body, trigger, jobTypes }) {
  return triggerAutomationEvent({
    config,
    axios,
    crypto,
    mongoose,
    models,
    admin,
    trigger,
    vertical: body.vertical || 'combat',
    sport: body.sport || body.discipline || 'mma',
    mode: body.mode || 'APPROVAL_REQUIRED',
    sourceEntity: body.sourceEntity || { type: 'manual_schedule_run', label: body.title || trigger, origin: 'backend_explicit_schedule_run' },
    input: {
      ...(isPlainObject(body.input) ? body.input : {}),
      title: body.title,
      topic: body.topic,
      platforms: Array.isArray(body.platforms) ? body.platforms : getSwarmConfig().socialDefaultPlatforms,
      dailySocialDraftCount: toInt(body.dailySocialDraftCount, getSwarmConfig().dailySocialDraftCount),
      externalSources: Array.isArray(body.externalSources) ? body.externalSources : getSwarmConfig().externalFightSources,
      sourceMode: Array.isArray(body.externalSources) || getSwarmConfig().externalFightSources.length ? 'backend_plus_external_feeds' : 'backend_only',
    },
    metadata: { ...(isPlainObject(body.metadata) ? body.metadata : {}), explicitAutomationRun: true, submittedFrom: 'backend-explicit-automation-run' },
    requestedJobTypes: Array.isArray(body.jobTypes) && body.jobTypes.length ? body.jobTypes : jobTypes,
    reason: body.reason || `admin-ran-${trigger}-automation-jobs`,
  });
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
    schedule_daily: 'daily_schedule',
    'schedule.daily': 'daily_schedule',
    daily_schedule: 'daily_schedule',
    july: 'july_growth_daily',
    july_growth: 'july_growth_daily',
    july_10000: 'july_growth_daily',
    growth_daily: 'july_growth_daily',
    july_growth_daily: 'july_growth_daily',
    'schedule.july_growth': 'july_growth_daily',
    weekly: 'weekly_schedule',
    schedule_weekly: 'weekly_schedule',
    'schedule.weekly': 'weekly_schedule',
    weekly_schedule: 'weekly_schedule',
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
  if (jobType.startsWith('analytics.')) return 'analytics/dashboard artifact with summary metrics and review notes';
  if (jobType.startsWith('media.')) return 'media prompt artifact with image-generation instructions for admin review';
  if (jobType.startsWith('notification.')) return 'admin notification artifact with issue summary and recommended action';
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
  if (jobType.startsWith('analytics.')) return 'Creates analytics, leaderboard, traffic, or dashboard artifacts.';
  if (jobType.startsWith('media.')) return 'Creates image-prompt and media planning artifacts.';
  if (jobType.startsWith('notification.')) return 'Creates admin notification artifacts for traffic or automation issues.';
  if (jobType.startsWith('wrestling.')) return 'Creates advisory pro-wrestling analysis artifacts.';
  if (jobType.startsWith('automation.')) return 'Creates automation dashboard/control artifacts.';
  return 'System automation task.';
}

function inferAdminControls(jobType) {
  const controls = ['review'];
  if (jobType.startsWith('social.')) controls.push('platforms', 'publishFlag');
  if (jobType.startsWith('seo.')) controls.push('applySeo');
  if (jobType.startsWith('content.')) controls.push('publishBlog');
  if (jobType.startsWith('media.')) controls.push('imagePrompt');
  if (jobType.startsWith('analytics.')) controls.push('report');
  if (jobType.startsWith('notification.')) controls.push('notifyAdmin');
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
    campaignId: job.metadata?.campaignId || job.input?.campaignId || job.sourceEntity?.campaignId,
    fightId: job.metadata?.fightId || job.input?.fightId || job.sourceEntity?.fightId || job.sourceEntity?.id,
    matchId: job.metadata?.matchId || job.input?.matchId || job.sourceEntity?.matchId || job.sourceEntity?.id,
    sport: job.input?.sport || job.sourceEntity?.sport || job.metadata?.sport,
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
    campaignId: artifact.metadata?.campaignId || artifact.payload?.campaignId,
    fightId: artifact.metadata?.fightId || artifact.payload?.fightId || artifact.provenance?.fightId,
    matchId: artifact.metadata?.matchId || artifact.payload?.matchId || artifact.provenance?.matchId,
    sport: artifact.metadata?.sport || artifact.payload?.sport,
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
  const normalized = String(value || 'combat').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (['wrestling', 'prowrestling', 'pro_wrestling', 'pro_wrestling_match', 'pro_wrestling_event'].includes(normalized)) return 'pro_wrestling';
  if (['mma', 'boxing', 'kickboxing', 'fight', 'fights', 'combat_sports', 'combat_sport', 'combat'].includes(normalized)) return 'combat';
  return normalized;
}

function normalizeSport(value) {
  const normalized = String(value || 'mma').trim().toLowerCase().replace(/[-\s]+/g, '_');
  const aliases = {
    mixed_martial_arts: 'mma',
    ufc: 'mma',
    mma_fight: 'mma',
    box: 'boxing',
    boxing_fight: 'boxing',
    boxer: 'boxing',
    kick_boxing: 'kickboxing',
    kickboxing_fight: 'kickboxing',
    wrestling: 'pro_wrestling',
    prowrestling: 'pro_wrestling',
    pro_wrestling_match: 'pro_wrestling',
    combat_sports: 'combat',
    combat_sport: 'combat',
  };
  const sport = aliases[normalized] || normalized || 'mma';
  return DEFAULT_SPORTS.has(sport) ? sport : 'mma';
}


function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
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
    normalizeSport,
    mapArtifactToBlog,
    normalizeCreateJobBody,
    normalizeMode,
    normalizeSourceEntity,
    normalizeAutomationTrigger,
    normalizeCreateCampaignBody,
    normalizeCampaignType,
    shouldRunEventAsCampaign,
    resolveEventJobTypes,
    buildLocalAutomationCatalog,
    buildDefaultAutomationSettings,
    buildJulyGrowthConfig,
    DEFAULT_JOB_TYPE_ARRAY,
    JULY_10000_GROWTH_JOB_TYPES,
    inferVerticalForJobType,
    signRequest,
    sha256Hex,
  },
};
