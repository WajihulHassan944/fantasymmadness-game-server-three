'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { registerSwarmPhase2Routes, _private } = require('./swarm-phase2');

assert.strictEqual(typeof registerSwarmPhase2Routes, 'function');
assert.strictEqual(_private.normalizeVertical('wrestling'), 'pro_wrestling');
assert.strictEqual(_private.normalizeVertical('mma'), 'combat');


const normalizedManualJob = _private.normalizeCreateJobBody({
  vertical: 'combat',
  jobType: 'content.article',
  mode: 'draft',
  input: {
    topic: 'write a blog for ufc fight',
    title: 'UFC Fight',
    prompt: 'write a blog for ufc fight',
  },
}, { id: 'admin-1', email: 'admin@example.com' }, { defaultMode: 'DRAFT_ONLY' });
assert.strictEqual(normalizedManualJob.mode, 'DRAFT_ONLY');
assert.strictEqual(normalizedManualJob.sourceEntity.type, 'manual_prompt');
assert.strictEqual(normalizedManualJob.sourceEntity.label, 'UFC Fight');
assert.strictEqual(normalizedManualJob.sourceEntity.origin, 'backend_default');

const normalizedApprovalMode = _private.normalizeCreateJobBody({
  vertical: 'pro-wrestling',
  jobType: 'content.match-preview',
  mode: 'approval',
  input: { matchId: 'match-123', title: 'Main Event Preview' },
}, { id: 'admin-2' }, { defaultMode: 'DRAFT_ONLY' });
assert.strictEqual(normalizedApprovalMode.vertical, 'pro_wrestling');
assert.strictEqual(normalizedApprovalMode.mode, 'APPROVAL_REQUIRED');
assert.strictEqual(normalizedApprovalMode.sourceEntity.type, 'pro_wrestling_match');
assert.strictEqual(normalizedApprovalMode.sourceEntity.id, 'match-123');


const expandedJob = _private.normalizeCreateJobBody({
  vertical: 'combat',
  jobType: 'seo.metadata',
  mode: 'approval',
  input: { matchId: 'match-456', title: 'SEO Metadata Test' },
}, { id: 'admin-3' }, { defaultMode: 'DRAFT_ONLY' });
assert.strictEqual(expandedJob.jobType, 'seo.metadata');
assert.strictEqual(expandedJob.sourceEntity.type, 'combat_match');

assert.strictEqual(_private.normalizeAutomationTrigger('fight-publish'), 'fight_published');
assert.strictEqual(_private.normalizeAutomationTrigger('blog published'), 'blog_approved');
assert.strictEqual(_private.inferVerticalForJobType('content.pro-wrestling-match-preview'), 'pro_wrestling');
const localCatalog = _private.buildLocalAutomationCatalog();
assert(localCatalog.jobTypes.includes('social.fight-publish-post'));
assert(localCatalog.triggerMap.fight_published.includes('content.fight-publish-blog-draft'));
const defaultSettings = _private.buildDefaultAutomationSettings();
assert.strictEqual(defaultSettings.automations['content.match-preview'].enabled, true);
assert(_private.resolveEventJobTypes({ trigger: 'fight_published', settings: defaultSettings }).includes('content.fight-publish-blog-draft'));
assert.strictEqual(_private.normalizeMode('draft'), 'DRAFT_ONLY');
assert.strictEqual(_private.normalizeMode('draft-only'), 'DRAFT_ONLY');
assert.strictEqual(_private.normalizeMode('approval required'), 'APPROVAL_REQUIRED');
assert.strictEqual(_private.normalizeMode('auto'), 'AUTOMATED');

const normalizedBoxingJob = _private.normalizeCreateJobBody({
  vertical: 'boxing',
  sport: 'boxing',
  jobType: 'content.fight-publish-blog-draft',
  mode: 'review',
  input: { fightId: 'fight-boxing-1', title: 'Boxing Fight Tonight' },
}, { id: 'admin-boxing' }, { defaultMode: 'DRAFT_ONLY' });
assert.strictEqual(normalizedBoxingJob.vertical, 'combat');
assert.strictEqual(normalizedBoxingJob.sport, 'boxing');
assert.strictEqual(normalizedBoxingJob.input.sport, 'boxing');
assert.strictEqual(normalizedBoxingJob.sourceEntity.type, 'combat_fight');

const normalizedCampaign = _private.normalizeCreateCampaignBody({
  campaignType: 'boxing',
  title: 'Boxing Main Event',
  sport: 'boxing',
  includeAll: true,
  sourceEntity: { type: 'combat_match', id: 'fight-1', label: 'Boxing Main Event' },
  input: { fightId: 'fight-1', title: 'Boxing Main Event' },
}, { id: 'admin-campaign' }, { defaultMode: 'DRAFT_ONLY' }, crypto);
assert.strictEqual(normalizedCampaign.campaignType, 'boxing_fight_campaign');
assert.strictEqual(normalizedCampaign.vertical, 'combat');
assert.strictEqual(normalizedCampaign.sport, 'boxing');
assert.strictEqual(normalizedCampaign.includeAll, true);
assert(normalizedCampaign.idempotencyKey.startsWith('backend:campaign:boxing_fight_campaign'));

const normalizedJulyGrowthCampaign = _private.normalizeCreateCampaignBody({
  campaignType: 'july_growth',
  title: 'July Growth System',
  growthSystem: 'july-10000-signups',
  input: { topic: 'Combat sports daily growth system' },
}, { id: 'admin-growth' }, { defaultMode: 'DRAFT_ONLY' }, crypto);
assert.strictEqual(normalizedJulyGrowthCampaign.campaignType, 'july_10000_signup_growth_system');
assert.strictEqual(normalizedJulyGrowthCampaign.mode, 'DRAFT_ONLY');
assert.strictEqual(normalizedJulyGrowthCampaign.sourceEntity.type, 'growth_campaign');
assert.strictEqual(normalizedJulyGrowthCampaign.input.requiredYouTubeEndingLine, 'Make your picks on Fantasy MMadness before the event starts.');
assert(normalizedJulyGrowthCampaign.automationKeys.includes('social.youtubeGrowthVideoDraft'));
assert(_private.buildJulyGrowthConfig().jobTypes.includes('social.youtube-growth-video-draft'));
assert(_private.DEFAULT_JOB_TYPE_ARRAY.includes('analytics.july-10000-signup-growth-plan'));

const body = JSON.stringify({ ok: true });
const signature = _private.signRequest({
  crypto,
  method: 'POST',
  pathWithQuery: '/api/internal/swarm/webhooks/job-completed',
  timestamp: '2026-01-01T00:00:00.000Z',
  nonce: 'nonce-1',
  body,
  secret: 'secret-1',
});
assert.strictEqual(signature.length, 64);
assert.strictEqual(_private.sha256Hex(crypto, body).length, 64);

const mappedBlog = _private.mapArtifactToBlog({
  metaTitle: 'Generated Fight Preview',
  metaDescription: 'Preview description',
  header: 'Fight Preview',
  sections: [{ title: 'Main card', content: 'Card content' }],
}, { title: 'Fallback title', summary: 'Fallback summary' });
assert.strictEqual(mappedBlog.metaTitle, 'Generated Fight Preview');
assert.strictEqual(mappedBlog.sections.length, 1);

const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
assert(serverSource.includes("require('./swarm-phase2')"), 'server.js must load the swarm gateway module.');
assert(serverSource.includes('req.rawBody = buf ? buf.toString'), 'server.js must preserve raw JSON body for webhook HMAC validation.');
assert(serverSource.includes('registerSwarmPhase2Routes({'), 'server.js must register swarm phase 2 routes.');

const gatewaySource = fs.readFileSync(path.join(__dirname, 'swarm-phase2.js'), 'utf8');
for (const route of [
  '/api/admin/swarm/config',
  '/api/admin/swarm/health',
  '/api/admin/swarm/jobs',
  '/api/admin/swarm/artifacts',
  '/api/admin/swarm/job-types',
  '/api/admin/swarm/catalog',
  '/api/admin/swarm/settings',
  '/api/admin/swarm/dashboard',
  '/api/admin/swarm/events/trigger',
  '/api/admin/swarm/automations/:jobType/run',
  '/api/admin/swarm/artifacts/:artifactId/apply-seo',
  '/api/admin/swarm/campaigns/boxing',
  '/api/admin/swarm/campaigns/july-growth',
  '/api/admin/swarm/growth/july-10000/config',
  '/api/admin/swarm/growth/july-10000/dashboard',
  '/api/admin/swarm/growth/july-10000/run',
  '/api/admin/swarm/schedules/daily/july-growth',
  '/api/admin/swarm/campaigns/fight/tonight',
  '/api/admin/swarm/campaigns/fight/full',
  '/api/admin/swarm/campaigns/packs',
  '/api/admin/swarm/campaigns',
  '/api/admin/swarm/campaigns/:campaignId',
  '/api/admin/swarm/campaigns/fight',
  '/api/internal/swarm/webhooks/job-completed',
  '/api/internal/swarm/webhooks/job-failed',
]) {
  assert(gatewaySource.includes(route), `Missing swarm route: ${route}`);
}

console.log('Phase 2 swarm backend integration tests passed.');
