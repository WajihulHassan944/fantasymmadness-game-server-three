'use strict';
// HTTP surface of the isolated Growth Engine service.
//   GET  /api/growth/health                 public, no secrets: config status
//   GET  /api/growth/cron/tick              Vercel Cron (Authorization: Bearer CRON_SECRET)
//   GET  /api/growth/unsubscribe?token=...  public one-click opt-out
//   POST /api/growth/unsubscribe            RFC 8058 one-click (List-Unsubscribe-Post)
//   /api/growth/admin/*                     back office (Bearer console token: key derived from JWT_SECRET_ADMIN, own audience)
// Mounted only when resolveGrowthRuntimeConfig() allows it; otherwise only
// /health is mounted and reports exactly what is missing.
const crypto = require('crypto');
const { signConsoleToken, verifyConsoleToken, consolePasswordVersion } = require('./growth-console-token');
const { MongoClient } = require('mongodb');
const { resolveGrowthRuntimeConfig } = require('./growth-runtime-config');
const { createDeliveryProvider } = require('./growth-delivery-provider');
const { createGrowthRuntime } = require('./growth-runtime');
const fs = require('fs');
const path = require('path');
const { createBackoffice, verifyPassword, createLoginLimiter } = require('./growth-backoffice');
const { verifySignature } = require('./growth-affiliate-program');
const { checkEmailReadiness } = require('./growth-email-readiness');
const { BUSINESS_SENDER } = require('./growth-runtime-config');

// Back-office console assets (served only by the isolated project).
// Literal paths so the Vercel bundler traces and ships these files with the function.
const CONSOLE_FILES = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'application/javascript; charset=utf-8', 'app.css': 'text/css; charset=utf-8' };
const readAsset = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
const CONSOLE_ASSETS = {
  'index.html': readAsset(path.join(__dirname, 'growth-console', 'index.html')),
  'app.js': readAsset(path.join(__dirname, 'growth-console', 'app.js')),
  'app.css': readAsset(path.join(__dirname, 'growth-console', 'app.css')),
};
// The console may be embedded ONLY by the origins listed in GROWTH_CONSOLE_EMBED_ORIGINS
// (the FANTASY MMADNESS admin site). Anything else cannot frame it.
const embedOrigins = (env) => String(env.GROWTH_CONSOLE_EMBED_ORIGINS || '').split(/[\s,]+/).filter((o) => /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o) && (o.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)));
const consoleCsp = (origins) => `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${origins.length ? origins.join(' ') : "'none'"}`;
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
    res.status(resolved.ok ? 200 : 503).json({ ok: resolved.ok, service: 'growth-engine-isolated', mode: 'isolated', errors: resolved.errors, warnings: resolved.warnings, delivery: { provider: resolved.config.delivery.provider, realDelivery: resolved.config.delivery.realDelivery, blockers: resolved.config.delivery.blockers }, database: resolved.config.database, console: { path: '/api/growth/console', signInConfigured: Boolean(env.GROWTH_ADMIN_PASSWORD_HASH), embedOrigins: embedOrigins(env) } });
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
    const body = CONSOLE_ASSETS[file];
    if (!body) return res.status(404).end();
    const origins = embedOrigins(env);
    res.set({ 'Content-Type': CONSOLE_FILES[file], 'Cache-Control': 'no-store', 'Content-Security-Policy': consoleCsp(origins), 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    if (!origins.length) res.set('X-Frame-Options', 'DENY');
    res.send(body);
  };
  router.get('/console', sendConsole('index.html'));
  router.get('/console/app.js', sendConsole('app.js'));
  router.get('/console/app.css', sendConsole('app.css'));

  // Console sign-in: owner password (scrypt hash in GROWTH_ADMIN_PASSWORD_HASH)
  // exchanged for a 12-hour admin token signed with this project's JWT_SECRET_ADMIN.
  const limiter = createLoginLimiter();
  // Console tokens carry a fingerprint of the current password hash, so
  // rotating GROWTH_ADMIN_PASSWORD_HASH signs out every earlier console session.
  const passwordVersion = consolePasswordVersion(env.GROWTH_ADMIN_PASSWORD_HASH);
  router.post('/admin/login', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const stored = String(env.GROWTH_ADMIN_PASSWORD_HASH || '');
    if (!stored) return res.status(503).json({ ok: false, message: 'Console sign-in is not configured (GROWTH_ADMIN_PASSWORD_HASH).' });
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    if (!limiter.allow(ip)) return res.status(429).json({ ok: false, message: 'Too many sign-in attempts. Wait 15 minutes and try again.' });
    if (!verifyPassword(typeof req.body?.password === 'string' ? req.body.password : '', stored)) return res.status(401).json({ ok: false, message: 'Incorrect password.' });
    limiter.reset(ip);
    const token = signConsoleToken(secrets.adminJwtSecret, { pwv: passwordVersion });
    res.json({ ok: true, token, expiresInHours: 12 });
  });

  // ---- back office ----
  const admin = (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    // Only Growth Engine console tokens are accepted (dedicated key + audience); a live
    // back-office admin token is rejected here, and console tokens are useless on the live API.
    try { req.admin = verifyConsoleToken(secrets.adminJwtSecret, token); }
    catch { return res.status(401).json({ ok: false, message: 'Admin authentication required' }); }
    if (req.admin.pwv !== passwordVersion) return res.status(401).json({ ok: false, message: 'Session ended because the console password was changed' });
    return next();
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


  // ---- verified events from a trusted server (HMAC-signed; read-only for production) ----
  app.post('/api/growth/events', express.raw({ type: '*/*', limit: '16kb' }), wrap(async (req, res, rt) => {
    const raw = typeof req.rawBody === 'string' ? req.rawBody : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body || {});
    const sig = verifySignature({ secret: secrets.ingestSecret, rawBody: raw, timestamp: req.headers['x-growth-timestamp'], signature: req.headers['x-growth-signature'] });
    if (!sig.ok) return res.status(sig.reason === 'ingest_not_configured' ? 503 : 401).json({ ok: false, reason: sig.reason });
    let body; try { body = JSON.parse(raw); } catch { return res.status(400).json({ ok: false, reason: 'invalid_json' }); }
    const r = await rt.affiliates.ingest(body);
    res.status(r.ok ? 200 : 422).json(r);
  }));

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
  router.get('/admin/marketing/coverage', admin, wrap(async (req, res, rt) => res.json({ ok: true, coverage: await bo(rt).marketingCoverage() })));
  router.post('/admin/marketing/refresh', admin, wrap(async (req, res, rt) => { const r = await rt.refreshMarketing(new Date(), { trigger: `owner:${who(req)}` }); res.json({ ok: true, result: { created: r.created, withdrawn: r.withdrawn, blocked: r.blocked, verifiedContests: r.contests.length, sourceReachable: r.sourceReachable } }); }));
  router.get('/admin/analytics', admin, wrap(async (req, res, rt) => res.json({ ok: true, analytics: await bo(rt).analytics() })));
  router.get('/admin/attribution', admin, wrap(async (req, res, rt) => res.json({ ok: true, attribution: await bo(rt).attribution() })));
  router.get('/admin/reports', admin, wrap(async (req, res, rt) => res.json({ ok: true, reports: await bo(rt).reports({ limit: req.query.limit }) })));
  router.get('/admin/audit', admin, wrap(async (req, res, rt) => res.json({ ok: true, entries: await bo(rt).auditLog({ limit: req.query.limit }) })));
  router.get('/admin/suppressions', admin, wrap(async (req, res, rt) => res.json({ ok: true, suppressions: await bo(rt).suppressions({ limit: req.query.limit }) })));

  // ---- publishing (approval-gated) ----
  // Channel readiness is evaluated live (the Meta connection can change at any time).
  const liveChannels = async (rt) => Object.fromEntries(await Promise.all(Object.keys(resolved.config.social.channels).map(async (ch) => [ch, await rt.publisher.channelState(ch)])));
  router.get('/admin/social', admin, wrap(async (req, res, rt) => res.json({ ok: true, posts: await rt.social.list({ status: req.query.status }), paused: await rt.social.isPaused(), provider: resolved.config.social.provider, channels: await liveChannels(rt), liveTestApproved: resolved.config.meta.liveTestApproved })));
  router.post('/admin/drafts/:id/schedule', admin, wrap(async (req, res, rt) => { const r = await rt.social.schedule(req.params.id, { channels: req.body?.channels, scheduledAt: req.body?.scheduledAt, affiliateId: req.body?.affiliateId || null, admin: who(req) }); res.status(r.ok ? 200 : 409).json(r); }));
  router.post('/admin/social/live-test', admin, wrap(async (req, res, rt) => { const r = await rt.social.liveTest(req.body?.draftId, { channel: req.body?.channel, confirmText: req.body?.confirmText, admin: who(req) }); res.status(r.ok ? 200 : 409).json(r); }));

  // ---- Meta (Facebook Page + Instagram) connection ----
  const metaView = async (rt) => {
    const st = await rt.meta.status(); const ch = await liveChannels(rt);
    const mode = (c) => (c.mode === 'live' ? 'live' : c.mode === 'sandbox' ? 'sandbox' : 'off');
    return { ...st, connectionLabel: st.state === 'connected' ? 'Connected' : st.state === 'not_set_up' ? 'Not set up' : st.state === 'selection_needed' ? 'Choose your Page' : 'Authorization needed', publishing: { provider: resolved.config.social.provider, facebook: mode(ch.facebook), instagram: mode(ch.instagram), liveTestApproved: resolved.config.meta.liveTestApproved } };
  };
  router.get('/admin/meta', admin, wrap(async (req, res, rt) => res.json({ ok: true, meta: await metaView(rt) })));
  router.post('/admin/meta/app', admin, wrap(async (req, res, rt) => { const r = await rt.meta.setApp({ appId: req.body?.appId, appSecret: req.body?.appSecret, loginConfigId: req.body?.loginConfigId, admin: who(req) }); res.status(r.ok ? 200 : 422).json(r); }));
  router.post('/admin/meta/connect', admin, wrap(async (req, res, rt) => { const r = await rt.meta.startAuthorization({ admin: who(req) }); res.status(r.ok ? 200 : 409).json(r); }));
  router.post('/admin/meta/select', admin, wrap(async (req, res, rt) => { const r = await rt.meta.selectPage({ pageId: req.body?.pageId, confirm: req.body?.confirm === true, admin: who(req) }); res.status(r.ok ? 200 : 409).json(r.ok ? { ok: true, meta: await metaView(rt) } : r); }));
  router.post('/admin/meta/check', admin, wrap(async (req, res, rt) => { const r = await rt.meta.healthCheck({ force: true }); res.json({ ok: true, check: r, meta: await metaView(rt) }); }));
  router.post('/admin/meta/disconnect', admin, wrap(async (req, res, rt) => { await rt.meta.disconnect({ admin: who(req) }); res.json({ ok: true, meta: await metaView(rt) }); }));

  // Meta sends the owner's browser back here after sign-in (state-protected, single use).
  const CALLBACK_TEXT = {
    ok_select: ['Facebook & Instagram authorized', 'Go back to the Growth Engine tab and choose your FANTASY MMADNESS Page. This tab will close.'],
    ok_connected: ['Facebook & Instagram connected', 'You can close this tab and go back to the Growth Engine.'],
    you_cancelled_on_meta: ['Nothing was connected', 'You cancelled on Meta. Go back to the Growth Engine and press "Connect Facebook & Instagram" to try again.'],
    link_expired_or_already_used_start_again: ['This sign-in link has expired', 'Go back to the Growth Engine and press "Connect Facebook & Instagram" again.'],
    default: ['Facebook & Instagram could not be connected', 'Go back to the Growth Engine: the Connections screen shows what happened and what to do next.'],
  };
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  router.get('/meta/callback', wrap(async (req, res, rt) => {
    const q = req.query || {};
    let r; try { r = await rt.meta.handleCallback({ code: typeof q.code === 'string' ? q.code : '', state: typeof q.state === 'string' ? q.state : '', error: typeof q.error === 'string' ? q.error : '', errorReason: typeof q.error_reason === 'string' ? q.error_reason : '' }); }
    catch (e) { r = { ok: false, reason: 'default' }; }
    const [title, body] = CALLBACK_TEXT[r.ok ? (r.needsSelection ? 'ok_select' : 'ok_connected') : r.reason] || CALLBACK_TEXT.default;
    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
    res.status(r.ok ? 200 : 400).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · FANTASY MMADNESS Growth Engine</title><style>body{font:17px/1.5 system-ui,sans-serif;background:#0d0f14;color:#eef1f6;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:480px;padding:28px;border:1px solid #2a3040;border-radius:14px;background:#151924}h1{font-size:22px;margin:0 0 10px}</style></head><body data-ok="${r.ok ? 1 : 0}" data-testid="meta-callback"><main><h1>${esc(title)}</h1><p>${esc(body)}</p></main><script src="/api/growth/meta/callback.js"></script></body></html>`);
  }));
  router.get('/meta/callback.js', (req, res) => {
    res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.send("(function(){try{history.replaceState(null,'',location.pathname);}catch(e){}var ok=document.body.getAttribute('data-ok')==='1';try{if(window.opener&&window.opener!==window)window.opener.postMessage({type:'fmm-meta-connect',ok:ok},location.origin);}catch(e){}if(ok)setTimeout(function(){try{window.close();}catch(e){}},2500);})();");
  });
  router.post('/admin/social/pause', admin, wrap(async (req, res, rt) => res.json({ ok: true, paused: await rt.social.setPaused(req.body?.paused === true, { admin: who(req) }) })));
  router.post('/admin/social/:id/cancel', admin, wrap(async (req, res, rt) => { const r = await rt.social.cancel(req.params.id, { admin: who(req) }); res.status(r.ok ? 200 : 409).json(r); }));
  router.post('/admin/social/:id/retry', admin, wrap(async (req, res, rt) => { const r = await rt.social.retry(req.params.id, { admin: who(req), confirmNotPublished: req.body?.confirmNotPublished === true }); res.status(r.ok ? 200 : 409).json(r); }));

  // ---- affiliates ----
  router.get('/admin/affiliates', admin, wrap(async (req, res, rt) => res.json({ ok: true, affiliates: await rt.affiliates.list(await bo(rt).activeContests()) })));
  router.post('/admin/affiliates/:id/status', admin, wrap(async (req, res, rt) => { const r = await rt.affiliates.transition(req.params.id, String(req.body?.status || ''), { admin: who(req), note: req.body?.note, liveAffiliateId: req.body?.liveAffiliateId }); res.status(r.ok ? 200 : 409).json(r); }));

  // ---- reports + connections ----
  router.get('/admin/funnel', admin, wrap(async (req, res, rt) => res.json({ ok: true, funnel: await bo(rt).funnel() })));
  router.get('/admin/email/readiness', admin, wrap(async (req, res) => res.json({ ok: true, readiness: await checkEmailReadiness({ delivery: resolved.config.delivery, sender: BUSINESS_SENDER, apiKey: secrets.resendApiKey, fetchImpl: fetchImpl || globalThis.fetch }) })));
  router.get('/admin/connections', admin, wrap(async (req, res, rt) => res.json({ ok: true, connections: {
    contestFeed: { url: resolved.config.contestSourceUrl, readOnly: true },
    social: { provider: resolved.config.social.provider, approved: resolved.config.social.approved, paused: await rt.social.isPaused(), channels: await liveChannels(rt) },
    meta: await metaView(rt),
    email: { provider: resolved.config.delivery.provider, realDelivery: resolved.config.delivery.realDelivery, blockers: resolved.config.delivery.blockers, sender: BUSINESS_SENDER },
    liveRegistrationReport: { configured: resolved.config.liveReport.configured, latest: await rt.collections.liveReports.find({}).sort({ day: -1 }).limit(1).next().then((r) => (r ? { day: r.day, campaigns: r.groups.length } : null)) },
    verifiedEventIngest: { configured: resolved.config.ingest.configured, path: '/api/growth/events' },
  } })));

  app.use('/api/growth', router);
  return { mounted: true, getRuntime };
}

module.exports = { registerIsolatedGrowthRoutes };
