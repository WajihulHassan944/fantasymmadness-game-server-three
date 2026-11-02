'use strict';
// Live check of the back-office console against the REAL isolated staging data
// (Atlas fmgrowthtest). Runs inside a build of the isolated Vercel project, which
// is the only place that holds the staging credentials. It boots the FULL backend
// exactly as the deployed function does (full-card-bootstrap -> server.js, incl.
// its CORS allowlist), puts a real browser on the exact staging origin
// (https://fantasymmadness-growth-isolated-tes.vercel.app, routed to this server),
// and:
//   - reads every screen from the live data (read-only), and
//   - exercises every button on clearly labelled "uitest-" fixtures it creates,
//     then deletes every fixture and every audit entry it produced.
// Real drafts are never approved, rejected or edited. Nothing is sent: the
// delivery provider is "sandbox-capture" (messages are built and stored, never sent).
// Result is reported through the exit code (build logs are not readable here):
//   160 + mask = all checks passed in the browser; mask bit i (boxing=1, mma-ufc=2,
//                kickboxing=4, bare-knuckle=8, pro-wrestling=16) = that sport has at
//                least one verified fight campaign right now
//   97  = HTTP checks passed, browser could not start
//   100+N = check N failed      1 = could not start      98/99 = cleanup problem
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { signConsoleToken, consolePasswordVersion } = require('../growth-console-token');
const { MongoClient } = require('mongodb');
const path = require('path');
const cc = require(path.join(__dirname, '..', 'growth-contest-campaigns'));

const ISOLATED = 'prj_Hpe9UjGrBBJOm3boxHsL9lHesWLl';
const LABEL = 'live-check@growth-console';
const STAGING = 'https://fantasymmadness-growth-isolated-tes.vercel.app';
const stamp = Date.now().toString(36);
const FX = { mkt1: `uitest-mkt-a-${stamp}`, mkt2: `uitest-mkt-b-${stamp}`, prospect: `uitest-p-${stamp}`, prospect2: `uitest-q-${stamp}`, alert: `uitest:alert-${stamp}`, job: `uitest-job-${stamp}`, optout: `uitest-${stamp}@example.invalid` };
const log = (...a) => console.log('[console-live-check]', ...a);
let step = 0;
const check = async (name, fn) => { step++; try { await fn(); log(`PASS ${step} ${name}`); } catch (e) { log(`FAIL ${step} ${name}: ${e && e.stack || e}`); throw Object.assign(new Error('check failed'), { code: (e && e.diag) || 100 + step }); } };
const ok = (v, msg) => { if (!v) throw new Error(msg || 'assertion failed'); };

async function main() {
  if (process.env.VERCEL && !process.env.VERCEL_PROJECT_ID) process.env.VERCEL_PROJECT_ID = ISOLATED;
  ok(process.env.VERCEL_PROJECT_ID === ISOLATED, 'not the isolated project');
  ok(String(process.env.CORS_ORIGINS || '').split(',').map((x) => x.trim()).includes(STAGING), 'CORS_ORIGINS does not list the staging origin');
  const port = 3000 + Math.floor(Math.random() * 2000);
  process.env.PORT = String(port);
  require(path.join(__dirname, '..', 'full-card-bootstrap'));   // the real deployed entry point
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${origin}/api/growth/health`)).status === 200) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
  const client = await new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 }).connect();
  const gdb = client.db('fmgrowthtest');
  const C = {
    drafts: gdb.collection('growth_drafts'), prospects: gdb.collection('growth_prospects'), alerts: gdb.collection('growth_alerts'), jobs: gdb.collection('unattended_jobs'),
    suppressions: gdb.collection('growth_suppressions'), audit: gdb.collection('growth_audit_log'), runs: gdb.collection('isolated_run_claims'),
    social: gdb.collection('growth_social_posts'), sandbox: gdb.collection('growth_social_sandbox'), affiliates: gdb.collection('growth_affiliates'),
  };
  const pwv = consolePasswordVersion(process.env.GROWTH_ADMIN_PASSWORD_HASH);
  const token = signConsoleToken(process.env.JWT_SECRET_ADMIN, { email: LABEL, pwv }, { expiresIn: '30m' });
  const api = async (m, p, body, extra = {}) => { const r = await fetch(`${origin}/api/growth${p}`, { method: m, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: STAGING, ...extra }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null), headers: r.headers }; };
  let browser = null; let browserOk = false; let exitCode = 0;
  const live = {};
  try {
    await check('health: isolated, Atlas fmgrowthtest, console sign-in configured, sandbox delivery only', async () => {
      const h = (await api('GET', '/health')).json;
      ok(h.ok && h.database.name === 'fmgrowthtest' && h.database.kind === 'atlas', 'health');
      ok(h.console.signInConfigured === true, 'sign-in not configured');
      ok(h.delivery.provider === 'sandbox-capture' && h.delivery.realDelivery === false, `delivery ${h.delivery.provider}`);
    });
    await check('database host pinned to the isolated test cluster', async () => {
      const st = (await api('GET', '/admin/status')).json;
      if (!(st.database.hostPinned === true)) throw Object.assign(new Error('host not pinned'), { diag: 240 });
      if (!(new URL(process.env.MONGODB_URI).hostname === 'fmgrowthtest.zxhtsfa.mongodb.net')) throw Object.assign(new Error('unexpected Atlas host'), { diag: 241 });
      if (!(String(process.env.GROWTH_TEST_ATLAS_HOST).trim() === 'fmgrowthtest.zxhtsfa.mongodb.net')) throw Object.assign(new Error('pin value'), { diag: 242 });
    });
    await check('CORS: exact staging origin allowed on sign-in; other origins still refused', async () => {
      const post = (o) => fetch(`${origin}/api/growth/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: o, 'X-Forwarded-For': '198.51.100.8' }, body: JSON.stringify({ password: 'definitely-not-the-password' }) });
      const good = await post(STAGING);
      ok(good.status === 401, `staging origin status ${good.status}`);
      ok(good.headers.get('access-control-allow-origin') === STAGING, 'ACAO header');
      const evil = await post('https://evil.example');
      ok(evil.status === 403 && /CORS/.test((await evil.json()).message), `evil origin status ${evil.status}`);
      const near = await post('https://fantasymmadness-growth-isolated-tes.vercel.app.evil.example');
      ok(near.status === 403, 'look-alike origin');
      const pre = await fetch(`${origin}/api/growth/admin/login`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
      ok(pre.headers.get('access-control-allow-origin') !== 'https://evil.example', 'preflight leaked');
    });
    await check('admin back-office connection: only console tokens accepted; preview may frame and call the engine', async () => {
      // A token signed directly with JWT_SECRET_ADMIN (the live backend's admin token format) is refused.
      const liveStyle = jwt.sign({ email: LABEL, role: 'growth_owner', pwv }, process.env.JWT_SECRET_ADMIN, { expiresIn: '5m' });
      ok((await fetch(`${origin}/api/growth/admin/session`, { headers: { Authorization: `Bearer ${liveStyle}`, Origin: STAGING } })).status === 401, 'live-style admin token accepted');
      const PREVIEW = 'https://fmm-ver2-git-test-growth-e-7c8860-kelly-davis-projects-6c108d0b.vercel.app';
      const csp = (await fetch(`${origin}/api/growth/console`)).headers.get('content-security-policy') || '';
      const fa = (csp.split(';').map((x) => x.trim()).find((x) => x.startsWith('frame-ancestors')) || '').split(/\s+/).slice(1);
      log(`frame-ancestors: ${fa.join(' ')}`);
      ok(fa.includes(PREVIEW), 'admin preview not allowed to embed the console');
      ok(fa.every((x) => x === "'self'" || /^https:\/\/[a-z0-9.-]+$/.test(x)), 'wildcard or non-https frame ancestor');
      const h = await fetch(`${origin}/api/growth/health`, { headers: { Origin: PREVIEW } });
      ok(h.status === 200 && h.headers.get('access-control-allow-origin') === PREVIEW, `preview health CORS ${h.status} ${h.headers.get('access-control-allow-origin')}`);
      // Test back office sign-in (staging review mode) from the real preview address
      const pre = await fetch(`${origin}/api/growth/admin/login`, { method: 'OPTIONS', headers: { Origin: PREVIEW, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
      ok(pre.status < 300 && pre.headers.get('access-control-allow-origin') === PREVIEW && /content-type/i.test(pre.headers.get('access-control-allow-headers') || ''), `preview sign-in preflight ${pre.status}`);
      const bad = await fetch(`${origin}/api/growth/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: PREVIEW, 'X-Forwarded-For': '198.51.100.9' }, body: JSON.stringify({ password: 'definitely not the password' }) });
      ok(bad.status === 401 && bad.headers.get('access-control-allow-origin') === PREVIEW, `preview wrong-password ${bad.status}`);
      const hj = await (await fetch(`${origin}/api/growth/health`)).json();
      ok((hj.console.embedOrigins || []).includes(PREVIEW), 'preview not on the console embed list (session hand-over would be ignored)');
      ok(/fmm-growth-session/.test(await (await fetch(`${origin}/api/growth/console/app.js`)).text()), 'console without session hand-over');
      // A real console token works from the preview origin (what the test back office sends after sign-in)
      const sess = await fetch(`${origin}/api/growth/admin/session`, { headers: { Authorization: `Bearer ${token}`, Origin: PREVIEW } });
      ok(sess.status === 200 && sess.headers.get('access-control-allow-origin') === PREVIEW, `preview session ${sess.status}`);
    });
    await check('Facebook & Instagram: encryption ready, exact redirect, sandbox statuses, protected callback, live test off', async () => {
      const m = (await api('GET', '/admin/meta')).json.meta;
      log(`meta state: ${m.state} (${m.connectionLabel}); facebook=${m.publishing.facebook}; instagram=${m.publishing.instagram}`);
      ok(m.setup[0].done === true, 'GROWTH_TOKEN_ENCRYPTION_KEY not active');
      ok(m.redirectUri === `${STAGING}/api/growth/meta/callback`, `redirect ${m.redirectUri}`);
      ok(['not_set_up', 'authorization_needed', 'selection_needed', 'connected'].includes(m.state), 'state');
      ok(m.publishing.facebook === 'sandbox' && m.publishing.instagram === 'sandbox', 'publishing must stay sandbox');
      ok(m.publishing.liveTestApproved === false, 'live test must be off');
      ok(!/EAA[A-Za-z0-9]{10,}/.test(JSON.stringify(m)), 'token-like value in status');
      const cb = await fetch(`${origin}/api/growth/meta/callback?code=x&state=forged-by-live-check`);
      ok(cb.status === 400, `forged callback ${cb.status}`);
      ok(cb.headers.get('cache-control') === 'no-store' && cb.headers.get('referrer-policy') === 'no-referrer' && /frame-ancestors 'none'/.test(cb.headers.get('content-security-policy') || ''), 'callback headers');
      const lt = await api('POST', '/admin/social/live-test', { draftId: 'none', channel: 'facebook', confirmText: 'POST LIVE' });
      ok(lt.status === 409 && lt.json.reason === 'live_test_not_authorized_by_owner', `live test ${lt.status} ${JSON.stringify(lt.json)}`);
    });
    await check('fight addresses come from the real website (fighter-name URL when it has one, else the working ID address)', async () => {
      const r = await api('POST', '/admin/marketing/refresh');
      if (!(r.status === 200)) throw Object.assign(new Error(`refresh ${r.status}`), { diag: 201 });
      const ds = (await api('GET', '/admin/drafts?kind=marketing&limit=300')).json.drafts.filter((d) => d.contestId && ['needs_owner_review', 'approved'].includes(d.status));
      if (!(ds.length > 0)) throw Object.assign(new Error('no open fight campaigns'), { diag: 202 });
      const counts = {};
      for (const d of ds) {
        const c = d.contest || {};
        counts[c.urlSource || 'missing'] = (counts[c.urlSource || 'missing'] || 0) + 1;
        if (!(['id', 'redirect', 'canonical', 'feed'].includes(c.urlSource))) throw Object.assign(new Error(`${d.id}: no address source`), { diag: 203 });
        if (!(/^https:\/\/www\.fantasymmadness\.com\//.test(c.idUrl || ''))) throw Object.assign(new Error(`${d.id}: no ID fallback`), { diag: 204 });
        const base = (c.cleanUrl || c.idUrl).split('?')[0];
        for (const ch of ['facebook', 'instagram', 'x']) if (d.posts?.[ch]) {
          if (!(d.posts[ch].includes(base))) throw Object.assign(new Error(`${d.id} ${ch}: link does not use the current address`), { diag: 205 });
          if (!(/utm_source=fan_acquisition&utm_medium=partner_outreach&utm_campaign=combat_fans_gs_/.test(d.posts[ch]))) throw Object.assign(new Error(`${d.id} ${ch}: campaign tags missing`), { diag: d.editedAt ? 230 : 206 });
        }
      }
      log(`campaign addresses: ${JSON.stringify(counts)}`);
      // A fighter-name address in use must really load on the website.
      for (const d of ds.filter((x) => x.contest?.cleanUrl).slice(0, 5)) {
        const v = await fetch(`${d.contest.contestUrl}`, { redirect: 'manual' });
        if (!(v.status === 200)) throw Object.assign(new Error(`${d.contest.contestUrl} -> ${v.status}`), { diag: 207 });
      }
    });
    await check('sessions from before the password change are refused', async () => {
      const stale = signConsoleToken(process.env.JWT_SECRET_ADMIN, { email: LABEL, pwv: 'old-password-ver' }, { expiresIn: '5m' });
      ok((await fetch(`${origin}/api/growth/admin/session`, { headers: { Authorization: `Bearer ${stale}`, Origin: STAGING } })).status === 401, 'stale accepted');
      ok((await api('GET', '/admin/session')).status === 200, 'current refused');
    });
    await check('console page and assets served with CSP', async () => {
      for (const f of ['', '/app.js', '/app.css']) { const r = await fetch(`${origin}/api/growth/console${f}`); ok(r.status === 200, f); ok(/script-src 'self'/.test(r.headers.get('content-security-policy')), 'csp'); }
    });
    await check('wrong password rejected by the configured owner hash', async () => {
      const r = await fetch(`${origin}/api/growth/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.7' }, body: JSON.stringify({ password: 'definitely-not-the-password' }) });
      ok(r.status === 401, `status ${r.status}`);
    });
    await check('every console endpoint returns live staging data', async () => {
      const o = (await api('GET', '/admin/overview')).json.overview; live.overview = o;
      ok(o.prospects >= 20, `prospects ${o.prospects}`);
      const st = (await api('GET', '/admin/status')).json; live.status = st;
      ok(st.scheduler.healthy === true && st.scheduler.runsLast24h >= 2, 'scheduler not healthy');
      const ws = (await api('GET', '/admin/workstreams')).json; ok(ws.workstreams.length === 25, `workstreams ${ws.workstreams.length}`);
      const pr = ws.workstreams.filter((w) => w.functionName === 'public-relations'); const af = ws.workstreams.filter((w) => w.functionName === 'affiliate-recruitment');
      ok(pr.length === 5 && af.length === 5, 'pr/affiliate workstreams');
      const withDrafts = pr.find((w) => w.draftCount > 0);
      if (withDrafts) { const det = (await api('GET', `/admin/workstreams/${withDrafts.runId}/${withDrafts.workstreamId}`)).json.workstream; ok(det.drafts.length > 0 && det.drafts[0].html && det.drafts[0].prospectName, 'detail'); }
      const an = (await api('GET', '/admin/analytics')).json.analytics; live.analytics = an;
      ok(Object.values(an.workstreams.matrix).every((row) => Object.values(row).every((v) => v !== null)), 'matrix gaps');
      const at = (await api('GET', '/admin/attribution')).json.attribution; live.attribution = at; ok(at.paymentSource.connected === false, 'payment source');
      for (const p of ['/admin/runs', '/admin/jobs', '/admin/reports', '/admin/audit', '/admin/suppressions', '/admin/alerts?state=all', '/admin/drafts?kind=marketing', '/admin/prospects', '/admin/session']) ok((await api('GET', p)).status === 200, p);
      ok((await api('GET', '/admin/runs')).json.runs.length >= 2, 'runs'); ok((await api('GET', '/admin/reports')).json.reports.length >= 1, 'reports');
    });

    // ---- Issue #108: research, sandbox outbox, synthetic money path, executive view ----
    await check('PR & affiliate research: real shows researched, every draft backed by a published contact and evidence', async () => {
      for (const track of ['pr', 'affiliate']) {
        const r = (await api('GET', `/admin/research?track=${track}`)).json; live[`research_${track}`] = r.counts;
        ok(r.ok && Array.isArray(r.shows), `${track} research`);
        for (const x of r.shows.filter((s) => s.draftId)) {
          if (!(x.contact && x.contact.email)) throw Object.assign(new Error(`${track} ${x.id}: draft without contact`), { diag: 210 });
          if (!x.contact.manual && !(x.contact.source && x.contact.basis)) throw Object.assign(new Error(`${track} ${x.id}: contact without source`), { diag: 211 });
          if (/@(anchor\.fm|libsyn\.com|buzzsprout\.com|example\.com)$/i.test(x.contact.email)) throw Object.assign(new Error(`${track} ${x.id}: platform address`), { diag: 212 });
        }
      }
      const drafts = await C.drafts.find({ kind: { $in: ['pr', 'affiliate'] }, autoResearched: true }).toArray();
      for (const d of drafts) {
        if (!(d.recipient && d.contactSource && d.personalization)) throw Object.assign(new Error(`${d.id}: missing research fields`), { diag: 213 });
        if (/\$\d|\d+\s?%/.test(`${d.subject} ${d.text}`)) throw Object.assign(new Error(`${d.id}: money terms`), { diag: 214 });
        if (d.status === 'delivered' && d.realDelivery === true) throw Object.assign(new Error(`${d.id}: REAL delivery`), { diag: 215 });
      }
      live.autoDrafts = drafts.length;
    });
    await check('sandbox outbox: provider sandbox-capture, nothing ever sent over the network', async () => {
      const r = (await api('GET', '/admin/email/sandbox')).json;
      ok(r.ok && r.provider === 'sandbox-capture' && r.realDelivery === false, `outbox ${r.provider}`);
      ok(r.messages.every((m) => m.sent === false && m.network === false), 'a captured message claims to be sent');
      ok(r.messages.every((m) => /contact@fantasymmadnesscom\.com/.test(m.message.from) && m.message.headers && m.message.headers['List-Unsubscribe']), 'sender/unsubscribe');
      live.sandboxOutbox = r.count;
    });
    await check('synthetic journey: click -> registration -> test payment -> entry -> exactly one affiliate credit; forgeries refused', async () => {
      const r = await api('POST', '/admin/synthetic/journey');
      if (r.status === 409) throw Object.assign(new Error('ingest secret not configured'), { diag: 220 });
      if (!(r.status === 200 && r.json.ok === true)) throw Object.assign(new Error(`journey ${r.status} ${JSON.stringify(r.json).slice(0, 600)}`), { diag: 221 });
      const lane = r.json.lane; live.synthetic = lane && lane.steps;
      ok(lane && lane.steps.settledTestPayments >= 1 && lane.steps.affiliateCredits >= 1, 'lane');
      const at = (await api('GET', '/admin/attribution')).json.attribution;
      ok(at.paymentSource.connected === false, 'real payments must stay disconnected');
      ok(!at.affiliates.some((a) => a.id === 'syn-affiliate'), 'synthetic affiliate leaked into the real list');
    });
    await check('executive dashboard: six departments with honest status, exceptions and autonomy lists', async () => {
      const r = (await api('GET', '/admin/executive')).json;
      ok(r.ok && r.departments.length === 6, 'departments');
      ok(r.departments.every((d) => ['ok', 'attention', 'blocked', 'off'].includes(d.status) && d.headline), 'status');
      const rev = r.departments.find((d) => d.key === 'revenue'); ok(rev.status === 'off' && /PASSED/.test(rev.facts.join(' ')), 'revenue honesty / journey');
      ok(/\(pinned\)/.test(r.departments.find((d) => d.key === 'automation').facts.join(' ')), 'pinned fact');
      ok(Array.isArray(r.exceptions) && r.autonomy.notConnected.some((x) => /Real email sending/.test(x)), 'autonomy');
      live.executive = r.departments.map((d) => `${d.key}:${d.status}`).join(',');
    });

    // ---- fight marketing correction, on the real staging data ----
    let sportMask = 0; let realContest = null;
    await check('marketing refresh runs against the real published contests', async () => {
      const r = await api('POST', '/admin/marketing/refresh');
      ok(r.status === 200 && r.json.result.sourceReachable === true, `refresh ${r.status} ${JSON.stringify(r.json)}`);
      live.refresh = r.json.result;
    });
    await check('no marketing campaign in the queue is based on a podcast/media name or an unverified fight', async () => {
      const legacy = await C.drafts.countDocuments({ kind: 'marketing', contestId: { $exists: false }, status: { $in: ['needs_owner_review', 'approved'] } });
      ok(legacy === 0, `${legacy} unverified marketing campaigns still in the queue`);
      const withdrawnLegacy = await C.drafts.countDocuments({ kind: 'marketing', contestId: { $exists: false }, rejectedBy: 'system-safeguard' });
      ok(withdrawnLegacy >= 1, 'old podcast-based campaigns were not withdrawn');
    });
    await check('every queued campaign matches a real open contest in the live FANTASY MMADNESS feed (independent re-check)', async () => {
      // Independent of the engine: read the feeds directly and compare.
      const base = cc.DEFAULT_SOURCE;
      const pf = await (await fetch(`${base}/api/public/prediction-fights?limit=100`)).json();
      const pw = await (await fetch(`${base}/api/public/pro-wrestling/matches?status=OPEN&limit=50`)).json();
      const raw = new Map();
      for (const it of pf.items || []) raw.set(String(it._id), { ...it, __feed: 'prediction' });
      for (const it of pw.items || []) raw.set(String(it.id), { ...it, __feed: 'pro-wrestling' });
      const names = new Set((await C.prospects.find({}, { projection: { name: 1 } }).toArray()).map((p) => cc.norm(p.name)).filter((n) => n.length >= 4));
      const queued = await C.drafts.find({ kind: 'marketing', status: { $in: ['needs_owner_review', 'approved'] } }).toArray();
      for (const d of queued) {
        const src = raw.get(String(d.contestId)); ok(src, `${d.id}: contest not in live feed`);
        const v = cc.verifyContest(src, { now: new Date(), mediaNames: names }); ok(v.ok, `${d.id}: live contest fails verification ${JSON.stringify(v.reasons)}`);
        ok(v.contest.fighterA === d.contest.fighterA && v.contest.fighterB === d.contest.fighterB && v.contest.dateKey === d.contest.dateKey && v.contest.sport === d.genre, `${d.id}: details differ from live contest`);
        const reasons = cc.checkCampaign(d, v.contest, { now: new Date(), mediaNames: names }); ok(!reasons.length, `${d.id}: ${reasons.join(',')}`);
        for (const n of names) ok(!(n.length > 5 && cc.norm(d.text).includes(n) && !cc.norm(`${v.contest.fighterA} ${v.contest.fighterB} ${v.contest.eventName || ''}`).includes(n)), `${d.id}: contains media name "${n}"`);
        sportMask |= 1 << cc.SPORTS.indexOf(d.genre); globalThis.__sportMask = sportMask;
        if (!realContest) realContest = v.contest;
      }
      const cov = (await api('GET', '/admin/marketing/coverage')).json.coverage;
      ok(cov.latest && cc.SPORTS.every((sp) => cov.latest.sports[sp]), 'coverage missing a sport');
      for (const sp of cc.SPORTS) ok((cov.latest.sports[sp].verifiedContests > 0) === Boolean(sportMask & (1 << cc.SPORTS.indexOf(sp))) || cov.latest.sports[sp].campaignsActive > 0, `coverage inconsistent for ${sp}`);
      log('marketing', JSON.stringify({ refresh: live.refresh, queued: queued.length, sportMask }));
    });

    await check('connections, email readiness and funnel endpoints work on staging', async () => {
      const c = (await api('GET', '/admin/connections')).json.connections;
      ok(c.social.provider === 'sandbox', `social provider ${c.social.provider}`);
      ok(Object.values(c.social.channels).every((x) => x.mode === 'sandbox'), 'channels not sandbox');
      ok(c.email.realDelivery === false, 'real email is on');
      const e = (await api('GET', '/admin/email/readiness')).json.readiness;
      ok(e && Array.isArray(e.steps) && e.steps.length === 5 && e.realDelivery === false, 'email readiness');
      live.email = e;
      const f = (await api('GET', '/admin/funnel')).json.funnel;
      ok(f.stages.length === 8 && ['researched', 'drafted'].every((k) => f.stages.some((x) => x.key === k)) && f.stages.find((x) => x.key === 'paying').connected === false, 'funnel');
      const ing = await fetch(`${origin}/api/growth/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: STAGING }, body: '{}' });
      ok([401, 503].includes(ing.status), `unsigned event accepted (${ing.status})`);
    });

    // ---- browser ----
    let chromium = null; let executablePath; let args = [];
    try {
      ({ chromium } = require('playwright-core'));
      const sp = (await import('@sparticuz/chromium')).default; executablePath = await sp.executablePath(); args = sp.args;
      browser = await chromium.launch({ executablePath, args, headless: true });
      browserOk = true;
    } catch (e) { log('browser unavailable:', e && e.message); }

    if (browserOk) {
      const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
      // The browser is on the real staging origin; requests are served by the real backend booted above.
      await context.route(`${STAGING}/**`, async (route) => {
        const req = route.request(); const u = new URL(req.url());
        const resp = await route.fetch({ url: `${origin}${u.pathname}${u.search}`, headers: req.headers() });
        await route.fulfill({ response: resp });
      });
      const corsErrors = [];
      const page = await context.newPage(); page.setDefaultTimeout(20000);
      const problems = [];
      page.on('pageerror', (e) => problems.push(e.message));
      const confirm = async () => { await page.click('[data-testid=modal-confirm]'); await page.waitForSelector('[data-testid=modal]', { state: 'detached' }); };
      const goto = async (hash) => {
        const before = Number(await page.evaluate(() => document.querySelector('main')?.dataset.render || 0));
        await page.evaluate((hh) => { location.hash = hh; }, hash);
        await page.waitForSelector(`main[data-render="${before + 1}"]`); await page.waitForSelector('main .spinner', { state: 'detached' });
      };
      const status = async (id) => (await C.drafts.findOne({ id }))?.status;

      page.on('response', async (r) => { if (r.status() === 403) { const t = await r.text().catch(() => ''); if (/CORS/.test(t)) corsErrors.push(r.url()); } });
      await check('browser on the staging origin: sign-in reaches the password check (no CORS error)', async () => {
        await page.goto(`${STAGING}/api/growth/console`); await page.waitForSelector('[data-testid=login]');
        ok(page.url().startsWith(STAGING), 'not on staging origin');
        await page.fill('[data-testid=login-password]', 'definitely-not-the-password');
        await page.click('[data-testid=login-submit]');
        await page.waitForFunction(() => document.querySelector('[data-testid=login-error]').textContent.trim().length > 0);
        const msg = await page.textContent('[data-testid=login-error]');
        ok(/Incorrect password/.test(msg), `login message: ${msg}`);
        ok(corsErrors.length === 0, 'CORS error in browser');
      });
      await check('browser: session, then live overview', async () => {
        live.overview = (await api('GET', '/admin/overview')).json.overview; // counts after the marketing refresh
        await page.evaluate((t) => sessionStorage.setItem('fmmGrowthConsoleToken', t), token);
        await page.goto(`${STAGING}/api/growth/console#/overview`);
        await page.waitForSelector('[data-testid=scheduler-banner]');
        ok(/running automatically/.test(await page.textContent('[data-testid=scheduler-banner]')), 'banner');
        ok((await page.textContent('[data-testid=tile-prospects] .value')).replace(/,/g, '') === String(live.overview.prospects), 'prospect tile');
        ok((await page.textContent('[data-testid=tile-pending] .value')).replace(/,/g, '') === String(live.overview.draftsAwaitingReview), 'pending tile');
      });
      await check('browser: all eight screens load from live data', async () => {
        for (const n of ['approvals', 'marketing', 'pr', 'affiliates', 'automation', 'analytics', 'revenue', 'overview']) {
          await page.click(`[data-testid=nav-${n}]`); await page.waitForSelector(`[data-testid=page-${n}]`); await page.waitForSelector('main .spinner', { state: 'detached' });
          ok(!(await page.$('[data-testid=page-error]')), `error on ${n}`);
        }
        // research rows (or the honest "not researched yet" state) on every sport tab; open a drafted email where one exists
        let viewed = false;
        for (const [route, g] of [['pr', 'boxing'], ['pr', 'mma-ufc'], ['affiliates', 'boxing'], ['affiliates', 'pro-wrestling']]) {
          await goto(`#/${route}?sport=${g}`); await page.waitForSelector('[data-testid=prepared-row], [data-testid=research-empty]');
          const btn = await page.$('[data-testid=prepared-row][data-outcome=drafted] [data-testid=btn-view-template]');
          if (btn && !viewed) { await btn.click(); await page.waitForSelector('[data-testid=prepared-list] [data-testid=email-preview]'); viewed = true; }
        }
        globalThis.__viewedResearchEmail = viewed;
        await goto('#/analytics');
        const cells = await page.$$eval('[data-testid=workstream-matrix] td.cell', (els) => els.map((e) => e.textContent));
        ok(cells.length === 25 && cells.every((c) => c !== '—'), 'matrix');
        await goto('#/revenue'); ok(/not connected/.test(await page.textContent('[data-testid=payment-banner]')), 'revenue banner');
      });

      await check('browser: Marketing page shows all five sports, facts and safeguard results', async () => {
        await goto('#/marketing');
        ok((await page.$$('[data-testid=coverage-row]')).length === 5, 'coverage rows');
        const txt = await page.textContent('main');
        ok(!/fight-week prediction challenge/i.test(await page.$$eval('[data-testid=marketing-list] [data-status=needs_owner_review]', (els) => els.map((e) => e.textContent).join(' '))), 'old template still queued');
        ok(/All five sports/.test(txt), 'coverage card');
        await page.click('[data-testid=btn-check-fights]'); await page.waitForSelector('[data-testid=toast]');
        ok(/verified fight/.test(await page.textContent('[data-testid=toast]')), 'check-now toast');
      });
      // ---- buttons, on labelled fixtures only ----
      const nowIso = new Date().toISOString();
      if (realContest) {
        const k = cc.buildCampaign(realContest);
        await C.drafts.insertOne({ id: FX.mkt1, kind: 'marketing', genre: realContest.sport, contestId: realContest.id, contestFingerprint: realContest.fingerprint, contest: realContest, channels: ['instagram', 'facebook', 'x', 'tiktok'], headline: `UI TEST ${stamp} ${k.headline}`.slice(0, 180), text: k.text, posts: k.posts, link: k.link, sourceUrl: realContest.contestUrl, status: 'needs_owner_review', ownerApproved: false, sendPermitted: false, createdAt: nowIso, uitest: true });
      }
      await C.drafts.insertOne({ id: FX.mkt2, kind: 'marketing', genre: 'boxing', contestId: 'uitest-none', contest: null, headline: `UI TEST ${FX.mkt2}`, text: 'UI test post — will be deleted automatically.', sourceUrl: 'https://example.com/uitest', status: 'needs_owner_review', ownerApproved: false, sendPermitted: false, createdAt: nowIso, uitest: true });
      await C.prospects.insertOne({ key: `partners:uitest:${stamp}`, id: FX.prospect, genre: 'boxing', focus: 'partners', name: `UI Test Show ${stamp}`, sourceUrl: 'https://example.com/uitest-show', source: 'uitest', verified: false, contact: null, contactVerified: false, consent: false, optedOut: false, firstSeenAt: nowIso, uitest: true });
      await C.alerts.insertOne({ alertKey: FX.alert, kind: 'uitest', id: 'ui-test', error: 'UI test alert — will be deleted automatically', state: 'open', createdAt: nowIso, uitest: true });
      await C.jobs.insertOne({ id: FX.job, type: 'uitest_noop', state: 'failed', attempts: 3, dueAt: nowIso, lastError: 'UI test job — will be deleted automatically', createdAt: nowIso, uitest: true });

      await check('browser: unverified campaign cannot be approved; reject works (fixture)', async () => {
        await goto('#/approvals?status=needs_owner_review&kind=marketing&sport=boxing');
        await page.waitForSelector(`[data-draft-id="${FX.mkt2}"]`);
        await page.click(`[data-draft-id="${FX.mkt2}"] [data-testid=btn-approve]`); await page.click('[data-testid=modal-confirm]');
        await page.waitForFunction(() => /no longer open|not based on a verified|safety check/i.test(document.querySelector('[data-testid=modal] .error')?.textContent || ''));
        await page.click('[data-testid=modal-cancel]');
        ok(await status(FX.mkt2) === 'needs_owner_review', 'unverified was approved');
        await page.click(`[data-draft-id="${FX.mkt2}"] [data-testid=btn-reject]`); await page.fill('[data-testid=reject-reason]', 'ui test'); await confirm();
        await page.waitForSelector(`[data-draft-id="${FX.mkt2}"]`, { state: 'detached' }); ok(await status(FX.mkt2) === 'rejected', 'reject');
      });
      if (realContest) await check('browser: campaign for a real verified fight - edit (safeguarded), approve, copy, publish (fixture copy)', async () => {
        await goto(`#/approvals?status=needs_owner_review&kind=marketing&sport=${realContest.sport}`);
        await page.waitForSelector(`[data-draft-id="${FX.mkt1}"]`);
        await page.click(`[data-draft-id="${FX.mkt1}"] [data-testid=btn-edit]`); await page.fill('[data-testid=edit-text]', 'Win a $500 prize!'); await page.click('[data-testid=modal-confirm]');
        await page.waitForFunction(() => /safeguard/i.test(document.querySelector('[data-testid=modal] .error')?.textContent || ''));
        await page.click('[data-testid=modal-cancel]');
        await page.click(`[data-draft-id="${FX.mkt1}"] [data-testid=btn-edit]`); await page.fill('[data-testid=edit-title]', `UI TEST edited ${stamp}`); await confirm();
        await page.waitForFunction(([id, s]) => document.querySelector(`[data-draft-id="${id}"] [data-testid=draft-title]`)?.textContent === `UI TEST edited ${s}`, [FX.mkt1, stamp]);
        await page.click(`[data-draft-id="${FX.mkt1}"] [data-testid=btn-approve]`); await confirm();
        await page.waitForSelector(`[data-draft-id="${FX.mkt1}"]`, { state: 'detached' }); ok(await status(FX.mkt1) === 'approved', 'approve');
        await goto(`#/approvals?status=approved&kind=marketing&sport=${realContest.sport}`);
        await page.click(`[data-draft-id="${FX.mkt1}"] [data-testid=btn-copy]`);
        await page.click(`[data-draft-id="${FX.mkt1}"] [data-testid=btn-mark-published]`); await page.fill('[data-testid=post-url]', 'https://example.com/uitest-post'); await confirm();
        await page.waitForSelector(`[data-draft-id="${FX.mkt1}"]`, { state: 'detached' }); ok(await status(FX.mkt1) === 'published', 'publish');
      });
      if (realContest) await check('Publishing on staging: schedule approved fixture campaign, sandbox-publish on the run, pause/resume, cancel', async () => {
        await C.drafts.updateOne({ id: FX.mkt1 }, { $set: { status: 'approved', ownerApproved: true } }); // re-approve the fixture copy (it was published above)
        const r = await api('POST', `/admin/drafts/${FX.mkt1}/schedule`, { channels: ['x', 'facebook'], scheduledAt: new Date(Date.now() - 20000).toISOString() });
        ok(r.status === 200 && r.json.results.some((x) => x.ok), `schedule ${JSON.stringify(r.json)}`);
        ok((await api('POST', '/admin/social/pause', { paused: true })).json.paused.paused === true, 'pause');
        await api('POST', '/admin/run-now');
        ok(await C.social.countDocuments({ draftId: FX.mkt1, status: 'published' }) === 0, 'published while paused');
        await api('POST', '/admin/social/pause', { paused: false });
        await new Promise((res) => setTimeout(res, 61000 - (Date.now() % 60000) + 500)); // next minute: a new run id
        await api('POST', '/admin/run-now');
        const pub = await C.social.find({ draftId: FX.mkt1, status: 'published' }).toArray();
        ok(pub.length >= 1 && pub.every((p) => p.sandbox === true), 'sandbox publish');
        ok((await C.drafts.findOne({ id: FX.mkt1 })).status === 'approved', 'sandbox counted as real');
        await goto('#/publishing'); await page.waitForSelector('[data-testid=post-row][data-status=published]');
      });
      await check('Affiliate onboarding on staging (fixture): approve invite -> invited -> active with live ID', async () => {
        await C.prospects.insertOne({ key: `partners:uitest2:${stamp}`, id: FX.prospect2, genre: 'boxing', focus: 'partners', name: `UI Test Creator ${stamp}`, sourceUrl: 'https://example.com/uitest-creator', source: 'uitest', verified: false, contact: null, contactVerified: false, consent: false, optedOut: false, firstSeenAt: new Date().toISOString(), uitest: true });
        ok((await api('POST', `/admin/prospects/${FX.prospect2}/contact`, { contact: `aff-${stamp}@example.invalid`, kind: 'affiliate', consentNote: 'UI test fixture' })).status === 201, 'aff contact');
        ok((await api('POST', `/admin/drafts/affiliate-${FX.prospect2}/approve`)).status === 200, 'aff approve');
        await goto('#/affiliates?sport=boxing');
        const row = `[data-testid=aff-row][data-aff-id="${FX.prospect2}"]`;
        await page.waitForSelector(`${row}[data-status=invite_prepared]`);
        await page.click(`${row} [data-testid=btn-aff-invited]`); await page.waitForSelector(`${row}[data-status=invited]`);
        await page.click(`${row} [data-testid=btn-aff-activate]`); await page.fill('[data-testid=live-affiliate-id]', 'ffffffffffffffffffff0001'); await confirm();
        await page.waitForSelector(`${row}[data-status=active]`);
      });
      await check('Public Relations: verified contact creates personalized email; approve in browser (fixture)', async () => {
        const r = await api('POST', `/admin/prospects/${FX.prospect}/contact`, { contact: `pr-${stamp}@example.invalid`, kind: 'pr', consentNote: 'UI test fixture' });
        ok(r.status === 201, `contact ${r.status} ${JSON.stringify(r.json)}`);
        await goto('#/pr?sport=boxing');
        await page.waitForSelector(`[data-draft-id="pr-${FX.prospect}"]`);
        await page.click(`[data-draft-id="pr-${FX.prospect}"] [data-testid=btn-preview]`); await page.waitForSelector(`[data-draft-id="pr-${FX.prospect}"] [data-testid=email-preview]`);
        await page.click(`[data-draft-id="pr-${FX.prospect}"] [data-testid=btn-approve]`); await confirm();
        await page.waitForSelector(`[data-draft-id="pr-${FX.prospect}"][data-status=approved]`);
        await page.click(`[data-draft-id="pr-${FX.prospect}"] [data-testid=btn-withdraw]`); await confirm();
        await page.waitForSelector(`[data-draft-id="pr-${FX.prospect}"][data-status=rejected]`);
      });
      await check('Automation: acknowledge alert, requeue job, add opt-out, run now', async () => {
        await goto('#/automation');
        await page.click(`[data-alert-key="${FX.alert}"] [data-testid=btn-ack]`);
        await page.waitForSelector(`[data-alert-key="${FX.alert}"]`, { state: 'detached' });
        ok((await C.alerts.findOne({ alertKey: FX.alert })).state === 'acknowledged', 'ack');
        await page.click(`[data-job-id="${FX.job}"] [data-testid=btn-requeue]`);
        await page.waitForFunction((id) => !document.querySelector(`[data-job-id="${id}"] [data-testid=btn-requeue]`), FX.job);
        ok((await C.jobs.findOne({ id: FX.job })).state === 'retry', 'requeue');
        await C.jobs.deleteOne({ id: FX.job, uitest: true }); // never let the scheduler pick up the fixture
        await page.fill('[data-testid=optout-email]', FX.optout); await page.click('[data-testid=btn-add-optout]');
        await page.waitForFunction((a) => document.querySelector('[data-testid=optout-table]')?.textContent.includes(a), FX.optout);
        const before = await C.runs.countDocuments();
        await page.click('[data-testid=btn-run-now]'); await confirm();
        await page.waitForSelector('[data-testid=toast]');
        ok(await C.runs.countDocuments() >= before, 'run now');
      });
      await check('browser: sign out, stale session and bad token all return to sign-in', async () => {
        await page.click('[data-testid=signout]'); await page.waitForSelector('[data-testid=login]');
        const stale = signConsoleToken(process.env.JWT_SECRET_ADMIN, { email: LABEL, pwv: 'old-password-ver' }, { expiresIn: '5m' });
        for (const t of [stale, 'not.a.token']) {
          await page.evaluate((x) => sessionStorage.setItem('fmmGrowthConsoleToken', x), t);
          await page.goto(`${STAGING}/api/growth/console#/automation`); await page.waitForSelector('[data-testid=login]');
        }
      });
      await check('no browser errors and no CORS refusals', async () => { ok(problems.length === 0, problems.join(' | ')); ok(corsErrors.length === 0, corsErrors.join(' ')); });
    }
  } catch (e) {
    exitCode = e.code || 1;
  } finally {
    // ---- cleanup: every fixture and every audit entry from this check ----
    try {
      await C.drafts.deleteMany({ id: { $in: [FX.mkt1, FX.mkt2, `pr-${FX.prospect}`, `affiliate-${FX.prospect2}`] } });
      await C.prospects.deleteMany({ id: { $in: [FX.prospect, FX.prospect2] }, uitest: true });
      await C.social.deleteMany({ draftId: { $in: [FX.mkt1, FX.mkt2] } });
      await C.sandbox.deleteMany({ postId: { $regex: `^uitest-` } });
      await C.affiliates.deleteMany({ id: FX.prospect2 });
      await gdb.collection('growth_sandbox_mail').deleteMany({ draftId: { $in: [`pr-${FX.prospect}`, `affiliate-${FX.prospect2}`] } });
      await gdb.collection('growth_settings').updateOne({ key: 'social' }, { $set: { paused: false } });
      await C.alerts.deleteMany({ alertKey: FX.alert, uitest: true });
      await C.jobs.deleteMany({ id: FX.job });
      await C.suppressions.deleteMany({ address: { $in: [FX.optout, `pr-${stamp}@example.invalid`, `aff-${stamp}@example.invalid`] } });
      await C.audit.deleteMany({ admin: LABEL });
      await C.audit.deleteMany({ id: { $regex: '^uitest-' } });
      const left = await C.drafts.countDocuments({ id: { $regex: `^(uitest-|pr-uitest-)` } }) + await C.prospects.countDocuments({ uitest: true }) + await C.alerts.countDocuments({ uitest: true }) + await C.jobs.countDocuments({ uitest: true }) + await C.suppressions.countDocuments({ address: { $regex: 'example\\.invalid$' } }) + await C.audit.countDocuments({ admin: LABEL }) + await C.social.countDocuments({ draftId: { $regex: '^uitest-' } }) + await C.affiliates.countDocuments({ id: { $regex: '^uitest-' } }) + await gdb.collection('growth_sandbox_mail').countDocuments({ draftId: { $regex: '-uitest-' } });
      log('cleanup leftovers:', left);
      if (left !== 0 && exitCode === 0) exitCode = 99;
    } catch (e) { log('cleanup failed', e.message); if (exitCode === 0) exitCode = 98; }
    if (browser) await browser.close().catch(() => {});
    await client.close().catch(() => {});
  }
  if (exitCode === 0) exitCode = browserOk ? 160 + (globalThis.__sportMask || 0) : 97;
  log('exit', exitCode);
  process.exit(exitCode);
}
main().catch((e) => { log('fatal', e && e.stack || e); process.exit(1); });
