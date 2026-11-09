'use strict';
// Browser acceptance for the APPROVE ALL & SEND button and the Autonomous Mode panel
// inside the embedded production console. API responses are fixtures; no provider is used.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), { chromium } = require('playwright');
test('APPROVE ALL & SEND shows the exact batch, needs one confirmation, and reports results separately; Autonomous Mode saves, enables and stops', async () => {
  const browser = await chromium.launch({ executablePath: process.env.GROWTH_TEST_CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } }), origin = 'https://engine.example.test', site = 'https://www.fantasymmadness.com';
  const calls = [];
  const item = { draftId: 'm1', kind: 'marketing', title: 'Inoue vs Akhmadaliev', channel: 'facebook', destination: 'FANTASY MMADNESS Page', destinationId: 'fb', text: 'EXACT FACEBOOK CAPTION', imageUrl: 'https://img.example/p.jpg', scheduledAt: '2026-11-10T15:05:00Z', needsContentApproval: true };
  const email = { draftId: 'p1', kind: 'pr', title: 'Story idea', channel: 'email', destination: 'host@show.example', recipient: 'host@show.example', subject: 'Story idea', text: 'EXACT EMAIL TEXT', scheduledAt: '2026-11-10T15:08:00Z', needsContentApproval: false };
  const preview = { ok: true, batchId: 'batch-11111111-1111-4111-8111-111111111111', digest: 'd'.repeat(64), confirmation: 'APPROVE ALL AND SEND', items: [item, email], excluded: [{ draftId: 'a1', kind: 'affiliate', title: 'Invite', channel: null, reasons: ['recipient_suitability_terms_and_attribution_verification_required'] }, { draftId: 'm1', kind: 'marketing', title: 'Inoue vs Akhmadaliev', channel: 'x', reasons: ['x_tweet_write_permission_not_granted'] }], truncated: 0, totals: { campaigns: 2, deliveries: 2, excluded: 2, byKind: { marketing: 1, pr: 1, affiliate: 0 }, byChannel: { email: 1, facebook: 1, instagram: 0 } } };
  const results = { ok: true, batchId: preview.batchId, confirmedAt: '2026-11-10T15:01:00Z', groups: { succeeded: [{ draftId: 'm1', kind: 'marketing', title: 'Inoue vs Akhmadaliev', channel: 'facebook', destination: 'Page', status: 'published', receipt: { providerPostId: 'POST-RECEIPT-1' }, note: 'Published; provider post ID recorded.' }], failed: [{ draftId: 'x9', kind: 'pr', title: 'Bounce', channel: 'email', status: 'failed', lastError: 'smtp_rejected' }], held: [{ draftId: 'a1', kind: 'affiliate', title: 'Invite', reasons: ['owner_campaign_hold'] }], queued: [{ draftId: 'p1', kind: 'pr', title: 'Story idea', channel: 'email', scheduledAt: '2026-11-10T15:08:00Z' }] } };
  let auto = { ok: true, enabled: false, version: 0, policy: null, releaseApproved: true, environment: 'production', distribution: { paused: false }, hardLimits: { email: { maxPerDay: 50, minSpacingMinutes: 2 }, facebook: { maxPerDay: 6, minSpacingMinutes: 30 }, instagram: { maxPerDay: 6, minSpacingMinutes: 30 } },
    defaults: { kinds: { marketing: { enabled: false, channels: [], templates: [] }, pr: { enabled: false, channels: [], templates: [], recontactDays: 60 }, affiliate: { enabled: false, channels: [], templates: [], recontactDays: 60 } }, limits: { email: { maxPerDay: 30, minSpacingMinutes: 3 }, facebook: { maxPerDay: 4, minSpacingMinutes: 60 }, instagram: { maxPerDay: 4, minSpacingMinutes: 60 } }, sendWindow: { startHour: 9, endHour: 21 }, maxAutoApprovalsPerRun: 10, includePreviouslyApproved: false },
    templates: [{ id: 'marketing/platform-copy-v2', kind: 'marketing', campaigns: 12, example: 'Fight night' }, { id: 'pr/outreach-v2', kind: 'pr', campaigns: 30, example: 'Story idea' }], versions: [], recent: [{ draftId: 'q', kind: 'pr', title: 'Held one', state: 'held', at: '2026-11-10T15:00:00Z', reasons: ['recipient_suppressed'] }], last24h: { distributed: 0, held: 1 }, lastRun: null };
  await page.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    if (u.origin === site) return route.fulfill({ contentType: 'text/html', body: '<iframe src="' + origin + '/api/growth/console?embed=1" width="1150" height="850"></iframe>' });
    if (u.pathname.startsWith('/api/growth/console')) { const file = u.pathname.endsWith('app.js') ? 'app.js' : u.pathname.endsWith('app.css') ? 'app.css' : 'index.html'; return route.fulfill({ contentType: file === 'index.html' ? 'text/html' : file === 'app.js' ? 'application/javascript' : 'text/css', body: fs.readFileSync('growth-production-console/' + file, 'utf8') }); }
    if (req.method() === 'POST') calls.push({ path: u.pathname, body: req.postDataJSON() });
    let body = { ok: true };
    const p = u.pathname.replace('/api/growth', '');
    if (p === '/health') body = { ok: true, console: { embedOrigins: [site] }, scheduler: { enabled: true } };
    else if (p.endsWith('/session')) body = { ok: true, expiresAt: Date.now() + 3600000 };
    else if (p === '/admin/drafts') body = { ok: true, drafts: [] };
    else if (p === '/admin/bulk') body = { ok: true, batches: [] };
    else if (p === '/admin/bulk/preview') body = preview;
    else if (p === '/admin/bulk/' + preview.batchId + '/confirm' || p === '/admin/bulk/' + preview.batchId) body = results;
    else if (p === '/admin/autonomous') body = auto;
    else if (p === '/admin/autonomous/policy') { auto = { ...auto, version: auto.version + 1, policy: req.postDataJSON().policy, versions: [{ version: auto.version + 1, savedAt: '2026-11-10T15:00:00Z', source: 'owner_edit' }] }; body = auto; }
    else if (p === '/admin/autonomous/enabled') { auto = { ...auto, enabled: req.postDataJSON().enabled }; body = auto; }
    else if (p === '/admin/autonomous/emergency-stop') { auto = { ...auto, enabled: false, emergencyStoppedAt: '2026-11-10T15:02:00Z', distribution: { paused: true, emergencyStopped: false } }; body = auto; }
    else if (p.endsWith('/overview')) body = { ok: true, overview: { drafts: {}, jobs: {}, social: {} } };
    else if (p.endsWith('/alerts')) body = { ok: true, alerts: [] };
    else if (p.endsWith('/jobs')) body = { ok: true, jobs: [] };
    else if (p.endsWith('/runs')) body = { ok: true, runs: [] };
    else if (p.endsWith('/suppressions')) body = { ok: true, suppressions: [] };
    else if (p.endsWith('/audit')) body = { ok: true, entries: [] };
    else if (p.endsWith('/worker-receipts')) body = { ok: true, receipts: [] };
    else if (p.endsWith('/status')) body = { ok: true, scheduler: {}, preparation: null, database: {}, delivery: {}, warnings: [] };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  try {
    const shot = async n => { if (process.env.UI_SHOTS_DIR) await page.screenshot({ path: process.env.UI_SHOTS_DIR + '/' + n + '.png' }); };
    page.setDefaultTimeout(6000); page.on('pageerror', e => console.log('browser-error', e.message));
    await page.goto(site); const frame = page.frameLocator('iframe'); await frame.getByText('Waiting for your existing administrator session.').waitFor();
    await page.evaluate(o => document.querySelector('iframe').contentWindow.postMessage({ type: 'fmm-growth-session', token: 'fixture-session' }, o), origin);
    await frame.locator('body').evaluate(() => { location.hash = '#/approvals'; });
    const btn = frame.getByTestId('btn-approve-all-send');
    await btn.waitFor();
    assert.equal(await btn.innerText(), 'APPROVE ALL & SEND');
    assert.equal(await btn.isDisabled(), false, 'the owner button is not disabled by the preparation safety sweep');
    assert.equal(await btn.evaluate(b => getComputedStyle(b).backgroundColor), 'rgb(201, 33, 39)', 'prominent red');
    await shot('1-approve-all-button');
    await btn.click();
    const modal = frame.getByTestId('modal');
    await modal.getByTestId('bulk-summary').waitFor();
    const text = await modal.innerText();
    for (const s of ['2 campaigns · 2 deliveries', 'EXACT FACEBOOK CAPTION', 'EXACT EMAIL TEXT', 'FANTASY MMADNESS Page', 'host@show.example', 'Subject:', '2 item(s) are held']) assert.ok(text.includes(s), 'preview shows ' + s);
    await shot('2-approve-all-preview');
    assert.equal(calls.filter(c => c.path.endsWith('/confirm')).length, 0, 'nothing confirmed by opening the preview');
    await frame.getByTestId('modal-confirm').click();
    await frame.getByTestId('bulk-group-succeeded').waitFor();
    const confirm = calls.filter(c => c.path.endsWith('/confirm'));
    assert.equal(confirm.length, 1); assert.equal(confirm[0].body.digest, preview.digest); assert.equal(confirm[0].body.confirmation, 'APPROVE ALL AND SEND');
    assert.match(await frame.getByTestId('bulk-group-succeeded').innerText(), /Successful · 1[\s\S]*POST-RECEIPT-1/);
    assert.match(await frame.getByTestId('bulk-group-failed').innerText(), /Failed · 1/);
    assert.match(await frame.getByTestId('bulk-group-held').innerText(), /Held · 1/);
    assert.match(await frame.getByTestId('bulk-group-queued').innerText(), /Queued — not yet published · 1/);
    await shot('3-batch-results');

    // ---- Autonomous Mode ----
    await frame.locator('body').evaluate(() => { location.hash = '#/automation'; });
    const panel = frame.getByTestId('autonomous-mode');
    await panel.getByTestId('autonomous-state').waitFor();
    assert.equal(await panel.getByTestId('autonomous-state').innerText(), 'OFF');
    assert.equal(await panel.getByTestId('autonomous-on').isDisabled(), true, 'cannot enable without a saved policy');
    await panel.getByTestId('policy-marketing-enabled').check();
    await panel.getByTestId('policy-marketing-ch-facebook').check();
    await panel.getByTestId('policy-template-marketing/platform-copy-v2').check();
    await panel.getByTestId('autonomous-save-policy').click(); await frame.getByTestId('modal-confirm').click();
    await panel.getByText('ON').or(panel.getByTestId('autonomous-on')).first().waitFor();
    const saved = calls.find(c => c.path.endsWith('/autonomous/policy'));
    assert.equal(saved.body.confirmation, 'SAVE AUTONOMOUS POLICY');
    assert.deepEqual(saved.body.policy.kinds.marketing, { enabled: true, channels: ['facebook'], templates: ['marketing/platform-copy-v2'] });
    await panel.getByTestId('autonomous-on').waitFor({ state: 'visible' });
    await frame.locator('[data-testid=autonomous-on]:not([disabled])').click(); await frame.getByTestId('modal-confirm').click();
    await frame.locator('[data-testid=autonomous-state]', { hasText: 'ON' }).waitFor();
    await shot('4-autonomous-mode-on');
    const en = calls.find(c => c.path.endsWith('/autonomous/enabled'));
    assert.deepEqual(en.body, { enabled: true, version: 1, confirmation: 'ENABLE AUTONOMOUS MODE' });
    await frame.getByTestId('autonomous-emergency-stop').click(); await frame.getByTestId('modal-confirm').click();
    await frame.locator('[data-testid=autonomous-state]', { hasText: 'OFF' }).waitFor();
    assert.ok(calls.some(c => c.path.endsWith('/autonomous/emergency-stop')));
    assert.match(await frame.getByTestId('autonomous-mode').innerText(), /X \(needs tweet\.write permission\) and TikTok \(needs video\.publish approval\)/);
  } finally { await browser.close(); }
});
