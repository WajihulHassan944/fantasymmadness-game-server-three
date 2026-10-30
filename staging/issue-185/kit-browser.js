'use strict';

// Issue #185 browser check of the affiliate fight kit, opened from the link in
// the email Kelise actually received in the staging mailbox. Uses the repair
// branch of the website (fmm-ver2) running locally against the isolated
// staging server. Verifies what she sees, Copy Poster, Download Poster, the
// phone share fallback and the social link preview image.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { readQr } = require('../../affiliate-custom-poster');

const SITE = process.env.STAGING_SITE || 'http://localhost:3000';
const OUT = path.resolve(process.env.STAGING_OUT_DIR || path.join(__dirname, 'out'));
const context = JSON.parse(fs.readFileSync(path.join(OUT, 'e2e-context.json'), 'utf8'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

async function openKit(browser, token, link) {
  const page = await browser.newPage({ acceptDownloads: true });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: SITE });
  const posterRequests = [];
  page.on('request', (request) => { const url = request.url(); if (/custom-poster\/image|fight-poster-image/.test(url)) posterRequests.push(url); });
  await page.goto(`${SITE}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((value) => { localStorage.setItem('affiliateAuthToken', value); }, token);
  await page.goto(link.replace('https://www.fantasymmadness.com', SITE), { waitUntil: 'networkidle' });
  return { page, posterRequests };
}

async function main() {
  const { chromium } = require('playwright');
  check('Kit link taken from Kelise\'s received email', /affiliate\/fight-launch\?fightId=.+&affiliateId=/.test(context.keliseKitLink), context.keliseKitLink);
  const browser = await chromium.launch();
  try {
    // ---- Kelise ------------------------------------------------------------
    const { page, posterRequests } = await openKit(browser, context.keliseToken, context.keliseKitLink);
    const image = page.locator('[data-personalized-poster="true"]');
    await image.waitFor({ timeout: 20000 });
    const shown = Buffer.from(await page.evaluate(async () => {
      const element = document.querySelector('[data-personalized-poster="true"]');
      const blob = await (await fetch(element.src)).blob();
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    }));
    await page.screenshot({ path: path.join(OUT, 'kit-kelise.png'), fullPage: true });
    check('Kit shows Kelise\'s personalized poster (byte-identical)', sha(shown) === context.approvedSha256, sha(shown));
    check('Kit did not load the general poster for Kelise', !posterRequests.some((url) => url.includes('fight-poster-image')), posterRequests.join(' | '));

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download poster' }).click()]);
    const downloaded = fs.readFileSync(await download.path());
    fs.writeFileSync(path.join(OUT, `kit-download-${download.suggestedFilename()}`), downloaded);
    check('Download Poster saves the personalized poster (byte-identical)', sha(downloaded) === context.approvedSha256, `${download.suggestedFilename()} ${sha(downloaded)}`);

    await page.getByRole('button', { name: 'Copy poster' }).click();
    await page.waitForTimeout(1500);
    const copied = Buffer.from(await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const blob = await items[0].getType('image/png');
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    }).catch(() => []));
    const copiedQr = copied.length ? await readQr(sharp, copied) : null;
    const [copiedRaw, approvedRaw] = copied.length ? await Promise.all([sharp(copied).removeAlpha().raw().toBuffer(), sharp(shown).removeAlpha().raw().toBuffer()]) : [Buffer.alloc(0), Buffer.alloc(1)];
    check('Copy Poster puts the personalized poster on the clipboard (same pixels)', copied.length > 0 && sha(copiedRaw) === sha(approvedRaw), `${copied.length} bytes`);
    check('Copied poster QR opens Kelise\'s league', copiedQr?.data === context.keliseLeagueLink, copiedQr?.data);

    // Phone share: headless Chromium cannot share files, so the kit saves the
    // same file to Downloads (its documented fallback).
    await page.locator('summary', { hasText: 'Want to share the poster through your phone instead?' }).first().click();
    const [shared] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Share poster once/ }).first().click()]);
    const sharedBytes = fs.readFileSync(await shared.path());
    check('Share poster (fallback) uses the personalized poster', sha(sharedBytes) === context.approvedSha256, sha(sharedBytes));

    // Social link preview (Facebook share of her league link).
    const preview = await page.request.get(`${SITE}/api/fight-share-image?fightId=${context.fightId}&affiliateId=${context.kelise}&format=facebook&v=14`);
    const previewBytes = Buffer.from(await preview.body());
    fs.writeFileSync(path.join(OUT, 'social-preview-kelise.png'), previewBytes);
    check('Social link preview built from the personalized poster', preview.status() === 200 && preview.headers()['x-poster-source'] === 'personalized', `${preview.status()} ${preview.headers()['x-poster-source']}`);
    const previewQr = await readQr(sharp, previewBytes);
    check('Social preview QR credits Kelise', Boolean(previewQr?.data) && previewQr.data.includes(context.kelise), previewQr?.data);
    await page.close();

    // ---- Affiliate without a personalized poster ---------------------------
    const controlLink = `${SITE}/affiliate/fight-launch?fightId=${context.fightId}&affiliateId=${context.control}`;
    const control = await openKit(browser, context.controlToken, controlLink);
    await control.page.waitForTimeout(2500);
    await control.page.screenshot({ path: path.join(OUT, 'kit-control.png'), fullPage: true });
    check('Other affiliate\'s kit requests the general fight poster', control.posterRequests.some((url) => url.includes('fight-poster-image') && url.includes(encodeURIComponent(context.generalUrl))), control.posterRequests.join(' | '));
    check('Other affiliate\'s kit shows no personalized poster', await control.page.locator('[data-personalized-poster="true"]').count() === 0);
    const controlPreview = await control.page.request.get(`${SITE}/api/fight-share-image?fightId=${context.fightId}&affiliateId=${context.control}&format=facebook&v=14`);
    check('Other affiliate\'s social preview uses the general poster', controlPreview.headers()['x-poster-source'] === 'general', `${controlPreview.status()} ${controlPreview.headers()['x-poster-source']}`);
    await control.page.close();
  } finally {
    await browser.close();
  }
}

main().catch((error) => check('Browser script completed', false, error.stack || error.message))
  .finally(() => {
    fs.writeFileSync(path.join(OUT, 'browser-results.json'), JSON.stringify(results, null, 2));
    const failed = results.filter((row) => !row.ok);
    console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
    process.exitCode = failed.length ? 1 : 0;
  });
