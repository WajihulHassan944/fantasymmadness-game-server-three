'use strict';

// Website smoke checks against the isolated staging backend (combined test
// branch). Pages: fight listing with fighter photos + fallback images, fight
// page, affiliate league page (QR/OG preview), affiliate kit QR code, login,
// and checkout navigation (gateway not configured in staging; nothing is paid).

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { readQr } = require('../../affiliate-custom-poster');

const SITE = process.env.STAGING_SITE || 'http://localhost:3000';
const OUT = path.resolve(process.env.STAGING_OUT_DIR || path.join(__dirname, 'out'));
const ctx = JSON.parse(fs.readFileSync(path.join(OUT, 'e2e-context.json'), 'utf8'));
const results = [];
const LABEL = process.env.SITE_LABEL || 'website';
const check = (name, ok, detail = '') => { results.push({ name: `[${LABEL}] ${name}`, ok: Boolean(ok), detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

async function main() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(`${new URL(page.url()).pathname}: ${error.message}`));
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(`${new URL(page.url()).pathname}: ${message.text().slice(0, 200)}`); });
  const listingResponses = [];
  page.on('response', async (response) => {
    if (!/\/api\/public\/fights(\?|$)/.test(response.url())) return;
    try {
      const body = await response.json();
      const rows = body.items || body.data || [];
      const seeded = rows.find((row) => String(row._id || row.id) === ctx.fightId);
      listingResponses.push({ status: response.status(), count: rows.length, seeded: seeded ? { matchType: seeded.matchType, matchDate: seeded.matchDate, matchTime: seeded.matchTime, matchStatus: seeded.matchStatus, hasUserPredictions: Array.isArray(seeded.userPredictions) } : null });
    } catch { listingResponses.push({ status: response.status(), unreadable: true }); }
  });
  try {
    // Fight listing + fighter photos (UpcomingFights, the component fixed in #187).
    const listing = await page.goto(`${SITE}/upcomingfights`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    const listed = await page.locator('.fightItem').count();
    check('Upcoming fights page loads', listing.status() === 200, `HTTP ${listing.status()}`);
    console.log('listing API responses:', JSON.stringify(listingResponses));
    console.log('console errors on listing:', JSON.stringify(consoleErrors.filter((m) => m.startsWith('/upcomingfights')).slice(0, 8)));
    check('Fight listing API returns the seeded fight', listingResponses.some((r) => r.seeded), JSON.stringify(listingResponses).slice(0, 400));
    check('Fight listing shows the seeded fights', listed > 0 && await page.getByText('Elif Nur Turhan', { exact: false }).count() > 0, `${listed} fight cards`);
    const photos = await page.locator('.fightItem .fightersImages img').evaluateAll((images) => images.map((img) => ({ src: img.currentSrc || img.src, ok: img.complete && img.naturalWidth > 0, fallback: img.dataset.fallbackApplied === 'true' })));
    check('Fighter photos render (or fall back) on every card', photos.length > 0 && photos.every((p) => p.ok), JSON.stringify(photos.slice(0, 4)));
    check('Broken fighter photo is replaced by the fallback image', photos.some((p) => p.fallback), `${photos.filter((p) => p.fallback).length} fallbacks applied`);
    await page.screenshot({ path: path.join(OUT, 'site-upcomingfights.png'), fullPage: true });
    if (listed > 0) {
      await Promise.all([page.waitForURL(/\/fight\//, { timeout: 15000 }).catch(() => {}), page.locator('.fightItem').filter({ hasText: 'Elif Nur Turhan' }).first().click()]);
      check('Clicking a fight card navigates to its fight page', /\/fight\//.test(page.url()), page.url());
    }

    // Fight page.
    const fightPage = await page.goto(`${SITE}/fight/${ctx.fightId}?ref=${ctx.kelise}`, { waitUntil: 'networkidle' });
    check('Fight page loads', fightPage.status() === 200, `HTTP ${fightPage.status()}`);
    check('Fight page shows the fighters', await page.getByText(/Turhan/i).count() > 0 && await page.getByText(/Baumgardner/i).count() > 0);

    // Affiliate league page (where Kelise's QR lands) + link preview tag.
    const league = await page.goto(`${SITE}/league/${ctx.kelise}?fightId=${ctx.fightId}`, { waitUntil: 'networkidle' });
    check('Affiliate league page (QR destination) loads', league.status() === 200, `HTTP ${league.status()}`);
    const og = await page.locator('meta[property="og:image"]').getAttribute('content').catch(() => '');
    check('League page link preview points at Kelise\'s share image', Boolean(og) && og.includes(`affiliateId=${ctx.kelise}`) && og.includes('v=14'), og);
    check('League page offers to join Kelise\'s league', await page.getByText(/Kelise/i).count() > 0);

    // Affiliate kit QR code (Show QR) decodes to her tracked link.
    await page.goto(`${SITE}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((token) => localStorage.setItem('affiliateAuthToken', token), ctx.keliseToken);
    await page.goto(`${SITE}/affiliate/fight-launch?fightId=${ctx.fightId}&affiliateId=${ctx.kelise}`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /Show QR/ }).first().click();
    const qrSrc = await page.locator('img[alt^="QR code for"]').first().getAttribute('src', { timeout: 10000 }).catch(() => '');
    const qr = qrSrc ? await readQr(sharp, Buffer.from(qrSrc.split(',')[1], 'base64')) : null;
    check('Kit "Show QR" code opens Kelise\'s league for this fight', qr?.data === ctx.keliseLeagueLink, qr?.data);
    await page.evaluate(() => localStorage.clear());

    // Login page renders a working form.
    const auth = await page.goto(`${SITE}/auth?mode=login&role=affiliate`, { waitUntil: 'networkidle' });
    check('Login page loads with email and password fields', auth.status() === 200 && await page.locator('input[type="email"], input[name="email"]').count() > 0 && await page.locator('input[type="password"]').count() > 0, `HTTP ${auth.status()}`);

    // Checkout navigation: page loads; payment form does not reach any gateway.
    const gatewayCalls = [];
    page.on('request', (request) => { if (/authorize\.net|stripe\.com/i.test(request.url())) gatewayCalls.push(request.url()); });
    const checkout = await page.goto(`${SITE}/checkout?product=fm-coins`, { waitUntil: 'networkidle' });
    check('Checkout page loads', checkout.status() === 200, `HTTP ${checkout.status()}`);
    await page.screenshot({ path: path.join(OUT, 'site-checkout.png'), fullPage: true });
    const checkoutText = await page.locator('body').innerText();
    check('Checkout shows the coin product and payment section', /FM COINS|coins/i.test(checkoutText), checkoutText.slice(0, 160).replace(/\s+/g, ' '));
    check('No request reached a live payment gateway', gatewayCalls.length === 0, gatewayCalls.join(' | '));

    const fatal = pageErrors.filter((message) => !/Failed to fetch|NetworkError|Load failed|ChunkLoadError/i.test(message));
    check('No uncaught page errors on tested pages', fatal.length === 0, fatal.slice(0, 5).map((m) => m.slice(0, 220)).join(' | '));
  } finally {
    await browser.close();
  }
}

main().catch((error) => check('Website smoke script completed', false, error.stack || error.message))
  .finally(() => {
    fs.writeFileSync(path.join(OUT, LABEL === 'website' ? 'site-results.json' : `site-results-${LABEL}.json`), JSON.stringify(results, null, 2));
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} website checks passed`);
    process.exitCode = failed.length ? 1 : 0;
  });
