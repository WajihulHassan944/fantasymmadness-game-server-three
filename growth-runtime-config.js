'use strict';
// Runtime configuration for the isolated Growth Engine service.
// Validates the environment and FAILS CLOSED. Never returns or logs secret values.
//
// Where it may run:
//  - On Vercel: only in the dedicated isolated project (VERCEL_PROJECT_ID below),
//    with the Atlas store's MONGODB_URI, database fmgrowthtest.
//  - In CI/local tests: only against a loopback MongoDB (GROWTH_TEST_MONGO_URI).
// Real outreach stays off unless every owner-approval flag and credential is present.
const ISOLATED_PROJECT_ID = 'prj_Hpe9UjGrBBJOm3boxHsL9lHesWLl';
const ISOLATED_STORE_ID = 'store_5mRLkf9U8eKGIaaO';
const DATABASE = 'fmgrowthtest';
const BUSINESS_SENDER = 'contact@fantasymmadnesscom.com';

function resolveGrowthRuntimeConfig(env = process.env) {
  const errors = [];
  const warnings = [];
  if (env.GROWTH_STAGING_MODE !== 'isolated') errors.push('GROWTH_STAGING_MODE must be "isolated"');
  if (env.GROWTH_PRODUCTION_APPROVED === 'true') errors.push('GROWTH_PRODUCTION_APPROVED is not valid for the isolated service');

  // ---- database -----------------------------------------------------------
  const onVercel = Boolean(env.VERCEL);
  let uri = '';
  let dbKind = '';
  if (onVercel) {
    if (env.VERCEL_PROJECT_ID !== ISOLATED_PROJECT_ID) errors.push('This service only runs in the isolated Vercel project fantasymmadness-growth-isolated-test');
    uri = String(env.MONGODB_URI || '');
    dbKind = 'atlas';
    if (!/^mongodb\+srv:\/\//.test(uri)) errors.push('MONGODB_URI must be the Atlas (mongodb+srv) URI from the fmgrowthtest store');
    if (env.GROWTH_ATLAS_STORE_ID && env.GROWTH_ATLAS_STORE_ID !== ISOLATED_STORE_ID) errors.push('GROWTH_ATLAS_STORE_ID does not match the dedicated fmgrowthtest store');
    if (env.GROWTH_TEST_ATLAS_HOST) {
      try { if (new URL(uri).hostname.toLowerCase() !== env.GROWTH_TEST_ATLAS_HOST.trim().toLowerCase()) errors.push('Atlas host does not match GROWTH_TEST_ATLAS_HOST'); }
      catch { errors.push('MONGODB_URI is not a valid URI'); }
    } else warnings.push('GROWTH_TEST_ATLAS_HOST not set: Atlas host is not pinned');
    if (!env.CRON_SECRET || String(env.CRON_SECRET).length < 16) errors.push('CRON_SECRET (16+ characters) is required for scheduled runs');
  } else {
    uri = String(env.GROWTH_TEST_MONGO_URI || '');
    dbKind = 'loopback-test';
    if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|\?|$)/.test(uri)) errors.push('Outside Vercel only a loopback test MongoDB (GROWTH_TEST_MONGO_URI) is allowed');
  }
  if (!env.JWT_SECRET_ADMIN || String(env.JWT_SECRET_ADMIN).length < 32) errors.push('JWT_SECRET_ADMIN (32+ characters) is required for back-office access');
  if (!env.GROWTH_UNSUBSCRIBE_SECRET || String(env.GROWTH_UNSUBSCRIBE_SECRET).length < 32) {
    if (onVercel) errors.push('GROWTH_UNSUBSCRIBE_SECRET (32+ characters) is required for unsubscribe links');
    else warnings.push('GROWTH_UNSUBSCRIBE_SECRET not set (tests only)');
  }

  // ---- delivery -------------------------------------------------------------
  // none (default): drafts are prepared and approved, nothing is sent.
  // sandbox-smtp:   loopback SMTP sandbox only (CI / local verification).
  // sandbox-capture: exact message built and stored for review; never sent (staging).
  // resend:         REAL email; every approval flag + credential required.
  const provider = String(env.GROWTH_DELIVERY_PROVIDER || 'none');
  const delivery = { provider, realDelivery: false, sender: '', blockers: [] };
  if (provider === 'sandbox-smtp') {
    const host = String(env.GROWTH_SANDBOX_SMTP_HOST || '127.0.0.1');
    if (!['127.0.0.1', 'localhost'].includes(host)) errors.push('Sandbox SMTP must be loopback');
    delivery.smtp = { host, port: Number(env.GROWTH_SANDBOX_SMTP_PORT || 1025) };
  } else if (provider === 'sandbox-capture') {
    delivery.sender = BUSINESS_SENDER; // the message is built exactly as it would be sent, then stored; never sent
  } else if (provider === 'resend') {
    const need = (ok, why) => { if (!ok) delivery.blockers.push(why); };
    need(env.GROWTH_OUTBOUND_ENABLED === 'true', 'GROWTH_OUTBOUND_ENABLED must be "true"');
    need(env.GROWTH_REAL_OUTREACH_APPROVED === 'true', 'GROWTH_REAL_OUTREACH_APPROVED (owner approval) must be "true"');
    need(String(env.GROWTH_SENDER_ADDRESS || '').toLowerCase() === BUSINESS_SENDER, `GROWTH_SENDER_ADDRESS must be ${BUSINESS_SENDER}`);
    need(env.GROWTH_SENDER_DOMAIN_VERIFIED === 'true', 'GROWTH_SENDER_DOMAIN_VERIFIED (SPF/DKIM verified at the provider) must be "true"');
    need(Boolean(env.GROWTH_RESEND_API_KEY), 'GROWTH_RESEND_API_KEY is required');
    need(Boolean(env.GROWTH_UNSUBSCRIBE_BASE_URL) && /^https:\/\//.test(env.GROWTH_UNSUBSCRIBE_BASE_URL), 'GROWTH_UNSUBSCRIBE_BASE_URL (https) is required');
    if (!delivery.blockers.length) { delivery.realDelivery = true; delivery.sender = BUSINESS_SENDER; }
  } else if (provider !== 'none') errors.push(`Unknown GROWTH_DELIVERY_PROVIDER "${provider}"`);
  if (env.GROWTH_OUTBOUND_ENABLED === 'true' && !delivery.realDelivery) errors.push('GROWTH_OUTBOUND_ENABLED is "true" but real delivery is not fully authorized');

  // Social publishing (fails closed; see growth-social-publishing.js).
  const socialResolved = require('./growth-social-publishing').resolveSocialConfig(env);
  errors.push(...socialResolved.errors);
  // Meta (Facebook Page + Instagram) connection; the app secret stays in `secrets`.
  const metaResolved = require('./growth-meta-connect').resolveMetaConfig(env);

  // Marketing campaigns come only from the published FANTASY MMADNESS contest feeds (read-only).
  let contestSourceUrl = '';
  try { contestSourceUrl = require('./growth-contest-campaigns').sourceBase(env); } catch (e) { errors.push(e.message); }

  // Hostname only (never credentials), so the operator can confirm the cluster
  // and pin it with GROWTH_TEST_ATLAS_HOST.
  let host = null; try { host = uri ? new URL(uri).hostname : null; } catch {}
  const config = {
    mode: 'isolated', onVercel, database: { kind: dbKind, name: DATABASE, host, hostPinned: Boolean(env.GROWTH_TEST_ATLAS_HOST) }, delivery,
    discoveryEnabled: env.GROWTH_DISCOVERY_ENABLED !== 'false',
    discoveryLimitPerWorker: Math.min(25, Math.max(1, Number(env.GROWTH_DISCOVERY_LIMIT || 10))),
    unsubscribeBaseUrl: String(env.GROWTH_UNSUBSCRIBE_BASE_URL || ''),
    staleRunMinutes: Math.max(5, Number(env.GROWTH_STALE_RUN_MINUTES || 30)),
    contestSourceUrl,
    marketingHorizonDays: Math.min(45, Math.max(3, Number(env.GROWTH_MARKETING_HORIZON_DAYS || 21))),
    maxCampaignsPerSport: Math.min(10, Math.max(1, Number(env.GROWTH_MAX_CAMPAIGNS_PER_SPORT || 3))),
    liveReport: { configured: /^.{20,}$/.test(String(env.GROWTH_LIVE_REPORT_TOKEN || '')) },
    ingest: { configured: String(env.GROWTH_ATTRIBUTION_INGEST_SECRET || '').length >= 32 },
    social: { provider: socialResolved.provider, approved: socialResolved.approved, paused: socialResolved.paused, channels: socialResolved.channels },
    fightUrlDiscovery: env.GROWTH_FIGHT_URL_DISCOVERY !== 'off',
    researchPerRun: Math.min(10, Math.max(0, Number(env.GROWTH_RESEARCH_PER_RUN ?? 4))), // shows researched per 15-minute run (0 = off) // fighter-name addresses from the website (growth-fight-urls.js)
    // Posters: generated from verified contests; served publicly from this service for the platforms to fetch.
    posters: { enabled: env.GROWTH_POSTERS === 'on', perRun: Math.min(20, Math.max(1, Number(env.GROWTH_POSTERS_PER_RUN || 3))), publicOrigin: String(env.GROWTH_PUBLIC_ORIGIN || 'https://fantasymmadness-growth-isolated-tes.vercel.app').replace(/\/+$/, ''), artEnv: { GROWTH_ART_CLOUDINARY_CLOUDS: String(env.GROWTH_ART_CLOUDINARY_CLOUDS || ''), GROWTH_ART_HOSTS: String(env.GROWTH_ART_HOSTS || '') } },
    meta: { redirectUri: metaResolved.redirectUri, liveTestApproved: metaResolved.liveTestApproved, expected: metaResolved.expected },
  };
  // Secrets are kept out of the returned config object.
  const secrets = { mongoUri: uri, cronSecret: String(env.CRON_SECRET || ''), adminJwtSecret: String(env.JWT_SECRET_ADMIN || ''), unsubscribeSecret: String(env.GROWTH_UNSUBSCRIBE_SECRET || ''), resendApiKey: String(env.GROWTH_RESEND_API_KEY || ''), social: socialResolved.secrets, meta: metaResolved, tokenEncryptionKey: String(env.GROWTH_TOKEN_ENCRYPTION_KEY || ''), liveReportToken: String(env.GROWTH_LIVE_REPORT_TOKEN || ''), ingestSecret: String(env.GROWTH_ATTRIBUTION_INGEST_SECRET || '') };
  return { ok: errors.length === 0, errors, warnings, config, secrets };
}

module.exports = { resolveGrowthRuntimeConfig, ISOLATED_PROJECT_ID, ISOLATED_STORE_ID, DATABASE, BUSINESS_SENDER };
