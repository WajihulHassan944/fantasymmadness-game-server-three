'use strict';
// Independent acceptance report, run on a GitHub runner (outside Vercel) against the PUBLIC
// isolated staging address only. Read-only: it never signs in, never changes anything.
//   - isolation gate + console framing headers
//   - the latest live-check evidence record (written on staging by the live check)
//   - every recorded poster: downloaded from staging, QR decoded with jsQR, compared with the
//     recorded canonical link, and the decoded link opened on the live website
//   - a real Chromium: the admin site origin embeds the console (no refused-to-connect);
//     a foreign origin is refused
const fs = require('fs'); const path = require('path'); const sharp = require('sharp'); const jsQR = require('jsqr');
const STAGING = 'https://fantasymmadness-growth-isolated-tes.vercel.app';
const WEB = 'https://fmm-ver2-git-test-growth-e-7c8860-kelly-davis-projects-6c108d0b.vercel.app';
const out = process.argv[2] || 'acceptance-report'; fs.mkdirSync(out, { recursive: true });
const lines = []; let fails = 0;
const row = (name, pass, detail = '') => { lines.push(`| ${pass ? 'PASS' : 'FAIL'} | ${name} | ${String(detail).replace(/\|/g, '/').slice(0, 400)} |`); if (!pass) fails++; console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
const printImage = async (name, buf) => { const b = await sharp(buf).resize({ width: 540 }).jpeg({ quality: 78 }).toBuffer(); const s = b.toString('base64'); for (let i = 0; i < s.length; i += 30000) console.log(`IMG:${name}:${s.slice(i, i + 30000)}`); };

(async () => {
  const h = await fetch(`${STAGING}/api/growth/health`, { redirect: 'manual' });
  const hj = await h.json().catch(() => ({}));
  row('Public staging address answers (no Vercel sign-in wall)', h.status === 200, `HTTP ${h.status}`);
  row('Isolated database pinned', hj.database && hj.database.hostPinned === true && hj.database.name === 'fmgrowthtest', `${hj.database && hj.database.host} pinned=${hj.database && hj.database.hostPinned}`);
  row('Email: sandbox only', hj.delivery && hj.delivery.realDelivery === false, `provider=${hj.delivery && hj.delivery.provider}`);
  for (const p of ['/', '/api/cron-job', '/api/users/login']) { const r = await fetch(`${STAGING}${p}`, { redirect: 'manual' }); row(`Legacy route blocked: ${p}`, r.status === 404, `HTTP ${r.status}`); }
  const con = await fetch(`${STAGING}/api/growth/console?embed=1`);
  const csp = con.headers.get('content-security-policy') || '';
  row('Console framing: only the admin site origins (CSP frame-ancestors, no X-Frame-Options)', con.status === 200 && csp.includes(WEB) && !csp.includes('*') && !con.headers.get('x-frame-options'), (csp.match(/frame-ancestors[^;]*/) || [''])[0]);
  const ev = await (await fetch(`${STAGING}/api/growth/acceptance`)).json();
  const run = (ev.runs || [])[0];
  row('Latest staging live-check evidence', Boolean(run) && run.public.result === 'PASS', run ? `${run.id} at ${run.at}: ${run.public.result}, ${run.public.stepsPassed} checks, commit ${String(run.public.commit).slice(0, 7)}` : 'none');
  const posters = [];
  if (run) {
    for (const p of run.public.realPosters || []) posters.push({ label: `real campaign ${p.fight} (${p.date})`, ...p });
    if (run.public.sandbox) posters.push({ label: `sandbox test copy (${run.public.sandbox.contestId})`, portrait: run.public.sandbox.portrait, story: run.public.sandbox.story, qrEncoded: run.public.sandbox.qrEncoded, mode: run.public.sandbox.posterMode, needsArtwork: run.public.sandbox.needsArtwork });
  }
  let n = 0;
  for (const p of posters) {
    for (const fmt of ['portrait', 'story']) {
      const r = await fetch(p[fmt]); const buf = Buffer.from(await r.arrayBuffer());
      const md = r.ok ? await sharp(buf).metadata() : {};
      const { data, info } = r.ok ? await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true }) : { data: Buffer.alloc(0), info: {} };
      const q = r.ok ? jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height) : null;
      row(`${p.label} ${fmt} poster: served ${md.width}x${md.height}; QR decoded from the image`, r.ok && md.width === 1080 && md.height === (fmt === 'portrait' ? 1350 : 1920) && q && q.data === p.qrEncoded, q ? q.data : 'not decodable');
      if (r.ok) { fs.writeFileSync(path.join(out, `poster-${++n}-${fmt}.jpg`), buf); await printImage(`poster-${n}-${fmt}.jpg`, buf); }
    }
    const d = await fetch(p.qrEncoded, { redirect: 'follow' });
    row(`${p.label}: decoded QR link opens the fight on the live website`, d.status === 200 && new URL(d.url).hostname === 'www.fantasymmadness.com', `${d.status} ${new URL(d.url).origin}${new URL(d.url).pathname}`);
    row(`${p.label}: artwork`, true, `${p.mode}${p.needsArtwork ? ' (NEEDS ARTWORK: ' + (p.missing || []).join(', ') + ')' : ''}${(p.fighters || []).map((f) => ` ${f.name}=${f.source} sha ${String(f.sha256).slice(0, 10)}`).join(';')}`);
  }
  if (run && run.public.sandbox) for (const rc of run.public.sandbox.receipts) row(`Sandbox receipt ${rc.channel}`, Boolean(rc.receiptId) && rc.problems.length === 0, `${rc.receiptId} image=${rc.imageUrl ? 'poster' : 'none'}; ${rc.notes.join('; ')}`);
  if (run && run.public.sandbox) row('Paused gate held; no duplicate dispatch; no real post', run.public.sandbox.pausedGateHeld && run.public.sandbox.duplicateDispatchBlocked && run.public.sandbox.realPosts === 0, `analytics sandbox posts ${run.public.sandbox.analyticsSandboxPosts.before} -> ${run.public.sandbox.analyticsSandboxPosts.after}`);
  // real browser: embedded command center
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const embed = async (pageOrigin) => {
    const pg = await ctx.newPage();
    await ctx.route(`${pageOrigin}/__embed-check`, (rt) => rt.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><title>Admin preview origin test</title><body style="margin:0;background:#111"><iframe style="width:1340px;height:880px;border:0" src="${STAGING}/api/growth/console?embed=1#/marketing"></iframe></body>` }));
    await pg.goto(`${pageOrigin}/__embed-check`);
    let login = false; const fr = () => pg.frames().find((f) => f !== pg.mainFrame());
    for (let i = 0; i < 60 && !login; i++) { await pg.waitForTimeout(500); try { login = Boolean(fr() && await fr().$('[data-testid=login]')); } catch { /* navigating */ } }
    const shot = await pg.screenshot({ type: 'jpeg', quality: 70 }); await pg.close(); return { login, shot };
  };
  const good = await embed(WEB); fs.writeFileSync(path.join(out, 'embed-admin-origin.jpg'), good.shot); await printImage('embed-admin-origin.jpg', good.shot);
  row('Real browser: admin site origin embeds the Growth Engine console (no refused-to-connect)', good.login, good.login ? 'sign-in form rendered inside the iframe' : 'console did not render');
  const bad = await embed('https://not-the-admin-site.example');
  row('Real browser: a foreign site cannot embed the console', !bad.login, bad.login ? 'EMBEDDED' : 'refused');
  await browser.close();
  const md = ['## Growth Engine staging acceptance (independent GitHub runner, public staging address, read-only)', '', `Run: ${new Date().toISOString()}`, '', '| Result | Check | Detail |', '|---|---|---|', ...lines, '', fails ? `**${fails} check(s) failed.**` : '**All checks passed.**'].join('\n');
  fs.writeFileSync(path.join(out, 'report.md'), md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  console.log(md);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
