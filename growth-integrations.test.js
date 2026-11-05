'use strict';
// Social publishing gates + adapters, email readiness, affiliate links, signed events.
// No network: every external call goes to a recording stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { resolveSocialConfig, createSocialPublisher } = require('./growth-social-publishing');
const { checkEmailReadiness } = require('./growth-email-readiness');
const { verifySignature, onboardingLink, playerLink, codeFor, campaignFor } = require('./growth-affiliate-program');

const LIVE = { GROWTH_SOCIAL_PROVIDER: 'live', GROWTH_SOCIAL_PUBLISHING_APPROVED: 'true', GROWTH_SOCIAL_CHANNELS_ENABLED: 'facebook,instagram,x,tiktok', GROWTH_FB_PAGE_ID: '1234567890', GROWTH_FB_PAGE_ACCESS_TOKEN: 'f'.repeat(40), GROWTH_IG_USER_ID: '17841400000000000', GROWTH_IG_ACCESS_TOKEN: 'i'.repeat(40), GROWTH_X_USER_ACCESS_TOKEN: 'x'.repeat(40), GROWTH_TIKTOK_ACCESS_TOKEN: 't'.repeat(40) };
const recorder = (responses) => { const calls = []; const f = async (url, opts) => { calls.push({ url, opts }); const r = responses.shift() || { status: 200, body: {} }; return { ok: r.status < 400, status: r.status, json: async () => r.body }; }; f.calls = calls; return f; };
const post = (channel, extra = {}) => ({ id: `mkt-x__${channel}`, channel, text: 'Naoya Inoue vs Murodjon Akhmadaliev — picks open https://www.fantasymmadness.com/fight/abc?play=1', imageUrl: 'https://res.cloudinary.com/demo/poster.jpg', ...extra });

test('publishing is off by default and every live gate is required', () => {
  const none = resolveSocialConfig({});
  assert.equal(none.provider, 'none'); for (const c of Object.values(none.channels)) assert.equal(c.ready, false);
  for (const drop of ['GROWTH_SOCIAL_PUBLISHING_APPROVED', 'GROWTH_SOCIAL_CHANNELS_ENABLED', 'GROWTH_FB_PAGE_ACCESS_TOKEN']) {
    const c = resolveSocialConfig({ ...LIVE, [drop]: '' }).channels.facebook;
    assert.equal(c.ready, false, drop); assert.ok(c.blockers.length);
  }
  const live = resolveSocialConfig(LIVE);
  for (const c of Object.values(live.channels)) assert.equal(c.ready, true);
  assert.equal(live.channels.tiktok.tiktokMode, 'MEDIA_UPLOAD'); // inbox draft until TikTok audit approval
  assert.equal(resolveSocialConfig({ ...LIVE, GROWTH_TIKTOK_DIRECT_POST_APPROVED: 'true' }).channels.tiktok.tiktokMode, 'DIRECT_POST');
  assert.ok(resolveSocialConfig({ GROWTH_SOCIAL_PROVIDER: 'bogus' }).errors.length);
  assert.ok(!JSON.stringify(live.channels).includes('ffffffff'), 'tokens never in public config');
});

test('unauthorized channel is refused without any network call', async () => {
  const f = recorder([]);
  const r = await createSocialPublisher({ social: resolveSocialConfig({}), fetchImpl: f }).publish(post('x'));
  assert.equal(r.ok, false); assert.equal(f.calls.length, 0);
});

test('sandbox publishing never touches the network and is labelled simulated', async () => {
  const f = recorder([]); const rows = [];
  const r = await createSocialPublisher({ social: resolveSocialConfig({ GROWTH_SOCIAL_PROVIDER: 'sandbox' }), fetchImpl: f, sandboxCollection: { insertOne: async (d) => rows.push(d) } }).publish(post('facebook'));
  assert.equal(r.ok, true); assert.equal(r.receipt.sandbox, true); assert.equal(rows.length, 1);
  // Only a read-only check of the poster image; nothing is sent to Meta.
  assert.ok(f.calls.every((c) => c.opts?.method === 'HEAD' && !/facebook\.com|instagram\.com/.test(c.url)), JSON.stringify(f.calls));
  const off = recorder([]);
  await createSocialPublisher({ social: resolveSocialConfig({ GROWTH_SOCIAL_PROVIDER: 'sandbox' }), fetchImpl: off, checkImages: false }).publish(post('instagram'));
  assert.equal(off.calls.length, 0);
});

test('live adapters send the documented requests', async () => {
  const social = resolveSocialConfig(LIVE);
  let f = recorder([{ status: 200, body: { id: '123_456', post_id: '123_456' } }]);
  let r = await createSocialPublisher({ social, fetchImpl: f, checkImages: false }).publish(post('facebook'));
  assert.equal(r.ok, true); assert.match(f.calls[0].url, /graph\.facebook\.com\/v21\.0\/1234567890\/photos$/); assert.match(f.calls[0].opts.body, /caption=/);
  r = await createSocialPublisher({ social, fetchImpl: (f = recorder([{ status: 200, body: { id: '1' } }])), checkImages: false }).publish(post('facebook', { imageUrl: null }));
  assert.match(f.calls[0].url, /\/feed$/); assert.match(f.calls[0].opts.body, /message=/);

  f = recorder([{ status: 200, body: { id: 'container1' } }, { status: 200, body: { id: 'media9' } }, { status: 200, body: { permalink: 'https://www.instagram.com/p/abc/' } }]);
  r = await createSocialPublisher({ social, fetchImpl: f, checkImages: false }).publish(post('instagram'));
  assert.equal(r.receipt.providerPostId, 'media9'); assert.equal(r.receipt.url, 'https://www.instagram.com/p/abc/'); assert.match(f.calls[0].url, /\/media$/); assert.match(f.calls[1].url, /\/media_publish$/); assert.match(f.calls[1].opts.body, /creation_id=container1/);
  assert.equal((await createSocialPublisher({ social, fetchImpl: recorder([]), checkImages: false }).publish(post('instagram', { imageUrl: null }))).ok, false);

  f = recorder([{ status: 201, body: { data: { id: '99' } } }]);
  r = await createSocialPublisher({ social, fetchImpl: f, checkImages: false }).publish(post('x'));
  assert.equal(r.receipt.url, 'https://x.com/i/web/status/99'); assert.equal(f.calls[0].url, 'https://api.x.com/2/tweets'); assert.match(f.calls[0].opts.headers.Authorization, /^Bearer /);

  f = recorder([{ status: 200, body: { data: { publish_id: 'p_1' }, error: { code: 'ok' } } }]);
  r = await createSocialPublisher({ social, fetchImpl: f, checkImages: false }).publish(post('tiktok'));
  const body = JSON.parse(f.calls[0].opts.body);
  assert.equal(body.post_mode, 'MEDIA_UPLOAD'); assert.equal(body.source_info.source, 'PULL_FROM_URL'); assert.equal(r.receipt.pending, 'in_tiktok_inbox_as_draft');
});

test('provider errors: rate limits / outages retry, rejections do not', async () => {
  const social = resolveSocialConfig(LIVE);
  assert.equal((await createSocialPublisher({ social, fetchImpl: recorder([{ status: 429, body: {} }]) }).publish(post('x'))).retryable, true);
  assert.equal((await createSocialPublisher({ social, fetchImpl: recorder([{ status: 503, body: {} }]) }).publish(post('x'))).retryable, true);
  const bad = await createSocialPublisher({ social, fetchImpl: recorder([{ status: 403, body: { detail: 'not permitted' } }]) }).publish(post('x'));
  assert.equal(bad.retryable, false); assert.match(bad.reason, /403/);
  assert.ok(!bad.reason.includes('xxxxxxxx'));
});

test('email readiness reads DNS + provider status and never sends', async () => {
  const dns = { 'fantasymmadnesscom.com': ['v=spf1 include:amazonses.com ~all'], 'resend._domainkey.fantasymmadnesscom.com': ['p=' + 'A'.repeat(60)], '_dmarc.fantasymmadnesscom.com': ['v=DMARC1; p=none'] };
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    if (url.startsWith('https://cloudflare-dns.com')) { const name = new URL(url).searchParams.get('name'); return { ok: true, json: async () => ({ Answer: (dns[name] || []).map((d) => ({ type: 16, data: `"${d}"` })) }) }; }
    if (url === 'https://api.resend.com/domains') return { ok: true, json: async () => ({ data: [{ name: 'fantasymmadnesscom.com', status: 'verified' }] }) };
    throw Error('unexpected ' + url);
  };
  const r = await checkEmailReadiness({ delivery: { provider: 'none', realDelivery: false, blockers: [] }, sender: 'contact@fantasymmadnesscom.com', apiKey: 'k', fetchImpl });
  assert.equal(r.dns.spf, true); assert.equal(r.dns.dkim, true); assert.equal(r.dns.dmarc, true); assert.equal(r.providerDomain.status, 'verified');
  assert.equal(r.ready, false, 'still not ready: owner approval flags are off');
  assert.ok(calls.every((u) => !/emails/.test(u)), 'no send endpoint called');
  const empty = await checkEmailReadiness({ delivery: { provider: 'none', blockers: [] }, sender: 'contact@fantasymmadnesscom.com', fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(empty.dns.spf, false); assert.equal(empty.providerDomain.checked, false);
});

test('affiliate links use the live site mechanisms; tracked link only once active', () => {
  const code = codeFor('p-abc', 'Fight Talk Boxing Show');
  assert.match(campaignFor(code), /^combat_fans_[a-z0-9_-]{1,60}$/);
  const a = { code, status: 'invited', liveAffiliateId: null };
  assert.match(onboardingLink(a), /^https:\/\/www\.fantasymmadness\.com\/auth\?mode=signup&role=affiliate&utm_source=fan_acquisition&utm_medium=partner_outreach&utm_campaign=combat_fans_aff_/);
  const contest = { id: 'bx0000000001', sport: 'boxing' };
  assert.equal(playerLink(a, contest), null);
  const live = { ...a, status: 'active', liveAffiliateId: '0123456789abcdef01234567' };
  assert.match(playerLink(live, contest), /\/fight\/bx0000000001\?play=1&ref=0123456789abcdef01234567&utm_source=fan_acquisition/);
  assert.match(playerLink(live, { id: 'pw1', sport: 'pro-wrestling' }), /\/pro-wrestling\/play\/pw1\?ref=/);
});

test('signed events: valid signature accepted; tampering, replay windows and missing secret refused', () => {
  const secret = 's'.repeat(40); const now = Date.now(); const raw = JSON.stringify({ eventId: 'evt_000001', type: 'registration', playerRef: 'player_abc123' });
  const sign = (ts, body) => crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  assert.equal(verifySignature({ secret, rawBody: raw, timestamp: now, signature: `sha256=${sign(now, raw)}`, now }).ok, true);
  assert.equal(verifySignature({ secret, rawBody: raw + ' ', timestamp: now, signature: sign(now, raw), now }).reason, 'bad_signature');
  assert.equal(verifySignature({ secret, rawBody: raw, timestamp: now - 10 * 60000, signature: sign(now - 10 * 60000, raw), now }).reason, 'stale_or_missing_timestamp');
  assert.equal(verifySignature({ secret: '', rawBody: raw, timestamp: now, signature: 'x', now }).reason, 'ingest_not_configured');
});
