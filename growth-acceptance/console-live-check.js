'use strict';
// Live check of the back-office console against the REAL isolated staging data
// (Atlas fmgrowthtest). Runs inside a build of the isolated Vercel project, which
// is the only place that holds the staging credentials. It serves the console
// from this commit, drives it in a real browser, and:
//   - reads every screen from the live data (read-only), and
//   - exercises every button on clearly labelled "uitest-" fixtures it creates,
//     then deletes every fixture and every audit entry it produced.
// Real drafts are never approved, rejected or edited. Nothing is sent: the
// delivery provider stays "none".
// Result is reported through the exit code (build logs are not readable here):
//   77 = all checks passed in the browser
//   78 = all HTTP checks passed, browser could not start
//   100+N = check N failed      1 = could not start
const express = require('express');
const jwt = require('jsonwebtoken');
const { MongoClient } = require('mongodb');
const path = require('path');

const ISOLATED = 'prj_Hpe9UjGrBBJOm3boxHsL9lHesWLl';
const LABEL = 'live-check@growth-console';
const stamp = Date.now().toString(36);
const FX = { mkt1: `uitest-mkt-a-${stamp}`, mkt2: `uitest-mkt-b-${stamp}`, prospect: `uitest-p-${stamp}`, alert: `uitest:alert-${stamp}`, job: `uitest-job-${stamp}`, optout: `uitest-${stamp}@example.invalid` };
const log = (...a) => console.log('[console-live-check]', ...a);
let step = 0;
const check = async (name, fn) => { step++; try { await fn(); log(`PASS ${step} ${name}`); } catch (e) { log(`FAIL ${step} ${name}: ${e && e.stack || e}`); throw Object.assign(new Error('check failed'), { code: 100 + step }); } };
const ok = (v, msg) => { if (!v) throw new Error(msg || 'assertion failed'); };

async function main() {
  if (process.env.VERCEL && !process.env.VERCEL_PROJECT_ID) process.env.VERCEL_PROJECT_ID = ISOLATED;
  ok(process.env.VERCEL_PROJECT_ID === ISOLATED, 'not the isolated project');
  const { registerIsolatedGrowthRoutes } = require(path.join(__dirname, '..', 'growth-isolated-routes'));
  const app = express();
  const mounted = registerIsolatedGrowthRoutes({ app, env: process.env, express });
  if (!mounted.mounted) { log('not mounted', mounted.errors); process.exit(1); }
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const runtime = await mounted.getRuntime();
  const C = runtime.collections;
  const token = jwt.sign({ email: LABEL, role: 'growth_owner' }, process.env.JWT_SECRET_ADMIN, { expiresIn: '30m' });
  const api = async (m, p, body) => { const r = await fetch(`${origin}/api/growth${p}`, { method: m, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null), headers: r.headers }; };
  let browser = null; let browserOk = false; let exitCode = 0;
  const live = {};
  try {
    await check('health: isolated, Atlas fmgrowthtest, console sign-in configured, delivery none', async () => {
      const h = (await api('GET', '/health')).json;
      ok(h.ok && h.database.name === 'fmgrowthtest' && h.database.kind === 'atlas', 'health');
      ok(h.console.signInConfigured === true, 'sign-in not configured');
      ok(h.delivery.provider === 'none' && h.delivery.realDelivery === false, 'delivery not none');
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

      await check('browser: sign-in screen, then live overview', async () => {
        await page.goto(`${origin}/api/growth/console`); await page.waitForSelector('[data-testid=login]');
        await page.evaluate((t) => sessionStorage.setItem('fmmGrowthConsoleToken', t), token);
        await page.goto(`${origin}/api/growth/console#/overview`);
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
      await check('no browser errors', async () => { ok(problems.length === 0, problems.join(' | ')); });
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
    server.close();
  }
  if (exitCode === 0) exitCode = browserOk ? 77 : 78;
  log('exit', exitCode);
  process.exit(exitCode);
}
main().catch((e) => { log('fatal', e && e.stack || e); process.exit(1); });
