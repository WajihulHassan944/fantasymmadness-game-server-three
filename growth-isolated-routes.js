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
const { runSyntheticJourney } = require('./growth-synthetic-journey');
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
        const captureCollection = db.collection('growth_sandbox_mail');
        if (config.delivery.provider === 'sandbox-capture') await captureCollection.createIndex({ id: 1 }, { unique: true });
        const provider = createDeliveryProvider({ config, secrets, transport, fetchImpl, captureCollection });
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

  // ---- posters (public: Facebook/Instagram/TikTok fetch them by address) ----
  router.get('/posters/:file', wrap(async (req, res, rt) => {
    const m = String(req.params.file || '').match(/^([a-f0-9]{20}-(portrait|story))\.jpg$/);
    const img = m ? await rt.posters.getImage(m[1]) : null;
    if (!img) return res.status(404).set('Cache-Control', 'no-store').json({ ok: false, error: 'not_found' });
    const fmt = require('./growth-poster-studio').FORMATS[m[2]];
    res.set({ 'Content-Type': img.contentType, 'Content-Length': String(img.buffer.length), 'Cache-Control': 'public, max-age=600', ETag: `"${img.sha256.slice(0, 32)}"`, 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'cross-origin', 'X-Image-Width': String(fmt.width), 'X-Image-Height': String(fmt.height) });
    if (req.method === 'HEAD') return res.end();
    res.end(img.buffer);
  }));

  // ---- staging acceptance evidence (public, read-only, non-sensitive summary written by the live check) ----
  router.get('/acceptance', wrap(async (req, res, rt) => {
    const rows = await rt.collections.acceptance.find({}, { projection: { _id: 0, id: 1, at: 1, public: 1 } }).sort({ at: -1 }).limit(5).toArray();
    res.set('Cache-Control', 'no-store').json({ ok: true, service: 'growth-engine-isolated', note: 'Staging acceptance evidence. Sandbox only: nothing here was posted or sent for real.', runs: rows });
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
    if (!origins.length) res.set('X-Frame-Options', 'DENY'); else res.removeHeader('X-Frame-Options'); // CSP frame-ancestors is the single source of truth
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
  router.post('/admin/drafts/:id/approve', admin, wrap(async (req, res, rt) => { const r = await rt.approveDraft(req.params.id, { admin: who(req), acceptTextPoster: req.body?.acceptTextPoster === true }); res.status(r.ok ? 200 : 409).json(r); }));
  router.post('/admin/drafts/:id/reject', admin, wrap(async (req, res, rt) => { const r = await rt.rejectDraft(req.params.id, { admin: who(req), reason: req.body?.reason }); res.status(r.ok ? 200 : 409).json(r); }));
  router.post('/admin/prospects/:id/contact', admin, wrap(async (req, res, rt) => { const r = await rt.addVerifiedContact(req.params.id, { contact: req.body?.contact, kind: req.body?.kind, consentNote: req.body?.consentNote, admin: who(req) }); res.status(r.ok ? 201 : 422).json(r); }));
  // Research results for one department (PR or affiliate): one row per show, with evidence,
  // published contact, outcome, and the draft it produced. No secrets; read-only.
  router.get('/admin/research', admin, wrap(async (req, res, rt) => {
    const track = req.query.track === 'affiliate' ? 'affiliate' : 'pr';
    const focus = track === 'pr' ? 'partners' : 'fans';
    const rows = await rt.collections.prospects.find({ track }).sort({ score: -1 }).limit(600).toArray();
    const seen = new Set(); const shows = [];
    for (const p of rows.sort((a, b) => (a.focus === focus ? -1 : 1) - (b.focus === focus ? -1 : 1) || (b.score || 0) - (a.score || 0))) {
      if (seen.has(p.sourceUrl)) continue; seen.add(p.sourceUrl);
      const r = p.research || {};
      shows.push({ id: p.id, name: p.name, genre: p.genre, sourceUrl: p.sourceUrl, score: p.score ?? null, outcome: p.researchOutcome || null, researchedAt: p.researchedAt || null, optedOut: p.optedOut === true,
        show: r.show || null, active: r.active === true, recentEpisode: (r.recentEpisodes || [])[0] || null, evidence: (r.evidence || []).slice(0, 3), feed: r.source?.feed || null,
        contact: r.contact ? { email: r.contact.email, name: r.contact.name || null, source: r.contact.source, field: r.contact.field, basis: r.contact.basis } : (p.contactVerified ? { email: p.contact, manual: true, basis: p.consentNote || null } : null),
        contactProblems: r.contactProblems || [], angle: p.outreach?.angle || null, draftId: p.outreach ? `${track}-${p.id}` : null, error: r.error || null });
    }
    shows.sort((a, b) => (b.score || 0) - (a.score || 0));
    const pending = await rt.collections.prospects.countDocuments({ verified: true, optedOut: { $ne: true }, researchedAt: { $exists: false } });
    const count = (o) => shows.filter((x) => x.outcome === o).length;
    res.json({ ok: true, track, shows: req.query.genre ? shows.filter((x) => x.genre === req.query.genre) : shows,
      counts: { researched: shows.length, drafted: shows.filter((x) => x.draftId).length, publishedContacts: shows.filter((x) => x.contact && !x.contact.manual).length, noContact: count('no_verified_contact_route'), noAngle: count('no_evidence_based_angle'), failed: count('research_failed'), waitingForResearch: pending },
      bySport: Object.fromEntries(['boxing', 'mma-ufc', 'kickboxing', 'bare-knuckle', 'pro-wrestling'].map((g) => [g, shows.filter((x) => x.genre === g).length])) });
  }));
  // Sandbox outbox: emails built exactly as they would be sent, never sent.
  router.get('/admin/email/sandbox', admin, wrap(async (req, res) => {
    const rt = await getRuntime();
    const rows = await rt.collections.sandboxMail.find({}).sort({ capturedAt: -1 }).limit(Math.min(100, Number(req.query.limit) || 30)).toArray();
    res.json({ ok: true, provider: resolved.config.delivery.provider, realDelivery: resolved.config.delivery.realDelivery, count: await rt.collections.sandboxMail.countDocuments(), messages: rows.map(({ _id, ...m }) => m) });
  }));
  // Synthetic money-path journey (staging test lane; no payment system is contacted).
  router.post('/admin/synthetic/journey', admin, wrap(async (req, res, rt) => {
    const contests = await bo(rt).activeContests();
    const r = await runSyntheticJourney({ col: rt.collections, signedIngest: (raw, h) => signedIngest(rt, raw, h), secret: secrets.ingestSecret, contest: contests[0] || null });
    if (r.ok !== undefined) await rt.collections.audit.insertOne({ action: 'synthetic_journey', admin: who(req), run: r.run || null, passed: r.ok === true, at: new Date().toISOString() });
    const lane = (await bo(rt).attribution()).synthetic;
    res.status(r.reason === 'ingest_not_configured' ? 409 : 200).json({ ...r, lane });
  }));
  // Executive summary: one honest status per department + actionable exceptions.
  router.get('/admin/executive', admin, wrap(async (req, res, rt) => {
    const c = rt.collections; const n = (col, q) => col.countDocuments(q);
    const sched = await bo(rt).schedulerStatus(); const meta = await rt.meta.status(); const ch = await liveChannels(rt);
    const att = await bo(rt).attribution(); const lastJourney = await c.audit.find({ action: 'synthetic_journey' }).sort({ at: -1 }).limit(1).next();
    const openAlerts = await c.alerts.find({ state: 'open' }).sort({ createdAt: -1 }).limit(20).toArray();
    const held = await n(c.social, { status: 'held' }); const failedPosts = await n(c.social, { status: 'failed' }); const needsCheck = await n(c.social, { status: 'needs_check' });
    const failedMail = await n(c.drafts, { status: 'delivery_failed' });
    const k = { mk: { open: await n(c.drafts, { kind: 'marketing', status: { $in: ['needs_owner_review', 'approved'] } }), waiting: await n(c.drafts, { kind: 'marketing', status: 'needs_owner_review' }), scheduled: await n(c.social, { status: 'scheduled' }), sandboxPosts: await n(c.social, { status: 'published', sandbox: true }), livePosts: await n(c.social, { status: 'published', sandbox: { $ne: true } }) } };
    for (const t of ['pr', 'affiliate']) k[t] = { researched: await n(c.prospects, { track: t }), contacts: await n(c.prospects, { track: t, contactSource: { $exists: true } }), drafted: await n(c.drafts, { kind: t, autoResearched: true }), waiting: await n(c.drafts, { kind: t, status: 'needs_owner_review' }), approved: await n(c.drafts, { kind: t, status: { $in: ['approved', 'delivered'] } }), sandboxSent: await n(c.drafts, { kind: t, status: 'delivered', realDelivery: { $ne: true } }), realSent: await n(c.drafts, { kind: t, status: 'delivered', realDelivery: true }) };
    const mode = (x) => (x.mode === 'live' ? 'Live' : x.mode === 'sandbox' ? 'Sandbox' : 'Off');
    const dep = (key, label, status, headline, facts, next) => ({ key, label, status, headline, facts, next });
    const departments = [
      dep('marketing', 'Fight marketing', k.mk.open ? 'ok' : 'attention', `${k.mk.open} verified fight campaign(s) open, ${k.mk.waiting} awaiting your approval`, [`${k.mk.scheduled} post(s) scheduled`, `${k.mk.sandboxPosts} sandbox post(s), ${k.mk.livePosts} live post(s)`], k.mk.waiting ? 'Review fight campaigns in Campaign Approvals' : null),
      dep('pr', 'Public relations', k.pr.drafted ? 'ok' : k.pr.researched ? 'attention' : 'off', `${k.pr.researched} show(s) researched, ${k.pr.contacts} published business contact(s), ${k.pr.drafted} personalized pitch(es)`, [`${k.pr.waiting} awaiting approval`, `${k.pr.sandboxSent} built in the sandbox outbox (not sent)`, `${k.pr.realSent} really sent`], k.pr.waiting ? 'Approve or reject PR pitches' : null),
      dep('affiliates', 'Affiliate recruitment', k.affiliate.drafted ? 'ok' : k.affiliate.researched ? 'attention' : 'off', `${k.affiliate.researched} show(s) researched, ${k.affiliate.drafted} personalized proposal(s)`, [`${k.affiliate.waiting} awaiting approval`, `${k.affiliate.sandboxSent} in the sandbox outbox (not sent)`, `${att.affiliates.filter((a) => a.status === 'approved').length} active affiliate(s) in the live program`], k.affiliate.waiting ? 'Approve or reject affiliate proposals' : null),
      dep('publishing', 'Publishing', meta.state === 'connected' ? (held || failedPosts || needsCheck ? 'attention' : 'ok') : 'blocked', `Facebook ${mode(ch.facebook)} · Instagram ${mode(ch.instagram)} · X ${mode(ch.x)} · TikTok ${mode(ch.tiktok)}`, [`Meta connection: ${meta.state.replace(/_/g, ' ')}`, `${held} held, ${failedPosts} failed, ${needsCheck} to check`], meta.state !== 'connected' ? 'Connect Facebook & Instagram in Connections' : (needsCheck ? 'Check interrupted posts in Publishing' : null)),
      dep('automation', 'Automation', sched.healthy && !openAlerts.length ? 'ok' : 'attention', sched.healthy ? `Running every 15 minutes (${sched.runsLast24h} runs in 24h)` : 'No automatic run recently', [`${openAlerts.length} open alert(s)`, `Database ${resolved.config.database.name} on ${resolved.config.database.host || 'unknown host'} ${resolved.config.database.hostPinned ? '(pinned)' : '(NOT pinned)'}`], openAlerts.length ? 'Review alerts in Automation' : null),
      dep('revenue', 'Revenue & attribution', att.paymentSource.connected ? 'ok' : 'off', att.paymentSource.connected ? `${att.payingPlayers} verified paying player(s)` : 'Real payments are not connected to staging (by design)', [`Synthetic test lane: ${att.synthetic.steps.affiliateCredits} credit(s) from ${att.synthetic.steps.settledTestPayments} settled test payment(s)`, lastJourney ? `Last synthetic journey ${lastJourney.passed ? 'PASSED' : 'FAILED'} (${lastJourney.at.slice(0, 16).replace('T', ' ')} UTC)` : 'Synthetic journey not run yet'], lastJourney?.passed ? null : 'Run the synthetic journey in Revenue Attribution'),
    ];
    const exceptions = [
      ...openAlerts.map((a) => ({ kind: 'alert', text: `${a.kind}: ${a.error}`, id: a.alertKey, at: a.createdAt, route: 'automation' })),
      ...(needsCheck ? [{ kind: 'post', text: `${needsCheck} post(s) were interrupted while publishing: check the channel before retrying`, route: 'publishing' }] : []),
      ...(failedPosts ? [{ kind: 'post', text: `${failedPosts} post(s) failed`, route: 'publishing' }] : []),
      ...(failedMail ? [{ kind: 'email', text: `${failedMail} email(s) failed in the sandbox/provider`, route: 'approvals' }] : []),
    ];
    const autonomy = {
      automatic: ['Finding verified fights and preparing fight campaigns', 'Researching shows, finding published business contacts, writing personalized PR and affiliate drafts', 'Re-checking fights before posting, scheduling, retries, duplicate prevention', 'Connection health checks and interrupted-run recovery', 'Building approved emails in the sandbox outbox'],
      needsOwner: ['Approving every campaign, pitch and proposal', 'Authorizing any real post (controlled live test) or real email sending', 'Connecting Meta and choosing the Page', 'Linking an affiliate’s live affiliate ID after they join'],
      notConnected: [att.paymentSource.connected ? null : 'Real payments and registrations (staging uses signed test events only)', resolved.config.delivery.realDelivery ? null : 'Real email sending'].filter(Boolean),
    };
    res.json({ ok: true, generatedAt: new Date().toISOString(), departments, exceptions, autonomy });
  }));
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
  // Shared by the public signed-events route and the synthetic journey (same verification).
  const signedIngest = async (rt, raw, { timestamp, signature }) => {
    const sig = verifySignature({ secret: secrets.ingestSecret, rawBody: raw, timestamp, signature });
    if (!sig.ok) return { status: sig.reason === 'ingest_not_configured' ? 503 : 401, body: { ok: false, reason: sig.reason } };
    let body; try { body = JSON.parse(raw); } catch { return { status: 400, body: { ok: false, reason: 'invalid_json' } }; }
    const r = await rt.affiliates.ingest(body);
    return { status: r.ok ? 200 : 422, body: r };
  };
  app.post('/api/growth/events', express.raw({ type: '*/*', limit: '16kb' }), wrap(async (req, res, rt) => {
    const raw = typeof req.rawBody === 'string' ? req.rawBody : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body || {});
    const r = await signedIngest(rt, raw, { timestamp: req.headers['x-growth-timestamp'], signature: req.headers['x-growth-signature'] });
    res.status(r.status).json(r.body);
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
  // Posters + artwork rights + platform capabilities
  router.get('/admin/posters', admin, wrap(async (req, res, rt) => {
    const q = req.query.draftId ? { draftId: String(req.query.draftId).slice(0, 200) } : {};
    const rows = await rt.collections.posters.find({ ...q, withdrawnAt: { $exists: false } }, { projection: { bytes: 0, _id: 0 } }).sort({ createdAt: -1 }).limit(100).toArray();
    res.json({ ok: true, posters: rows.map((p) => ({ ...p, url: rt.posters.urlFor(p.id) })), enabled: Boolean(resolved.config.posters?.enabled) });
  }));
  router.post('/admin/posters/generate', admin, wrap(async (req, res, rt) => {
    const ids = Array.isArray(req.body?.draftIds) ? req.body.draftIds.map((x) => String(x).slice(0, 200)).slice(0, 20) : null;
    const r = await rt.ensurePosters(new Date(), { limit: 20, ids });
    await rt.collections.audit.insertOne({ action: 'generate_posters', admin: who(req), generated: r.generated || 0, at: new Date().toISOString() });
    res.json({ ok: !r.skipped, ...r });
  }));
  router.post('/admin/art-rights/:contestId', admin, wrap(async (req, res, rt) => {
    const r = await rt.posters.setArtRights(req.params.contestId, { status: req.body?.status, note: req.body?.note, admin: who(req) });
    if (r.ok) {
      await rt.collections.audit.insertOne({ action: 'art_rights', contestId: String(req.params.contestId).slice(0, 80), status: req.body?.status, admin: who(req), at: new Date().toISOString() });
      const ds = await rt.collections.drafts.find({ kind: 'marketing', contestId: String(req.params.contestId).slice(0, 80), status: { $in: ['needs_owner_review', 'approved'] } }).toArray();
      for (const d of ds) {
        await rt.posters.ensureForDraft(d, { force: true });
        // The poster changed: an approved campaign goes back for review and its queued posts are cancelled.
        if (d.status === 'approved') await rt.collections.drafts.updateOne({ id: d.id, status: 'approved' }, { $set: { status: 'needs_owner_review', ownerApproved: false, sendPermitted: false, reviewNote: 'Poster artwork changed (artwork rights updated): review the new poster' } });
        await rt.collections.social.updateMany({ draftId: d.id, status: { $in: ['scheduled', 'held'] } }, { $set: { status: 'cancelled', cancelledBy: 'system: artwork rights changed', cancelledAt: new Date().toISOString() } });
      }
    }
    res.status(r.ok ? 200 : 422).json(r);
  }));
  // Approved fighter photo library (owner-approved originals of exact named fighters) + blocks.
  const regenerateFor = async (rt, names = null) => {
    const { norm } = require('./growth-fighter-artwork');
    const q = { kind: 'marketing', contestId: { $exists: true }, status: { $in: ['needs_owner_review', 'approved'] } };
    const ds = (await rt.collections.drafts.find(q).toArray()).filter((d) => !names || names.some((n) => [d.contest?.fighterA, d.contest?.fighterB].map(norm).includes(norm(n))));
    return ds.length ? rt.ensurePosters(new Date(), { ids: ds.map((d) => d.id), limit: 20 }) : { generated: 0 };
  };
  router.get('/admin/fighter-assets', admin, wrap(async (req, res, rt) => res.json({ ok: true, assets: await rt.posters.library.list() })));
  router.post('/admin/fighter-assets', admin, wrap(async (req, res, rt) => {
    const r = await rt.posters.library.approve({ fighterName: req.body?.fighterName, imageUrl: req.body?.imageUrl, rightsNote: req.body?.rightsNote, admin: who(req) });
    if (r.ok) { await rt.collections.audit.insertOne({ action: 'approve_fighter_photo', fighter: r.asset.fighterName, sha256: r.asset.sha256, admin: who(req), at: new Date().toISOString() }); r.posters = await regenerateFor(rt, [r.asset.fighterName]); }
    res.status(r.ok ? 201 : 422).json(r);
  }));
  router.post('/admin/fighter-assets/block', admin, wrap(async (req, res, rt) => {
    const r = await rt.posters.library.block({ url: req.body?.url, note: req.body?.note, admin: who(req) });
    if (r.ok) { await rt.collections.audit.insertOne({ action: 'block_fighter_photo', url: String(req.body?.url).slice(0, 300), admin: who(req), at: new Date().toISOString() }); r.posters = await regenerateFor(rt); }
    res.status(r.ok ? 200 : 422).json(r);
  }));
  router.post('/admin/fighter-assets/:id/revoke', admin, wrap(async (req, res, rt) => {
    const r = await rt.posters.library.revoke(req.params.id, { admin: who(req) });
    if (r.ok) { await rt.collections.audit.insertOne({ action: 'revoke_fighter_photo', id: String(req.params.id).slice(0, 40), admin: who(req), at: new Date().toISOString() }); r.posters = await regenerateFor(rt); }
    res.status(r.ok ? 200 : 404).json(r);
  }));
  router.get('/admin/social/capabilities', admin, wrap(async (req, res, rt) => res.json({ ok: true, capabilities: require('./growth-social-publishing').PLATFORM_CAPABILITIES, channels: await liveChannels(rt), provider: resolved.config.social.provider })));
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
