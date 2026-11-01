'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveGrowthRuntimeConfig, ISOLATED_PROJECT_ID } = require('./growth-runtime-config');
const { createDeliveryProvider } = require('./growth-delivery-provider');
const { createSuppression } = require('./growth-suppression');

const secret = 'x'.repeat(40);
const vercelBase = { VERCEL: '1', VERCEL_PROJECT_ID: ISOLATED_PROJECT_ID, GROWTH_STAGING_MODE: 'isolated', GROWTH_OUTBOUND_ENABLED: 'false', MONGODB_URI: 'mongodb+srv://u:p@cluster0.abcde.mongodb.net/?retryWrites=true', CRON_SECRET: 'c'.repeat(32), JWT_SECRET_ADMIN: secret, GROWTH_UNSUBSCRIBE_SECRET: secret };

test('isolated Vercel project with Atlas URI is accepted; secrets are not in config', () => {
  const r = resolveGrowthRuntimeConfig(vercelBase);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.config.database.name, 'fmgrowthtest');
  assert.equal(JSON.stringify(r.config).includes('u:p@'), false);
  assert.equal(r.config.delivery.provider, 'none');
  assert.equal(r.config.database.host, 'cluster0.abcde.mongodb.net');
  assert.equal(r.config.database.hostPinned, false);
});
test('refuses any other Vercel project (production backend stays inert)', () => {
  const r = resolveGrowthRuntimeConfig({ ...vercelBase, VERCEL_PROJECT_ID: 'prj_vjqJrHyYFrs0GW57b3KWMpeU6ykS' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /only runs in the isolated Vercel project/);
});
test('reports each missing staging secret precisely', () => {
  const r = resolveGrowthRuntimeConfig({ ...vercelBase, CRON_SECRET: '', GROWTH_UNSUBSCRIBE_SECRET: '' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /CRON_SECRET/);
  assert.match(r.errors.join(), /GROWTH_UNSUBSCRIBE_SECRET/);
});
test('pins the Atlas host when attested', () => {
  assert.equal(resolveGrowthRuntimeConfig({ ...vercelBase, GROWTH_TEST_ATLAS_HOST: 'cluster0.abcde.mongodb.net' }).ok, true);
  assert.equal(resolveGrowthRuntimeConfig({ ...vercelBase, GROWTH_TEST_ATLAS_HOST: 'prod.zzzzz.mongodb.net' }).ok, false);
});
test('outside Vercel only loopback test databases are allowed', () => {
  assert.equal(resolveGrowthRuntimeConfig({ GROWTH_STAGING_MODE: 'isolated', GROWTH_TEST_MONGO_URI: 'mongodb://127.0.0.1:27017', JWT_SECRET_ADMIN: secret }).ok, true);
  assert.equal(resolveGrowthRuntimeConfig({ GROWTH_STAGING_MODE: 'isolated', GROWTH_TEST_MONGO_URI: 'mongodb+srv://x@prod.mongodb.net/db', JWT_SECRET_ADMIN: secret }).ok, false);
});
test('real delivery stays locked until every approval flag and credential is present', () => {
  const partial = resolveGrowthRuntimeConfig({ ...vercelBase, GROWTH_DELIVERY_PROVIDER: 'resend', GROWTH_RESEND_API_KEY: 're_x' });
  assert.equal(partial.config.delivery.realDelivery, false);
  assert.ok(partial.config.delivery.blockers.length >= 4);
  assert.throws(() => createDeliveryProvider({ config: partial.config, secrets: partial.secrets }), /not authorized/);
  const outboundWithoutApproval = resolveGrowthRuntimeConfig({ ...vercelBase, GROWTH_OUTBOUND_ENABLED: 'true' });
  assert.equal(outboundWithoutApproval.ok, false);
});
test('fully authorized Resend provider sends one approved draft with unsubscribe headers', async () => {
  const env = { ...vercelBase, GROWTH_DELIVERY_PROVIDER: 'resend', GROWTH_OUTBOUND_ENABLED: 'true', GROWTH_REAL_OUTREACH_APPROVED: 'true', GROWTH_SENDER_ADDRESS: 'contact@fantasymmadnesscom.com', GROWTH_SENDER_DOMAIN_VERIFIED: 'true', GROWTH_RESEND_API_KEY: 're_test', GROWTH_UNSUBSCRIBE_BASE_URL: 'https://example.vercel.app/api/growth/unsubscribe' };
  const r = resolveGrowthRuntimeConfig(env);
  assert.equal(r.ok, true, r.errors.join('; '));
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ id: 'resend-123' }) }; };
  const p = createDeliveryProvider({ config: r.config, secrets: r.secrets, fetchImpl });
  const draft = { id: 'pr-1', status: 'approved', ownerApproved: true, sendPermitted: true, recipient: 'editor@example.com', subject: 'Hi', text: 't', html: '<p>t</p>', listUnsubscribe: 'https://example.vercel.app/api/growth/unsubscribe?token=a' };
  assert.deepEqual((await p.send(draft)).receipt, { providerMessageId: 'resend-123', sandbox: false, realDelivery: true });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.from, 'FANTASY MMADNESS <contact@fantasymmadnesscom.com>');
  assert.match(body.headers['List-Unsubscribe'], /unsubscribe\?token=a/);
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'growth-pr-1');
  assert.equal((await p.send({ ...draft, ownerApproved: false })).reason, 'owner_approval_required');
  assert.equal((await p.send({ ...draft, listUnsubscribe: '' })).reason, 'unsubscribe_link_required');
  assert.equal(calls.length, 1);
});
test('unsubscribe tokens are signed; tampering is rejected', async () => {
  const rows = new Map();
  const collection = { createIndex: async () => {}, updateOne: async (f, u) => { if (!rows.has(f.address)) rows.set(f.address, u.$setOnInsert); return {}; }, findOne: async (f) => rows.get(f.address) || null };
  const s = createSuppression(collection, { secret, testMode: true });
  const token = s.token('Editor@Example.com');
  const forged = Buffer.from('other@example.com').toString('base64url') + '.' + token.split('.')[1];
  assert.equal((await s.unsubscribe(forged)).ok, false);
  assert.equal((await s.unsubscribe(token)).ok, true);
  assert.equal(await s.isSuppressed('editor@example.com'), true);
  assert.equal(await s.isSuppressed('other@example.com'), false);
});
