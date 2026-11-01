'use strict';
// Opt-in persistence adapter for isolated testing. No scheduler, outbound I/O, or production registration.
// Pass an explicitly provisioned TEST database collection; never use production collections.
const { randomUUID } = require('node:crypto');
const { makeJob, settle } = require('./growth-unattended-controller');
const LEASE_MS = 120000;
function createStore(collection, { testMode = false } = {}) {
  if (!testMode || !collection || typeof collection.findOneAndUpdate !== 'function') {
    throw new Error('An explicitly authorized isolated test collection is required');
  }
  async function init() {
    await collection.createIndex({ id: 1 }, { unique: true });
    await collection.createIndex({ state: 1, dueAt: 1, leaseUntil: 1 });
  }
  async function enqueue(input) {
    const job = makeJob(input);
    await collection.updateOne({ id: job.id }, { $setOnInsert: { ...job, createdAt: new Date().toISOString() } }, { upsert: true });
    return collection.findOne({ id: job.id });
  }
  async function claim(now = Date.now()) {
    const token = randomUUID();
    const claimed = await collection.findOneAndUpdate(
      { $or: [
        { state: { $in: ['pending','retry'] }, dueAt: { $lte: new Date(now).toISOString() } },
        { state: 'running', leaseUntil: { $lte: new Date(now).toISOString() } }
      ], attempts: { $lt: 3 } },
      { $set: { state: 'running', leaseToken: token, leaseUntil: new Date(now + LEASE_MS).toISOString(), startedAt: new Date(now).toISOString() },
        $inc: { attempts: 1 } },
      { sort: { dueAt: 1 }, returnDocument: 'after' }
    );
    return claimed || null;
  }
  async function finish(job, { success, error = '', now = Date.now() }) {
    if (!job?.id || !job.leaseToken) throw new Error('Missing lease token');
    const result = settle(job, { success, error, now });
    const { _id, leaseToken, leaseUntil, ...fields } = result;
    const updated = await collection.updateOne(
      { id: job.id, state: 'running', leaseToken: job.leaseToken, leaseUntil: { $gt: new Date(now).toISOString() } },
      { $set: { ...fields, leaseToken: null, leaseUntil: null, updatedAt: new Date(now).toISOString() } }
    );
    if (updated.modifiedCount !== 1) throw new Error('Lease expired or claimed by another worker');
    return result;
  }
  async function summary() {
    const rows = await collection.aggregate([{ $group: { _id: '$state', count: { $sum: 1 } } }]).toArray();
    return Object.fromEntries(rows.map(r => [r._id, r.count]));
  }
  return { init, enqueue, claim, finish, summary };
}
module.exports = { createStore, LEASE_MS };
