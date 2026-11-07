'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { MongoClient } = require('mongodb');
const { contentVersion, createProductionReview } = require('./growth-production-review');
const uri = process.env.GROWTH_TEST_MONGO_URI;
const skip = !/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri || '');
test('content decisions require owner evidence, reject stale content and never authorize delivery', { skip }, async () => {
  const client = await new MongoClient(uri).connect();
  const collection = client.db('growth_review_local').collection('reviews_' + crypto.randomBytes(8).toString('hex'));
  const owner = 'a'.repeat(24), col = { drafts: collection };
  let blockers = [], race = false;
  const review = createProductionReview({ col, quality: async d => { if (race) await collection.updateOne({ id: d.id }, { $set: { text: 'changed while assessing' } }); return blockers; } });
  try {
    const draft = { id: 'review-fixture', kind: 'pr', status: 'needs_owner_review', subject: 'Fixture only', text: 'Fixture only', recipient: 'fixture@example.invalid', ownerApproved: false, sendPermitted: false };
    await collection.insertOne(draft);
    assert.equal((await review.decide(draft.id, { action: 'approve', owner })).ok, false);
    const version = contentVersion(draft);
    assert.equal((await review.decide(draft.id, { action: 'approve', owner, version: 'b'.repeat(64) })).reason, 'campaign_changed_review_again');
    blockers = ['recipient_suppressed'];
    assert.equal((await review.decide(draft.id, { action: 'approve', owner, version })).reason, 'campaign_evidence_required');
    assert.equal((await collection.findOne({ id: draft.id })).status, 'needs_owner_review');
    blockers = []; race = true;
    assert.equal((await review.decide(draft.id, { action: 'approve', owner, version })).reason, 'campaign_changed_review_again');
    race = false;
    const current = await collection.findOne({ id: draft.id });
    const result = await review.decide(draft.id, { action: 'approve', owner, version: contentVersion(current) });
    assert.equal(result.ok, true); assert.equal(result.deliveryAuthorized, false);
    const stored = await collection.findOne({ id: draft.id });
    assert.equal(stored.ownerApproved, true); assert.equal(stored.sendPermitted, false);
    assert.equal(stored.ownerReviewHistory.length, 1); assert.equal(stored.ownerReviewHistory[0].owner, owner);
    const reject = await review.decide(draft.id, { action: 'reject', owner, version: contentVersion(stored), reason: 'Owner withdrawal' });
    assert.equal(reject.ok, true);
    assert.equal((await collection.findOne({ id: draft.id })).ownerReviewHistory.length, 2);
  } finally { await collection.drop(); await client.close(); }
});
