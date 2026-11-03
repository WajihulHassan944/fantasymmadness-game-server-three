'use strict';
// Real MongoDB integration test. Only accepts an explicitly local CI MongoDB URL.
// Uses a fresh database, never the production DB or payment collections.
const assert = require('node:assert/strict');
const { MongoClient } = require('mongodb');
const { randomUUID } = require('node:crypto');
const { createStore, LEASE_MS } = require('./growth-unattended-store');
(async () => {
 const uri = process.env.GROWTH_TEST_MONGO_URI;
 if (!uri || !/^mongodb:\/\/(?:127\.0\.0\.1|localhost):27017(?:\/|\?|$)/.test(uri)) {
  throw new Error('Dedicated local test MongoDB is required; refusing remote/production URI');
 }
 const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
 const dbName = 'growth_isolated_ci_' + randomUUID().replace(/-/g, '');
 const now = Date.parse('2026-11-01T12:00:00Z');
 try {
  await client.connect();
  const col = client.db(dbName).collection('test_jobs');
  const store = createStore(col, { testMode: true });
  await store.init();
  const job = { id: 'affiliate:synthetic-001', type: 'prepare_followup', dueAt: new Date(now).toISOString() };
  await Promise.all([store.enqueue(job), store.enqueue(job)]);
  assert.equal(await col.countDocuments({}), 1, 'idempotent insert across concurrent enqueues');
  const claims = await Promise.all([store.claim(now), store.claim(now)]);
  assert.equal(claims.filter(Boolean).length, 1, 'only one worker claims the task');
  const first = claims.find(Boolean);
  assert.equal(first.attempts, 1);
  // A worker disappears. Reopen through a fresh store instance to simulate restart.
  const restarted = createStore(col, { testMode: true });
  assert.equal(await restarted.claim(now + LEASE_MS - 1), null);
  const recovered = await restarted.claim(now + LEASE_MS);
  assert.equal(recovered.attempts, 2, 'expired lease recovered after restart');
  await assert.rejects(() => store.finish(first, { success: true, now: now + LEASE_MS + 1 }), /Lease expired/);
  await restarted.finish(recovered, { success: true, now: now + LEASE_MS + 1 });
  assert.equal((await col.findOne({ id: job.id })).state, 'completed');
  assert.deepEqual(await restarted.summary(), { completed: 1 });
  console.log('PASS real isolated MongoDB: concurrent enqueue, atomic claims, restart recovery, stale worker fencing, completion');
 } finally {
  try { await client.db(dbName).dropDatabase(); } finally { await client.close(); }
 }
})().catch(e => { console.error(e); process.exitCode = 1; });
