'use strict';
// HTTP surface of the isolated Growth Engine service.
//   GET  /api/growth/health                 public, no secrets: config status
//   GET  /api/growth/cron/tick              Vercel Cron (Authorization: Bearer CRON_SECRET)
//   GET  /api/growth/unsubscribe?token=...  public one-click opt-out
//   POST /api/growth/unsubscribe            RFC 8058 one-click (List-Unsubscribe-Post)
//   /api/growth/admin/*                     back office (Bearer admin JWT, JWT_SECRET_ADMIN)
// Mounted only when resolveGrowthRuntimeConfig() allows it; otherwise only
// /health is mounted and reports exactly what is missing.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { MongoClient } = require('mongodb');
const { resolveGrowthRuntimeConfig } = require('./growth-runtime-config');
const { createDeliveryProvider } = require('./growth-delivery-provider');
const { createGrowthRuntime } = require('./growth-runtime');

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function registerIsolatedGrowthRoutes({ app, env = process.env, express, transport, fetchImpl, connect } = {}) {
  const resolved = resolveGrowthRuntimeConfig(env);
  const router = express.Router();
  router.use(express.json({ limit: '32kb' }));
  router.get('/health', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(resolved.ok ? 200 : 503).json({ ok: resolved.ok, service: 'growth-engine-isolated', mode: 'isolated', errors: resolved.errors, warnings: resolved.warnings, delivery: { provider: resolved.config.delivery.provider, realDelivery: resolved.config.delivery.realDelivery, blockers: resolved.config.delivery.blockers }, database: resolved.config.database });
  });
  if (!resolved.ok) { app.use('/api/growth', router); return { mounted: false, errors: resolved.errors }; }

  const { config, secrets } = resolved;
  // One cached connection per warm serverless instance.
  let runtimePromise = null;
  const getRuntime = () => {
    if (!runtimePromise) {
      runtimePromise = (async () => {
        const client = connect ? await connect(secrets.mongoUri) : await new MongoClient(secrets.mongoUri, { serverSelectionTimeoutMS: 10000, maxPoolSize: 3 }).connect();
        const db = client.db(config.database.name);
        const provider = createDeliveryProvider({ config, secrets, transport, fetchImpl });
        const alertTo = env.GROWTH_ALERT_EMAIL;
        const alertSender = provider.name === 'sandbox-smtp' && transport
          ? (m) => transport.sendMail({ from: 'growth-alerts@localhost', to: 'growth-owner@sandbox.localhost', ...m })
          : (provider.realDelivery && alertTo ? (m) => provider.send({ id: `alert-${Date.now()}`, status: 'approved', ownerApproved: true, sendPermitted: true, recipient: alertTo, listUnsubscribe: config.unsubscribeBaseUrl, ...m }) : null);
        const runtime = createGrowthRuntime({ db, config, secrets, provider, fetchImpl, alertSender });
        await runtime.init();
        // Private handle for isolated social OAuth; never included in API output.
        runtime.socialOAuthDb = db;
        return runtime;
      })().catch((e) => { runtimePromise = null; throw e; });
    }
    return runtimePromise;
  };
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res, await getRuntime()); }
    catch (e) { console.error('[growth] request failed:', e.message); res.status(500).json({ ok: false, message: 'Growth Engine request failed' }); }
  };

  // Social OAuth is opt-in and available ONLY in the isolated Growth Engine.
  // This router remains disabled until sandbox secrets and a dedicated store exist.
  if (env.GROWTH_SOCIAL_OAUTH_ENABLED === 'true') {
    const socialRouter = express.Router();
    let socialInit = null;
    socialRouter.use(async (req, res, next) => {
      if (!/^\/social(?:\/|$)/.test(req.path) && req.path !== '/console') return next();
      try {
        if (!socialInit) socialInit = getRuntime().then((runtime) => {
          const { installGrowthSocialOAuth } = require('./growth-social-oauth-isolated');
          const oauthRouter = express.Router();
          installGrowthSocialOAuth({
            router: oauthRouter, env, db: runtime.socialOAuthDb,
            adminSecret: secrets.adminJwtSecret, fetchImpl,
          });
          return oauthRouter;
        }).catch((error) => { socialInit = null; throw error; });
        const oauthRouter = await socialInit;
        return oauthRouter(req, res, next);
      } catch (error) {
        console.error('[growth-social] isolated setup unavailable:', error.message);
        return res.status(503).json({ ok: false, error: 'social_oauth_unavailable' });
      }
    });
    router.use(socialRouter);
  }

  // ---- scheduler ----
  router.get('/cron/tick', wrap(async (req, res, runtime) => {
    const header = String(req.headers.authorization || '');
    if (!secrets.cronSecret || !safeEqual(header, `Bearer ${secrets.cronSecret}`)) return res.status(401).json({ ok: false });
    const summary = await runtime.tick({ now: new Date() });
    res.json({ ok: true, summary });
  }));

  // ---- unsubscribe ----
  const unsubscribe = wrap(async (req, res, runtime) => {
    const token = String(req.query.token || req.body?.token || '');
    const r = await runtime.unsubscribe(token);
    if (req.method === 'POST') return res.status(r.ok ? 200 : 400).json({ ok: r.ok });
    res.status(r.ok ? 200 : 400).type('html').send(r.ok
      ? '<!doctype html><meta charset="utf-8"><title>Unsubscribed</title><p style="font-family:Arial;max-width:480px;margin:40px auto">You have been unsubscribed from FANTASY MMADNESS outreach. You will not receive further messages.</p>'
      : '<!doctype html><meta charset="utf-8"><title>Link not valid</title><p style="font-family:Arial;max-width:480px;margin:40px auto">This unsubscribe link is not valid. Reply to the message with "unsubscribe" and we will remove you.</p>');
  });
  router.get('/unsubscribe', unsubscribe);
  router.post('/unsubscribe', express.urlencoded({ extended: false, limit: '4kb' }), unsubscribe);

  // ---- back office ----
  const admin = (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    try { req.admin = jwt.verify(token, secrets.adminJwtSecret); return next(); }
    catch { return res.status(401).json({ ok: false, message: 'Admin authentication required' }); }
  };
  const who = (req) => String(req.admin?.email || req.admin?.id || 'admin');
  router.get('/admin/overview', admin, wrap(async (req, res, rt) => res.json({ ok: true, overview: await rt.overview() })));
  router.get('/admin/drafts', admin, wrap(async (req, res, rt) => res.json({ ok: true, drafts: await rt.listDrafts({ status: req.query.status, kind: req.query.kind, limit: req.query.limit }) })));
  router.post('/admin/drafts/:id/approve', admin, wrap(async (req, res, rt) => { const r = await rt.approveDraft(req.params.id, { admin: who(req) }); res.status(r.ok ? 200 : 409).json(r); }));
  router.post('/admin/drafts/:id/reject', admin, wrap(async (req, res, rt) => { const r = await rt.rejectDraft(req.params.id, { admin: who(req), reason: req.body?.reason }); res.status(r.ok ? 200 : 409).json(r); }));
  router.post('/admin/prospects/:id/contact', admin, wrap(async (req, res, rt) => { const r = await rt.addVerifiedContact(req.params.id, { contact: req.body?.contact, kind: req.body?.kind, consentNote: req.body?.consentNote, admin: who(req) }); res.status(r.ok ? 201 : 422).json(r); }));
  router.get('/admin/prospects', admin, wrap(async (req, res, rt) => res.json({ ok: true, prospects: (await rt.collections.prospects.find(req.query.genre ? { genre: String(req.query.genre) } : {}).sort({ firstSeenAt: -1 }).limit(Math.min(500, Number(req.query.limit) || 100)).toArray()).map(({ _id, ...p }) => p) })));
  router.get('/admin/alerts', admin, wrap(async (req, res, rt) => res.json({ ok: true, alerts: await rt.listAlerts({ state: req.query.state === 'all' ? '' : (req.query.state || 'open') }) })));
  router.post('/admin/alerts/:key/ack', admin, wrap(async (req, res, rt) => res.json(await rt.ackAlert(req.params.key, { admin: who(req) }))));
  router.post('/admin/jobs/:id/requeue', admin, wrap(async (req, res, rt) => { const r = await rt.requeueJob(req.params.id, { admin: who(req) }); res.status(r.ok ? 200 : 409).json(r); }));
  router.post('/admin/suppressions', admin, wrap(async (req, res, rt) => { await rt.suppression.suppress(req.body?.address, { source: 'operator', reason: req.body?.reason }); res.status(201).json({ ok: true }); }));
  router.post('/admin/run-now', admin, wrap(async (req, res, rt) => res.json({ ok: true, summary: await rt.tick({ now: new Date() }) })));

  app.use('/api/growth', router);
  return { mounted: true, getRuntime };
}

module.exports = { registerIsolatedGrowthRoutes };
