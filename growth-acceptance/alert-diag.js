'use strict';
// One-off read-only diagnostic: state of the interrupted-run alert for growth_202611010300.
// 160 = closed by auto-recovery, 161 = closed by someone else, 162 = still open (needs check), 163 = not found, 1 = error.
const { MongoClient } = require('mongodb');
(async () => {
  const c = await new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 }).connect();
  const db = c.db('fmgrowthtest');
  const a = await db.collection('growth_alerts').find({ $or: [{ id: 'growth_202611010300' }, { alertKey: /growth_202611010300/ }] }).toArray();
  const run = await db.collection('isolated_run_claims').findOne({ runId: 'growth_202611010300' });
  console.log('[alert-diag]', JSON.stringify({ alerts: a.map((x) => ({ key: x.alertKey, state: x.state, ackBy: x.ackBy, detail: x.detail })), run: run && { state: run.state } }));
  await c.close();
  if (!a.length) process.exit(163);
  if (a.some((x) => x.state === 'open')) process.exit(162);
  process.exit(a.every((x) => x.ackBy === 'auto-recovery') ? 160 : 161);
})().catch((e) => { console.error(e); process.exit(1); });
