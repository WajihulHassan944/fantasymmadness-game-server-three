'use strict';
// Unit tests: token vault, Instagram image/caption checks, Meta-connection channel gating.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createTokenVault } = require('./growth-token-vault');
const { resolveSocialConfig, createSocialPublisher, instagramImageUrl, preflight, META_BLOCKER } = require('./growth-social-publishing');
const { resolveMetaConfig } = require('./growth-meta-connect');

test('vault: AES-GCM round trip, bound to its label, refuses tampering and other keys', () => {
  const key = crypto.randomBytes(32).toString('base64');
  const v = createTokenVault(key);
  const sealed = v.seal('EAAsecret-token-value', 'meta:user');
  assert.ok(!sealed.includes('EAAsecret'));
  assert.equal(v.open(sealed, 'meta:user'), 'EAAsecret-token-value');
  assert.throws(() => v.open(sealed, 'meta:page:1'));
  const parts = sealed.split('.'); parts[4] = parts[4].slice(0, -2) + (parts[4].endsWith('A') ? 'BB' : 'AA');
  assert.throws(() => v.open(parts.join('.'), 'meta:user'));
  assert.throws(() => createTokenVault(crypto.randomBytes(32).toString('base64')).open(sealed, 'meta:user'), /different encryption key/);
  assert.equal(createTokenVault('').configured, false);
  assert.throws(() => createTokenVault('short').seal('x', 'y'), /not configured/);
});

test('Instagram images: Cloudinary posters are requested as JPEG; captions follow Instagram limits', async () => {
  assert.equal(instagramImageUrl('https://res.cloudinary.com/demo/image/upload/v1/poster.webp'), 'https://res.cloudinary.com/demo/image/upload/f_jpg,q_auto/v1/poster.webp');
  assert.equal(instagramImageUrl('https://example.com/a.jpg'), 'https://example.com/a.jpg');
  const ok = await preflight({ channel: 'instagram', text: 'A vs B #boxing', imageUrl: 'https://res.cloudinary.com/demo/image/upload/a.png' });
  assert.equal(ok.ok, true);
  const long = await preflight({ channel: 'instagram', text: 'x'.repeat(2201), imageUrl: 'https://e.com/a.jpg' });
  assert.match(long.problems.join(), /2,200/);
  const tags = await preflight({ channel: 'instagram', text: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' '), imageUrl: 'https://e.com/a.jpg' });
  assert.match(tags.problems.join(), /30 hashtags/);
  assert.match((await preflight({ channel: 'instagram', text: 'x' })).problems.join(), /requires an image/);
  const png = async () => ({ ok: true, status: 200, headers: { get: (k) => (k === 'content-type' ? 'image/png' : '1000') } });
  assert.match((await preflight({ channel: 'instagram', text: 'x', imageUrl: 'https://e.com/a.png' }, { fetchImpl: png })).problems.join(), /JPEG/);
  const missing = async () => ({ ok: false, status: 404, headers: { get: () => null } });
  assert.match((await preflight({ channel: 'facebook', text: 'x', imageUrl: 'https://e.com/a.jpg' }, { fetchImpl: missing })).problems.join(), /404/);
});

test('live Facebook/Instagram need the Meta connection (or env credentials); the gate is checked every time', async () => {
  const LIVE = { GROWTH_SOCIAL_PROVIDER: 'live', GROWTH_SOCIAL_PUBLISHING_APPROVED: 'true', GROWTH_SOCIAL_CHANNELS_ENABLED: 'facebook,instagram' };
  const social = resolveSocialConfig(LIVE);
  assert.ok(social.channels.facebook.blockers.includes(META_BLOCKER));
  assert.ok(!social.channels.facebook.blockers.some((b) => /GROWTH_FB_PAGE/.test(b)), 'asks for env tokens instead of the connection');
  let creds = null;
  const meta = { credentials: async (ch) => (creds ? (ch === 'facebook' ? { pageId: '1', token: 't'.repeat(30) } : { userId: '2', token: 't'.repeat(30) }) : null) };
  const pub = createSocialPublisher({ social, meta, fetchImpl: async () => { throw new Error('no network expected'); }, checkImages: false });
  assert.equal((await pub.channelState('facebook')).ready, false);
  const held = await pub.publish({ id: 'p', channel: 'facebook', text: 'x' });
  assert.equal(held.ok, false); assert.match(held.reason, /Connect Facebook & Instagram/);
  creds = true;
  const st = await pub.channelState('instagram');
  assert.equal(st.ready, true); assert.equal(st.mode, 'live');
  // without approval or allowlist the connection alone never enables live posting
  const noApproval = createSocialPublisher({ social: resolveSocialConfig({ ...LIVE, GROWTH_SOCIAL_PUBLISHING_APPROVED: '' }), meta, checkImages: false });
  assert.equal((await noApproval.channelState('facebook')).ready, false);
});

test('Meta config: only the real Meta hosts or loopback test doubles; live test off unless owner sets it', () => {
  const c = resolveMetaConfig({ GROWTH_META_GRAPH_BASE: 'https://evil.example', GROWTH_META_DIALOG_BASE: 'http://127.0.0.1:4555' });
  assert.equal(c.graphBase, 'https://graph.facebook.com'); assert.equal(c.dialogBase, 'http://127.0.0.1:4555');
  assert.equal(c.liveTestApproved, false); assert.equal(resolveMetaConfig({ GROWTH_SOCIAL_LIVE_TEST_APPROVED: 'true' }).liveTestApproved, true);
  assert.equal(c.redirectUri, 'https://fantasymmadness-growth-isolated-tes.vercel.app/api/growth/meta/callback');
});
