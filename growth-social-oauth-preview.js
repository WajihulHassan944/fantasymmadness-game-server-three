'use strict';
// Dedicated isolated OAuth Preview: never boot the legacy game server or any scheduler.
const express = require('express');
const { MongoClient } = require('mongodb');
const { resolveGrowthRuntimeConfig, ISOLATED_PROJECT_ID } = require('./growth-runtime-config');
const { installGrowthSocialOAuth, resolveOAuthConfig } = require('./growth-social-oauth-isolated');
const PREFIX = 'preview198_';
const { isolatedGate } = require('./growth-isolated-gate');
function createPreviewApp({ env = process.env, fetchImpl = globalThis.fetch, connect } = {}) {
  const app = express(); app.disable('x-powered-by'); app.use(isolatedGate); app.use(express.json({ limit: '16kb' }));
  const resolved = resolveGrowthRuntimeConfig(env);
  const errors = [...resolved.errors]; let oauthConfig;
  if (env.VERCEL && (env.VERCEL_ENV !== 'preview' || env.VERCEL_PROJECT_ID !== ISOLATED_PROJECT_ID)) errors.push('Only the isolated Vercel Preview may serve social OAuth');
  if (env.GROWTH_SOCIAL_OAUTH_ENABLED !== 'true') errors.push('GROWTH_SOCIAL_OAUTH_ENABLED must be true');
  try { oauthConfig = resolveOAuthConfig(env); } catch (e) { errors.push(e.message); }
  const integrated = env.GROWTH_BACKOFFICE_INTEGRATED === 'true';
  if (integrated && (env.GROWTH_DELIVERY_PROVIDER !== 'sandbox-capture' || env.GROWTH_SOCIAL_PROVIDER !== 'sandbox' || env.GROWTH_OUTBOUND_ENABLED !== 'false')) errors.push('Integrated Preview requires sandbox-capture, sandbox social and outbound disabled');
  const origin = env.GROWTH_SOCIAL_ADMIN_SITE_ORIGIN;
  app.use('/api/growth', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (origin && req.headers.origin === origin) res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS' });
    if (integrated && ((req.method !== 'GET' && /^\/admin\/meta\/(app|connect|select|disconnect)$/.test(req.path)) || req.path === '/meta/callback')) return res.status(409).json({ ok: false, error: 'existing_meta_credentials_preserved_read_only' });
    if (req.method === 'OPTIONS') return res.status(req.headers.origin === origin ? 204 : 403).end();
    if (integrated && (req.path.startsWith('/cron/') || req.path === '/admin/social/live-test' || /\/mark-published$/.test(req.path) || req.path === '/events')) return res.status(404).json({ ok: false, error: 'disabled_in_isolated_preview' });
    next();
  });
  let dbPromise;
  const database = () => dbPromise ||= (async () => {
    const client = connect ? await connect(resolved.secrets.mongoUri) : await new MongoClient(resolved.secrets.mongoUri, { serverSelectionTimeoutMS: 10000, maxPoolSize: 3 }).connect();
    const db = client.db('fmgrowthtest'); if (db.databaseName !== 'fmgrowthtest') throw Error('wrong database'); await db.command({ ping: 1 }); return db;
  })().catch(e => { dbPromise = null; throw e; });
  let existingMeta,posterHttpHealth;
  const metaConnection = async () => existingMeta ||= require('./growth-existing-meta-readonly').createExistingMetaReadOnly({ db: await database(), env, fetchImpl });
  app.get('/api/growth/health', async (req, res) => {
    res.set('Cache-Control', 'no-store'); let connected = false;
    if (!errors.length) { try { await database(); connected = true; } catch { /* report only safe status, never connection credentials */ } }
    let meta = null; if (integrated && connected) { try { meta = await (await metaConnection()).summary(); } catch { meta = { investigation: 'unavailable', credentialsChanged: false }; } }
    let posterVerification=null;if(integrated&&connected){try{posterHttpHealth ||= require('./growth-poster-http-health').createPosterHttpHealth({db:await database(),origin:env.GROWTH_SOCIAL_PUBLIC_ORIGIN,fetchImpl});posterVerification=await posterHttpHealth.check();}catch{posterVerification={error:'staging_poster_verification_unavailable',imagesExported:false};}}
    res.status(!errors.length && connected ? 200 : 503).json({ ok: !errors.length && connected, service: 'growth-social-oauth-isolated-preview', environment: 'preview', database: { name: 'fmgrowthtest', connected, hostPinned: resolved.config.database.hostPinned }, errors, publishingEnabled: false, outboundEnabled: false, existingMeta: meta, posterVerification, backoffice: { integrated, collectionPrefix: integrated ? PREFIX : null }, console: { embedOrigins: origin ? [origin] : [] }, providers: oauthConfig ? ['tiktok', 'x'].map(provider => ({provider,configured:!oauthConfig.errors(provider).length,blockers:oauthConfig.errors(provider),callbackUrl:oauthConfig.callback(provider)})) : [] });
  });
  let installed;
  app.use('/api/growth', async (req, res, next) => {
    if (errors.length) return res.status(503).json({ ok:false,error:'isolated_oauth_configuration_required',blockers:errors });
    try {
      installed ||= database().then(async db => {
        const router = express.Router();
        const oauth = installGrowthSocialOAuth({router,env,db,adminSecret:resolved.secrets.adminJwtSecret,fetchImpl});
        if (integrated) {
          // OAuth records remain untouched. Every department write gets a distinct namespace.
          const scopedDb = { databaseName: 'fmgrowthtest', collection: name => { if (!/^[a-z_]+$/.test(name)) throw Error('Invalid staging collection'); return db.collection(PREFIX + name); } };
          const runtimeEnv = { ...env, GROWTH_PUBLIC_ORIGIN: env.GROWTH_SOCIAL_PUBLIC_ORIGIN, GROWTH_CONSOLE_EMBED_ORIGINS: origin || '' };
          const { registerIsolatedGrowthRoutes } = require('./growth-isolated-routes');
          registerIsolatedGrowthRoutes({ app: { use: (_path, fullRouter) => router.use(fullRouter), post: (path, ...handlers) => router.post(path.replace(/^\/api\/growth/, ''), ...handlers) }, env: runtimeEnv, express, fetchImpl, connect: async () => ({ db: () => scopedDb }), metaConnection: await metaConnection(), sessionAuth: (req, res, next) => oauth.auth(req, res, () => { req.admin = req.socialAdmin; next(); }) });
        }
        return router;
      }).catch(e=>{installed=null;throw e;});
      return (await installed)(req,res,next);
    } catch { return res.status(503).json({ok:false,error:'isolated_oauth_temporarily_unavailable'}); }
  });
  app.use((req,res)=>res.status(404).json({ok:false,error:'not_found'}));
  return app;
}
const app = createPreviewApp();
module.exports = app;
module.exports.createPreviewApp = createPreviewApp;
