'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MongoClient } = require('mongodb');
const { createGrowthRuntime } = require('./growth-runtime');
const { resolveGrowthRuntimeConfig } = require('./growth-runtime-config');
const { contestFeed } = require('./growth-contest-feed.fixture');
const uri = process.env.GROWTH_TEST_MONGO_URI;

test('registry refresh retains campaigns on partial outage, deduplicates retries and replaces changed facts', { skip: !/^mongodb:\/\/(127\.0\.0\.1|localhost)/.test(uri || '') }, async () => {
  const client = await new MongoClient(uri).connect();
  const now = new Date(); const feed = contestFeed(() => now.getTime());
  let partial = false; let changed = false; let expiredId = null;
  const resolved = resolveGrowthRuntimeConfig({ GROWTH_STAGING_MODE: 'isolated', GROWTH_TEST_MONGO_URI: uri, JWT_SECRET_ADMIN: 'test-secret-'.repeat(5), GROWTH_FIGHT_URL_DISCOVERY: 'off' });
  const fetchImpl = async (url) => {
    if (partial && url.includes('pro-wrestling')) return { ok: false, status: 503 };
    const r = feed(url); assert.ok(r, 'only designated read-only registry feeds may be fetched');
    const j = await r.json();
    if (changed && url.includes('prediction-fights')) j.items[0].venue = 'Updated Registry Arena';
    if(expiredId&&url.includes('prediction-fights'))for(const item of j.items)if(item._id===expiredId){item.matchDateKey='2020-01-01';item.matchDate='2020-01-01T12:00:00Z';}
    return { ok: true, status: 200, json: async () => j };
  };
  const db = client.db('fmgrowthtest');
  try {
    await db.dropDatabase();
    const rt = createGrowthRuntime({ db, config: resolved.config, provider: { send: async () => { throw Error('outbound forbidden'); } }, fetchImpl });
    await rt.init();
    const first = await rt.refreshMarketing(now); assert.equal(first.created, 10);
    const repeated = await rt.refreshMarketing(now); assert.equal(repeated.created, 0);
    partial = true;
    const outage = await rt.refreshMarketing(now); assert.equal(outage.withdrawn, 0);
    assert.equal(await rt.collections.drafts.countDocuments({ kind: 'marketing', status: 'needs_owner_review' }), 10);
    const coverage = await rt.collections.coverage.findOne({}); assert.equal(coverage.complete, false); assert.equal(coverage.sourceErrors.length, 1);
    partial = false; changed = true;
    const update = await rt.refreshMarketing(now); assert.equal(update.created, 1); assert.equal(update.withdrawn, 1);
    assert.equal(await rt.collections.drafts.countDocuments({ kind: 'marketing', status: 'needs_owner_review' }), 10);
    assert.equal(await rt.collections.drafts.countDocuments({ ownerApproved: true }), 0);
    const chosen=await rt.collections.drafts.findOne({kind:'marketing',genre:'boxing',status:'needs_owner_review'});
    const version=require('./growth-production-review').contentVersion(chosen);
    await rt.collections.drafts.updateOne({id:chosen.id},{$set:{status:'approved',ownerApproved:true,contentApproval:{action:'approve',version,owner:'a'.repeat(24)},ownerReviewHistory:[{action:'approve',version}]}});
    expiredId=chosen.contestId;
    await rt.refreshMarketing(now);
    const held=await rt.collections.drafts.findOne({id:chosen.id});
    assert.equal(held.status,'approved');assert.equal(held.ownerApproved,true);assert.equal(held.marketingEligibility.state,'held');assert.ok(held.marketingEligibility.reasons.includes('event_date_in_past'));assert.equal(held.sendPermitted,false);
    assert.equal(require('./growth-production-review').contentVersion(held),version);
    assert.equal(held.ownerReviewHistory.length,1);
    assert.ok((await rt.preparation.quality(held,now)).includes('event_date_in_past'));

  } finally { await db.dropDatabase(); await client.close(); }
});
