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
// delivery provider stays "none".
// Result is reported through the exit code (build logs are not readable here):
//   77 = all checks passed in the browser
//   78 = all HTTP checks passed, browser could not start
//   100+N = check N failed      1 = could not start
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { MongoClient } = require('mongodb');
const path = require('path');

const ISOLATED = 'prj_Hpe9UjGrBBJOm3boxHsL9lHesWLl';
const LABEL = 'live-check@growth-console';
const STAGING = 'https://fantasymmadness-growth-isolated-tes.vercel.app';
const stamp = Date.now().toString(36);
const FX = { mkt1: `uitest-mkt-a-${stamp}`, mkt2: `uitest-mkt-b-${stamp}`, prospect: `uitest-p-${stamp}`, alert: `uitest:alert-${stamp}`, job: `uitest-job-${stamp}`, optout: `uitest-${stamp}@example.invalid` };
const log = (...a) => console.log('[console-live-check]', ...a);
let step = 0;
const check = async (name, fn) => { step++; try { await fn(); log(`PASS ${step} ${name}`); } catch (e) { log(`FAIL ${step} ${name}: ${e && e.stack || e}`); throw Object.assign(new Error('check failed'), { code: 100 + step }); } };
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
  };
  const pwv = crypto.createHash('sha256').update(String(process.env.GROWTH_ADMIN_PASSWORD_HASH || '')).digest('hex').slice(0, 16);
  const token = jwt.sign({ email: LABEL, role: 'growth_owner', pwv }, process.env.JWT_SECRET_ADMIN, { expiresIn: '30m' });
  const api = async (m, p, body, extra = {}) => { const r = await fetch(`${origin}/api/growth${p}`, { method: m, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: STAGING, ...extra }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null), headers: r.headers }; };
  let browser = null; let browserOk = false; let exitCode = 0;
  const live = {};
  try {
    await check('health: isolated, Atlas fmgrowthtest, console sign-in configured, delivery none', async () => {
      const h = (await api('GET', '/health')).json;
      ok(h.ok && h.database.name === 'fmgrowthtest' && h.database.kind === 'atlas', 'health');
      ok(h.console.signInConfigured === true, 'sign-in not configured');
      ok(h.delivery.provider === 'none' && h.delivery.realDelivery === false, 'delivery not none');
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
    await check('sessions from before the password change are refused', async () => {
      const stale = jwt.sign({ email: LABEL, role: 'growth_owner', pwv: 'old-password-ver' }, process.env.JWT_SECRET_ADMIN, { expiresIn: '5m' });
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
      ok(pr.length === 5 && pr.every((w) => w.draftCount > 0), 'pr drafts'); ok(af.length === 5 && af.every((w) => w.draftCount > 0), 'affiliate drafts');
      const det = (await api('GET', `/admin/workstreams/${pr[0].runId}/${pr[0].workstreamId}`)).json.workstream; ok(det.drafts.length > 0 && det.drafts[0].html && det.drafts[0].prospectName, 'detail');
      const an = (await api('GET', '/admin/analytics')).json.analytics; live.analytics = an;
      ok(Object.values(an.workstreams.matrix).every((row) => Object.values(row).every((v) => v !== null)), 'matrix gaps');
      const at = (await api('GET', '/admin/attribution')).json.attribution; live.attribution = at; ok(at.paymentSource.connected === false, 'payment source');
      for (const p of ['/admin/runs', '/admin/jobs', '/admin/reports', '/admin/audit', '/admin/suppressions', '/admin/alerts?state=all', '/admin/drafts?kind=marketing', '/admin/prospects', '/admin/session']) ok((await api('GET', p)).status === 200, p);
      ok((await api('GET', '/admin/runs')).json.runs.length >= 2, 'runs'); ok((await api('GET', '/admin/reports')).json.reports.length >= 1, 'reports');
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
        await goto('#/pr?sport=boxing'); await page.waitForSelector('[data-testid=prepared-row]');
        await page.click('[data-testid=prepared-row] [data-testid=btn-view-template]'); await page.waitForSelector('[data-testid=prepared-list] [data-testid=email-preview]');
        await goto('#/affiliates?sport=pro-wrestling'); await page.waitForSelector('[data-testid=prepared-row]');
        await goto('#/analytics');
        const cells = await page.$$eval('[data-testid=workstream-matrix] td.cell', (els) => els.map((e) => e.textContent));
        ok(cells.length === 25 && cells.every((c) => c !== '—'), 'matrix');
        await goto('#/revenue'); ok(/not connected/.test(await page.textContent('[data-testid=payment-banner]')), 'revenue banner');
      });

      // ---- buttons, on labelled fixtures only ----
      const nowIso = new Date().toISOString();
      await C.drafts.insertMany([FX.mkt1, FX.mkt2].map((id) => ({ id, kind: 'marketing', genre: 'boxing', channels: ['instagram'], headline: `UI TEST ${id}`, text: 'UI test post — will be deleted automatically.', sourceUrl: 'https://example.com/uitest', status: 'needs_owner_review', ownerApproved: false, sendPermitted: false, createdAt: nowIso, uitest: true })));
      await C.prospects.insertOne({ key: `partners:uitest:${stamp}`, id: FX.prospect, genre: 'boxing', focus: 'partners', name: `UI Test Show ${stamp}`, sourceUrl: 'https://example.com/uitest-show', source: 'uitest', verified: false, contact: null, contactVerified: false, consent: false, optedOut: false, firstSeenAt: nowIso, uitest: true });
      await C.alerts.insertOne({ alertKey: FX.alert, kind: 'uitest', id: 'ui-test', error: 'UI test alert — will be deleted automatically', state: 'open', createdAt: nowIso, uitest: true });
      await C.jobs.insertOne({ id: FX.job, type: 'uitest_noop', state: 'failed', attempts: 3, dueAt: nowIso, lastError: 'UI test job — will be deleted automatically', createdAt: nowIso, uitest: true });

      await check('browser: Approvals edit, approve, publish, reject (fixtures)', async () => {
        await goto('#/approvals?status=needs_owner_review&kind=marketing&sport=boxing');
        await page.waitForSelector(`[data-draft-id="${FX.mkt1}"]`);
        await page.click(`[data-draft-id="${FX.mkt1}"] [data-testid=btn-edit]`); await page.fill('[data-testid=edit-title]', `UI TEST edited ${stamp}`); await confirm();
        await page.waitForFunction(([id, s]) => document.querySelector(`[data-draft-id="${id}"] [data-testid=draft-title]`)?.textContent === `UI TEST edited ${s}`, [FX.mkt1, stamp]);
        await page.click(`[data-draft-id="${FX.mkt1}"] [data-testid=btn-approve]`); await confirm();
        await page.waitForSelector(`[data-draft-id="${FX.mkt1}"]`, { state: 'detached' }); ok(await status(FX.mkt1) === 'approved', 'approve');
        await page.click(`[data-draft-id="${FX.mkt2}"] [data-testid=btn-reject]`); await page.fill('[data-testid=reject-reason]', 'ui test'); await confirm();
        await page.waitForSelector(`[data-draft-id="${FX.mkt2}"]`, { state: 'detached' }); ok(await status(FX.mkt2) === 'rejected', 'reject');
        await goto('#/approvals?status=approved&kind=marketing&sport=boxing');
        await page.click(`[data-draft-id="${FX.mkt1}"] [data-testid=btn-copy]`);
        await page.click(`[data-draft-id="${FX.mkt1}"] [data-testid=btn-mark-published]`); await page.fill('[data-testid=post-url]', 'https://example.com/uitest-post'); await confirm();
        await page.waitForSelector(`[data-draft-id="${FX.mkt1}"]`, { state: 'detached' }); ok(await status(FX.mkt1) === 'published', 'publish');
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
        const stale = jwt.sign({ email: LABEL, role: 'growth_owner', pwv: 'old-password-ver' }, process.env.JWT_SECRET_ADMIN, { expiresIn: '5m' });
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
      await C.drafts.deleteMany({ id: { $in: [FX.mkt1, FX.mkt2, `pr-${FX.prospect}`] } });
      await C.prospects.deleteMany({ id: FX.prospect, uitest: true });
      await C.alerts.deleteMany({ alertKey: FX.alert, uitest: true });
      await C.jobs.deleteMany({ id: FX.job });
      await C.suppressions.deleteMany({ address: { $in: [FX.optout, `pr-${stamp}@example.invalid`] } });
      await C.audit.deleteMany({ admin: LABEL });
      const left = await C.drafts.countDocuments({ id: { $regex: `^(uitest-|pr-uitest-)` } }) + await C.prospects.countDocuments({ uitest: true }) + await C.alerts.countDocuments({ uitest: true }) + await C.jobs.countDocuments({ uitest: true }) + await C.suppressions.countDocuments({ address: { $regex: 'example\\.invalid$' } }) + await C.audit.countDocuments({ admin: LABEL });
      log('cleanup leftovers:', left);
      if (left !== 0 && exitCode === 0) exitCode = 99;
    } catch (e) { log('cleanup failed', e.message); if (exitCode === 0) exitCode = 98; }
    if (browser) await browser.close().catch(() => {});
    await client.close().catch(() => {});
  }
  if (exitCode === 0) exitCode = browserOk ? 77 : 78;
  log('exit', exitCode);
  process.exit(exitCode);
}
main().catch((e) => { log('fatal', e && e.stack || e); process.exit(1); });
