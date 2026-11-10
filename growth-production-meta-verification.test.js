'use strict';
// Facebook & Instagram verification in production: the live provider check decides, not the
// isolated OAuth maintenance snapshot (which caused connection_verification_stale).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { applyMetaVerification } = require('./growth-production-meta-verification');
const { productionChannelStatus } = require('./growth-production-channel-status');
const { createProductionMetaProvider } = require('./growth-production-meta-provider');
const { createTokenVault } = require('./growth-token-vault');

const NOW = Date.parse('2026-11-10T16:00:00Z');
// what production showed: maintenance snapshot older than 35 minutes
const staleSnapshot = () => ({ source: 'existing_authorized_connection_service', checkedAt: '2026-11-08T10:00:00Z', verificationStale: true,
  metaPermissions: { verified: false, reason: 'connection_verification_stale' },
  meta: { facebook: { verified: false, state: 'verification-needed', reason: 'connection_verification_stale' }, instagram: { verified: false, state: 'verification-needed', reason: 'connection_verification_stale' } },
  oauth: [{ provider: 'tiktok', status: 'verification-needed', accessStatus: 'unknown', grantedScopes: [] }, { provider: 'x', status: 'verification-needed', accessStatus: 'unknown', grantedScopes: [] }] });
const live = (over = {}) => ({ checkedAt: new Date(NOW - 60000).toISOString(), selected: { pageId: '128043637053328', igUserId: '17841447949460050' },
  facebook: { verified: true, id: '128043637053328', name: 'Fantasy MMAdness' }, instagram: { verified: true, id: '17841447949460050', username: 'fantasymmadness' },
  permissions: { verified: true, granted: ['pages_show_list', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish'] }, ...over });

test('root cause: a stale OAuth maintenance snapshot no longer marks a live-verified Facebook/Instagram as stale', () => {
  const before = productionChannelStatus(staleSnapshot());
  assert.equal(before.facebook.connectionStatus, 'verification-needed'); // the reported problem
  const fixed = applyMetaVerification(staleSnapshot(), live(), NOW);
  const ch = productionChannelStatus(fixed);
  for (const name of ['facebook', 'instagram']) {
    assert.equal(ch[name].connected, true, name);
    assert.equal(ch[name].connectionStatus, 'connected');
    assert.equal(ch[name].publishingScopesVerified, true);
    assert.deepEqual(ch[name].missingPublishingScopes, []);
    assert.equal(ch[name].publishingAuthorized, false, 'verification never authorizes publishing');
    assert.equal(ch[name].ready, false);
  }
  // TikTok and X keep their own (stale) maintenance status: no false "connected"
  assert.equal(ch.tiktok.connected, false); assert.equal(ch.x.connected, false);
  assert.equal(fixed.verificationStale, true);
  assert.equal(fixed.metaIdentity.platforms.facebook.name, 'Fantasy MMAdness');
  assert.equal(fixed.metaIdentity.platforms.instagram.username, 'fantasymmadness');
  assert.equal(fixed.metaSource, 'production_provider_live_check');
});

test('real problems still show: revoked token, wrong identity, missing scope, failed or old check', () => {
  const revoked = productionChannelStatus(applyMetaVerification(staleSnapshot(), live({ facebook: { verified: false, state: 'revoked', reason: 'existing_authorization_expired_or_revoked' } }), NOW));
  assert.equal(revoked.facebook.connected, false); assert.equal(revoked.facebook.connectionStatus, 'revoked'); assert.equal(revoked.instagram.connected, true);
  const scope = applyMetaVerification(staleSnapshot(), live({ permissions: { verified: true, granted: ['pages_manage_posts'] } }), NOW);
  assert.deepEqual(productionChannelStatus(scope).instagram.missingPublishingScopes, ['instagram_content_publish']);
  assert.equal(scope.metaIdentity.platforms.instagram.publishingScopeGranted, false);
  const noPerm = productionChannelStatus(applyMetaVerification(staleSnapshot(), live({ permissions: { verified: false, reason: 'provider_rate_limited' } }), NOW));
  assert.equal(noPerm.facebook.connected, true); assert.equal(noPerm.facebook.publishingScopesVerified, false);
  for (const v of [null, live({ checkedAt: new Date(NOW - 36 * 60000).toISOString() }), live({ checkedAt: 'garbage' })]) {
    const out = applyMetaVerification(staleSnapshot(), v, NOW);
    assert.equal(out.metaVerificationStale, true);
    assert.equal(productionChannelStatus(out).facebook.connected, false);
  }
});

function providerFixture({ grants = ['pages_manage_posts', 'instagram_content_publish'], revoked = false } = {}) {
  const key = crypto.randomBytes(32).toString('base64'), vault = createTokenVault(key), page = '128043637053328', ig = '17841447949460050';
  const pageToken = 'private-page-token-' + crypto.randomBytes(6).toString('hex'), userToken = 'private-user-token-' + crypto.randomBytes(6).toString('hex');
  const record = { key: 'meta', selected: { pageId: page, igUserId: ig }, pages: [{ id: page, tokenSealed: vault.seal(pageToken, 'meta:page:' + page) }], userTokenSealed: vault.seal(userToken, 'meta:user') };
  const writes = []; const calls = [];
  const db = { databaseName: 'fmgrowthtest', collection: (name) => ({ findOne: async () => (name === 'growth_connections' ? record : null), updateOne: async (q, u) => { writes.push(name); return {}; } }) };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' }); const u = new URL(url); let data;
    if (revoked) return { ok: false, status: 400, json: async () => ({ error: { code: 190, error_subcode: 460 } }) };
    if (u.pathname.endsWith('/me/permissions')) data = { data: grants.map((permission) => ({ permission, status: 'granted' })) };
    else if (u.pathname.endsWith('/me')) data = { id: page, name: 'Fantasy MMAdness' };
    else if (u.pathname.endsWith('/' + ig)) data = { id: ig, username: 'fantasymmadness' };
    else if (u.pathname.endsWith('/' + page)) data = { instagram_business_account: { id: ig } };
    return { ok: true, status: 200, json: async () => data };
  };
  return { calls, writes, record, pageToken, userToken, provider: createProductionMetaProvider({ withSource: async (fn) => fn(db), env: { GROWTH_TOKEN_ENCRYPTION_KEY: key }, fetchImpl }) };
}

test('provider verify(): read-only (GET only), no credential exposure or change, cached unless forced', async () => {
  const f = providerFixture();
  const sealedBefore = JSON.stringify(f.record);
  const v = await f.provider.verify({ force: true });
  assert.equal(v.facebook.verified, true); assert.equal(v.instagram.verified, true); assert.equal(v.permissions.verified, true);
  assert.equal(v.facebook.id, '128043637053328'); assert.equal(v.instagram.username, 'fantasymmadness');
  assert.ok(f.calls.length > 0 && f.calls.every((c) => c.method === 'GET'), 'only read requests to the provider');
  assert.equal(JSON.stringify(f.record), sealedBefore, 'stored credentials unchanged');
  assert.doesNotMatch(JSON.stringify(v), new RegExp(f.pageToken + '|' + f.userToken + '|tokenSealed'));
  const n = f.calls.length;
  await f.provider.verify(); assert.equal(f.calls.length, n, 'served from the 5-minute cache');
  await f.provider.verify({ force: true }); assert.ok(f.calls.length > n, 'forced check asks the provider again');
  const r = await providerFixture({ revoked: true }).provider.verify({ force: true });
  assert.equal(r.facebook.verified, false); assert.equal(r.facebook.reason, 'existing_authorization_expired_or_revoked');
  assert.equal(r.permissions.verified, false);
});

test('owner-only manual verification: audited, read-only, unavailable without a verifier', async () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('./growth-production-preparation'), 'utf8');
  assert.match(src, /route==='meta\/check'/);
  assert.match(src, /if\(!owners\.includes\(owner\)\)return\{ok:false,reason:'verified_production_owner_required'\}/, 'owner check precedes every owner action');
  const http = fs.readFileSync(require.resolve('./growth-production-preparation-http'), 'utf8');
  assert.match(http, /suppressions\|meta\\\/check\)\$\/,auth,/, 'route is behind the owner session guard');
  const consoleJs = fs.readFileSync(require.resolve('./growth-production-console/app.js'), 'utf8');
  const rule = /\/approve\|publish[^/]*\/i/.exec(consoleJs)[0];
  assert.doesNotMatch(rule, /verify existing/, 'the owner verify button is no longer blanket-disabled');
  assert.match(rule, /publish/); assert.match(rule, /connect\|disconnect/); assert.match(rule, /refresh\.\*token/);
});
