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
const fs = require('fs');
const path = require('path');
const { createBackoffice, verifyPassword, createLoginLimiter } = require('./growth-backoffice');

// Back-office console assets (served only by the isolated project).
const CONSOLE_DIR = path.join(__dirname, 'growth-console');
const CONSOLE_FILES = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'application/javascript; charset=utf-8', 'app.css': 'text/css; charset=utf-8' };
const CONSOLE_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const EMAIL_RE = /^[^\s@<>()",;:]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

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
    res.status(resolved.ok ? 200 : 503).json({ ok: resolved.ok, service: 'growth-engine-isolated', mode: 'isolated', errors: resolved.errors, warnings: resolved.warnings, delivery: { provider: resolved.config.delivery.provider, realDelivery: resolved.config.delivery.realDelivery, blockers: resolved.config.delivery.blockers }, database: resolved.config.database, console: { path: '/api/growth/console', signInConfigured: Boolean(env.GROWTH_ADMIN_PASSWORD_HASH) } });
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
        return runtime;
      })().catch((e) => { runtimePromise = null; throw e; });
    }
    return runtimePromise;
  };
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res, await getRuntime()); }
    catch (e) { console.error('[growth] request failed:', e.message); res.status(500).json({ ok: false, message: 'Growth Engine request failed' }); }
  };

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

  // ---- back-office console (static, same origin as the API) ----
  const sendConsole = (file) => (req, res) => {
    let body; try { body = fs.readFileSync(path.join(CONSOLE_DIR, file)); } catch { return res.status(404).end(); }
    res.set({ 'Content-Type': CONSOLE_FILES[file], 'Cache-Control': 'no-store', 'Content-Security-Policy': CONSOLE_CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
    res.send(body);
  };
  router.get('/console', sendConsole('index.html'));
  router.get('/console/app.js', sendConsole('app.js'));
  router.get('/console/app.css', sendConsole('app.css'));

  // Console sign-in: owner password (scrypt hash in GROWTH_ADMIN_PASSWORD_HASH)
  // exchanged for a 12-hour admin token signed with this project's JWT_SECRET_ADMIN.
  const limiter = createLoginLimiter();
  router.post('/admin/login', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const stored = String(env.GROWTH_ADMIN_PASSWORD_HASH || '');
    if (!stored) return res.status(503).json({ ok: false, message: 'Console sign-in is not configured (GROWTH_ADMIN_PASSWORD_HASH).' });
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    if (!limiter.allow(ip)) return res.status(429).json({ ok: false, message: 'Too many sign-in attempts. Wait 15 minutes and try again.' });
    if (!verifyPassword(typeof req.body?.password === 'string' ? req.body.password : '', stored)) return res.status(401).json({ ok: false, message: 'Incorrect password.' });
    limiter.reset(ip);
    const token = jwt.sign({ email: 'owner@growth-console', role: 'growth_owner' }, secrets.adminJwtSecret, { expiresIn: '12h' });
    res.json({ ok: true, token, expiresInHours: 12 });
  });

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
  router.post('/admin/suppressions', admin, wrap(async (req, res, rt) => {
    const address = String(req.body?.address || '').trim();
    if (!EMAIL_RE.test(address) || address.length > 254) return res.status(422).json({ ok: false, reason: 'valid_email_required' });
    await rt.suppression.suppress(address, { source: 'operator', reason: req.body?.reason });
    await rt.collections.audit.insertOne({ action: 'suppress', admin: who(req), at: new Date().toISOString() });
    res.status(201).json({ ok: true });
  }));
  router.post('/admin/run-now', admin, wrap(async (req, res, rt) => res.json({ ok: true, summary: await rt.tick({ now: new Date() }) })));


  // ---- console read models + owner actions ----
  let backoffice = null;
  const bo = (rt) => (backoffice ||= createBackoffice({ runtime: rt }));
  router.get('/admin/session', admin, (req, res) => res.json({ ok: true, admin: who(req), exp: req.admin.exp || null }));
  router.get('/admin/status', admin, wrap(async (req, res, rt) => res.json({ ok: true, scheduler: await bo(rt).schedulerStatus(), delivery: { provider: resolved.config.delivery.provider, realDelivery: resolved.config.delivery.realDelivery, blockers: resolved.config.delivery.blockers }, database: { name: resolved.config.database.name, kind: resolved.config.database.kind, hostPinned: resolved.config.database.hostPinned }, warnings: resolved.warnings })));
  router.get('/admin/runs', admin, wrap(async (req, res, rt) => res.json({ ok: true, runs: await bo(rt).runs({ limit: req.query.limit }) })));
  router.get('/admin/jobs', admin, wrap(async (req, res, rt) => res.json({ ok: true, jobs: await bo(rt).jobs({ state: req.query.state, limit: req.query.limit }) })));
  router.get('/admin/workstreams', admin, wrap(async (req, res, rt) => res.json({ ok: true, ...(await bo(rt).workstreams({ runId: req.query.runId, department: req.query.department })) })));
  router.get('/admin/workstreams/:runId/:workstreamId', admin, wrap(async (req, res, rt) => { const w = await bo(rt).workstreamDetail(req.params.runId, req.params.workstreamId); res.status(w ? 200 : 404).json(w ? { ok: true, workstream: w } : { ok: false, reason: 'not_found' }); }));
  router.post('/admin/drafts/:id/edit', admin, wrap(async (req, res, rt) => { const r = await bo(rt).editDraft(req.params.id, { headline: req.body?.headline, text: req.body?.text, subject: req.body?.subject, admin: who(req) }); res.status(r.ok ? 200 : (r.reason === 'not_found' ? 404 : 409)).json(r); }));
  router.post('/admin/drafts/:id/mark-published', admin, wrap(async (req, res, rt) => { const r = await bo(rt).markPublished(req.params.id, { postUrl: req.body?.postUrl, admin: who(req) }); res.status(r.ok ? 200 : 409).json(r); }));
  router.get('/admin/analytics', admin, wrap(async (req, res, rt) => res.json({ ok: true, analytics: await bo(rt).analytics() })));
  router.get('/admin/attribution', admin, wrap(async (req, res, rt) => res.json({ ok: true, attribution: await bo(rt).attribution() })));
  router.get('/admin/reports', admin, wrap(async (req, res, rt) => res.json({ ok: true, reports: await bo(rt).reports({ limit: req.query.limit }) })));
  router.get('/admin/audit', admin, wrap(async (req, res, rt) => res.json({ ok: true, entries: await bo(rt).auditLog({ limit: req.query.limit }) })));
  router.get('/admin/suppressions', admin, wrap(async (req, res, rt) => res.json({ ok: true, suppressions: await bo(rt).suppressions({ limit: req.query.limit }) })));

  app.use('/api/growth', router);
  return { mounted: true, getRuntime };
}

module.exports = { registerIsolatedGrowthRoutes };
