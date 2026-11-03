'use strict';
// Unattended isolated scheduler process for acceptance check 6.
// Runs on a real timer with no operator input. Each timer tick represents one
// scheduled cron minute (virtual clock so a short test covers many minutes)
// and is invoked TWICE, like a cron runner that fires duplicates; run claims
// must make the duplicate a no-op. Jobs with retry/backoff run through the
// persistent store. Exhausted jobs and failed runs raise sandbox owner alerts.
const { MongoClient } = require('mongodb');
const nodemailer = require('nodemailer');
const { createIsolatedRunClaims } = require('../growth-isolated-run-claims');
const { createIsolatedWorkstreamScheduler } = require('../growth-workstream-scheduler');
const { createDraftAdapters } = require('../growth-workstream-draft-adapters');
const { createStore } = require('../growth-unattended-store');
const { createFailureAlerts } = require('../growth-failure-alerts');

const uri = process.env.GROWTH_TEST_MONGO_URI;
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):27017/.test(uri || '')) throw new Error('Loopback test database required');
if (process.env.GROWTH_STAGING_MODE !== 'isolated' || process.env.GROWTH_OUTBOUND_ENABLED !== 'false') throw new Error('Isolated mode required');
const BASE = Date.parse(process.env.WORKER_BASE_TIME || '2026-11-01T12:00:00Z');
const INTERVAL = Number(process.env.WORKER_INTERVAL_MS || 1500);
const MAX_TICKS = Number(process.env.WORKER_MAX_TICKS || 30);

(async () => {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db('fmgrowthtest');
  const state = db.collection('worker_state');
  const transport = nodemailer.createTransport({ host: '127.0.0.1', port: 1025, secure: false, ignoreTLS: true });
  const claims = createIsolatedRunClaims(db.collection('isolated_run_claims'), { testMode: true });
  const store = createStore(db.collection('unattended_jobs'), { testMode: true });
  const alerts = createFailureAlerts({ collection: db.collection('growth_alerts'), transport, testMode: true });
  await claims.init(); await store.init(); await alerts.init();
  // Resume where a previous (killed) process stopped.
  const saved = await state.findOne({ _id: 'cursor' });
  let tick = saved ? saved.nextTick : 0;
  const pid = process.pid;
  await state.updateOne({ _id: 'starts' }, { $push: { starts: { pid, tick, at: new Date().toISOString() } } }, { upsert: true });
  // Adapter behaviour per job: 'flaky' fails twice then succeeds; 'broken' always fails.
  const attemptsSeen = {};
  async function runJob(job) {
    attemptsSeen[job.id] = (attemptsSeen[job.id] || 0) + 1;
    if (job.payload.mode === 'broken') throw new Error('provider unavailable (synthetic)');
    if (job.payload.mode === 'flaky' && job.attempts < 3) throw new Error('transient error (synthetic)');
    return { ok: true };
  }
  async function scheduledMinute(t) {
    const now = new Date(BASE + t * 60_000);
    const runId = 'growth_' + now.toISOString().replace(/[^0-9]/g, '').slice(0, 12);
    const outcomes = [];
    for (const invocation of [1, 2]) { // duplicate cron invocation
      if (!await claims.claim(runId)) { outcomes.push('duplicate_skipped'); continue; }
      const scheduler = createIsolatedWorkstreamScheduler({ collection: db.collection('isolated_workstream_runs'), testMode: true, adapters: createDraftAdapters(), clock: () => now });
      const result = await scheduler.tick();
      await claims.complete(runId, result);
      const sent = await alerts.notify(alerts.fromRun(runId, result), { now });
      outcomes.push(`ran:${result.completed}`);
      if (sent.sent.length) outcomes.push(`alerts:${sent.sent.length}`);
    }
    // Retry queue: claim due jobs at this virtual time; backoff decides when they are due again.
    // Jobs left running by a killed process are reclaimed after their lease expires.
    for (let i = 0; i < 5; i++) {
      const job = await store.claim(now.getTime());
      if (!job) break;
      try { await runJob(job); await store.finish(job, { success: true, now: now.getTime() }); }
      catch (error) { await store.finish(job, { success: false, error: error.message, now: now.getTime() }); }
    }
    const failedJobs = await db.collection('unattended_jobs').find({ state: 'failed' }).toArray();
    await alerts.notify(alerts.fromJobs(failedJobs), { now });
    await state.updateOne({ _id: 'log' }, { $push: { entries: { tick: t, runId, outcomes, pid, at: new Date().toISOString() } } }, { upsert: true });
  }
  const timer = setInterval(async () => {
    if (tick >= MAX_TICKS) { clearInterval(timer); await state.updateOne({ _id: 'cursor' }, { $set: { done: true } }, { upsert: true }); await client.close(); process.exit(0); }
    const t = tick;
    tick += 1;
    // Cursor first: a crash after this point leaves the minute claimed-but-unfinished,
    // which the run-claim design reports for operator inspection (never auto-repeats).
    await state.updateOne({ _id: 'cursor' }, { $set: { nextTick: tick, pid } }, { upsert: true });
    try { await scheduledMinute(t); } catch (error) { console.error('tick failed', t, error.message); }
  }, INTERVAL);
})().catch((error) => { console.error('worker failed:', error.message); process.exit(1); });
