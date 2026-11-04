'use strict';
// Dedicated isolated OAuth Preview: never boot the legacy game server or any scheduler.
const express = require('express');
const { MongoClient } = require('mongodb');
const { resolveGrowthRuntimeConfig, ISOLATED_PROJECT_ID } = require('./growth-runtime-config');
const { installGrowthSocialOAuth, resolveOAuthConfig } = require('./growth-social-oauth-isolated');
const { isolatedGate } = require('./growth-isolated-gate');
function createPreviewApp({ env = process.env, fetchImpl = globalThis.fetch, connect } = {}) {
  const app = express(); app.disable('x-powered-by'); app.use(isolatedGate); app.use(express.json({ limit: '16kb' }));
  const resolved = resolveGrowthRuntimeConfig(env);
  const errors = [...resolved.errors]; let oauthConfig;
  if (env.VERCEL && (env.VERCEL_ENV !== 'preview' || env.VERCEL_PROJECT_ID !== ISOLATED_PROJECT_ID)) errors.push('Only the isolated Vercel Preview may serve social OAuth');
  if (env.GROWTH_SOCIAL_OAUTH_ENABLED !== 'true') errors.push('GROWTH_SOCIAL_OAUTH_ENABLED must be true');
  try { oauthConfig = resolveOAuthConfig(env); } catch (e) { errors.push(e.message); }
  let dbPromise;
  const database = () => dbPromise ||= (async () => {
    const client = connect ? await connect(resolved.secrets.mongoUri) : await new MongoClient(resolved.secrets.mongoUri, { serverSelectionTimeoutMS: 10000, maxPoolSize: 3 }).connect();
    const db = client.db('fmgrowthtest'); if (db.databaseName !== 'fmgrowthtest') throw Error('wrong database'); await db.command({ ping: 1 }); return db;
  })().catch(e => { dbPromise = null; throw e; });
  app.get('/api/growth/health', async (req, res) => {
    res.set('Cache-Control', 'no-store'); let connected = false;
    if (!errors.length) { try { await database(); connected = true; } catch { /* report only safe status, never connection credentials */ } }
    res.status(!errors.length && connected ? 200 : 503).json({ ok: !errors.length && connected, service: 'growth-social-oauth-isolated-preview', environment: 'preview', database: { name: 'fmgrowthtest', connected, hostPinned: resolved.config.database.hostPinned }, errors, publishingEnabled: false, outboundEnabled: false, providers: oauthConfig ? ['tiktok', 'x'].map(provider => ({provider,configured:!oauthConfig.errors(provider).length,blockers:oauthConfig.errors(provider),callbackUrl:oauthConfig.callback(provider)})) : [] });
  });
  let installed;
  app.use('/api/growth', async (req, res, next) => {
    if (errors.length) return res.status(503).json({ ok:false,error:'isolated_oauth_configuration_required',blockers:errors });
    try {
      installed ||= database().then(db => { const router = express.Router(); installGrowthSocialOAuth({router,env,db,adminSecret:resolved.secrets.adminJwtSecret,fetchImpl}); return router; }).catch(e=>{installed=null;throw e;});
      return (await installed)(req,res,next);
    } catch { return res.status(503).json({ok:false,error:'isolated_oauth_temporarily_unavailable'}); }
  });
  app.use((req,res)=>res.status(404).json({ok:false,error:'not_found'}));
  return app;
}
const app = createPreviewApp();
module.exports = app;
module.exports.createPreviewApp = createPreviewApp;
