'use strict';
const crypto = require('node:crypto');
const fields = ['kind', 'subject', 'headline', 'text', 'html', 'posts', 'recipient', 'contest', 'contestId', 'contestFingerprint', 'poster', 'approvalBlockers', 'reviewSafety', 'contactSource', 'consentBasis', 'signupUrl', 'personalization'];
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function contentVersion(draft) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(Object.fromEntries(fields.map(key => [key, draft[key] ?? null]))))).digest('hex');
}
function createProductionReview({ col, quality, clock = () => new Date() }) {
  async function decide(id, { action, owner, version, reason = '' } = {}) {
    if (!['approve', 'reject'].includes(action) || !/^[a-f0-9]{24}$/.test(owner || '') || !/^[a-f0-9]{64}$/.test(version || '')) return { ok: false, reason: 'explicit_owner_and_content_version_required' };
    const draft = await col.drafts.findOne({ id });
    if (!draft || !['needs_owner_review', 'approved'].includes(draft.status)) return { ok: false, reason: 'draft_not_awaiting_owner_decision' };
    if (contentVersion(draft) !== version) return { ok: false, reason: 'campaign_changed_review_again' };
    if (action === 'approve') {
      const blockers = [...await quality(draft, clock()), ...(draft.reviewSafety?.state === 'hold' ? draft.reviewSafety.reasons || ['review_safety_hold'] : [])];
      if (draft.kind === 'affiliate') blockers.push('current_recipient_suitability_requires_owner_verification');
      if (blockers.length) return { ok: false, reason: 'campaign_evidence_required', blockers: [...new Set(blockers)] };
    }
    const filter = { id, status: draft.status };
    for (const field of fields) filter[field] = draft[field] === undefined ? { $exists: false } : { $eq: draft[field] };
    const at = clock().toISOString();
    const decision = { action, owner, version, at, reason: String(reason).replace(/[\x00-\x1f]/g, ' ').slice(0, 300), deliveryAuthorized: false };
    const result = await col.drafts.updateOne(filter, {
      $set: { status: action === 'approve' ? 'approved' : 'rejected', ownerApproved: action === 'approve', sendPermitted: false, contentApproval: decision },
      $push: { ownerReviewHistory: decision },
    });
    if (!result.modifiedCount) return { ok: false, reason: 'campaign_changed_review_again' };
    return { ok: true, id, status: action === 'approve' ? 'approved' : 'rejected', version, contentApproved: action === 'approve', deliveryAuthorized: false };
  }
  return { decide };
}
module.exports = { contentVersion, createProductionReview };
