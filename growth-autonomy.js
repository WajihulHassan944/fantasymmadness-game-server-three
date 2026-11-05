'use strict';
// Durable owner policy over the EXISTING runtime/approval/publishing pipeline.
const { GENRES } = require('./growth-ten-agent-discovery');
const DEPARTMENTS = ['marketing', 'pr', 'affiliate'];
const CHANNELS = ['facebook', 'instagram', 'tiktok', 'x'];
const defaults = () => ({ enabled: false, paused: false, mode: 'sandbox', departments: DEPARTMENTS, channels: CHANNELS, genres: [...GENRES], maxCampaignsPerDepartmentPerDay: 10, allowPublishedBusinessContacts: false, approvedRecipients: [], affiliateIds: [], version: 0 });
const error = (message, status = 422) => Object.assign(new Error(message), { status });
function validatePolicy(input, { liveApproved = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('An automation policy is required');
  if (typeof input.enabled !== 'boolean' || typeof input.paused !== 'boolean') throw error('Explicit enabled/paused controls are required');
  if (!['sandbox', 'approved-delivery'].includes(input.mode)) throw error('Choose sandbox or approved-delivery mode');
  if (input.mode !== 'sandbox' && !liveApproved) throw error('Live autonomous delivery requires separate owner authorization and provider verification', 403);
  const choose = (name, allowed) => { const x = input[name]; if (!Array.isArray(x) || !x.length || x.some(v => !allowed.includes(v))) throw error(`Invalid ${name}`); return [...new Set(x)]; };
  const max = input.maxCampaignsPerDepartmentPerDay;
  if (!Number.isInteger(max) || max < 1 || max > 100) throw error('Daily campaign limit must be between 1 and 100');
  const approvedRecipients = input.approvedRecipients || [];
  if (!Array.isArray(approvedRecipients) || approvedRecipients.length > 1000 || approvedRecipients.some(x => typeof x !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))) throw error('Approved recipients must be explicit email addresses');
  const affiliateIds = input.affiliateIds || [];
  if (!Array.isArray(affiliateIds) || affiliateIds.length > 10 || affiliateIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(id))) throw error('Choose at most ten explicit Growth affiliate IDs');
  return { affiliateIds: [...new Set(affiliateIds)], enabled: input.enabled, paused: input.paused, mode: input.mode, departments: choose('departments', DEPARTMENTS), channels: choose('channels', CHANNELS), genres: choose('genres', GENRES), maxCampaignsPerDepartmentPerDay: max, allowPublishedBusinessContacts: input.allowPublishedBusinessContacts === true, approvedRecipients: [...new Set(approvedRecipients.map(x => x.toLowerCase()))] };
}
function createAutonomy({ col, config, approveDraft, social, suppression, audit, clock = () => new Date() }) {
  async function policy() { return { ...defaults(), ...(await col.settings.findOne({ _id: 'autonomy:policy' }) || {}) }; }
  async function save(input, { actor, expectedVersion }) {
    if (!actor || actor === 'admin') throw error('An identified owner must approve the policy', 403);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw error('Expected policy version is required');
    const next = validatePolicy(input, { liveApproved: config.autonomy?.liveApproved === true });
    if (next.mode === 'approved-delivery') {
      if (next.departments.includes('marketing') && (config.social.provider !== 'live' || !config.social.approved)) throw error('Marketing requires its own authorized publishing provider');
      if (next.departments.some(k => k === 'pr' || k === 'affiliate') && !config.delivery.realDelivery) throw error('The selected outreach department requires its own authorized delivery provider');
    }
    for (const id of next.affiliateIds) { const a = await col.affiliates.findOne({ id }); if (!a || a.status !== 'active' || !/^[a-f0-9]{24}$/.test(String(a.liveAffiliateId || ''))) throw error('A selected affiliate is not active with a verified live account. No owner fallback is permitted.'); }
    await col.settings.updateOne({ _id: 'autonomy:policy' }, { $setOnInsert: { ...defaults() } }, { upsert: true });
    const saved = await col.settings.findOneAndUpdate({ _id: 'autonomy:policy', version: expectedVersion }, { $set: { ...next, approvedBy: actor, approvedAt: clock().toISOString() }, $inc: { version: 1 } }, { returnDocument: 'after' });
    if (!saved) throw error('The policy changed. Reload before saving.', 409);
    await audit('autonomy_policy_approved', { admin: actor, version: saved.version, mode: saved.mode, enabled: saved.enabled, paused: saved.paused });
    if (saved.paused) await social.setPaused(true, { admin: actor });
    else if (saved.enabled && saved.mode === 'sandbox' && config.social.provider === 'sandbox') await social.setPaused(false, { admin: actor });
    return saved;
  }
  async function stop(actor) {
    const saved = await col.settings.findOneAndUpdate({ _id: 'autonomy:policy' }, { $set: { paused: true, enabled: false, stoppedBy: actor, stoppedAt: clock().toISOString() }, $inc: { version: 1 } }, { upsert: true, returnDocument: 'after' });
    await social.setPaused(true, { admin: actor });
    await audit('autonomy_emergency_stop', { admin: actor });
    return { ...defaults(), ...saved };
  }
  async function isPaused() { return (await policy()).paused === true; }
  async function heartbeat(worker, now = clock()) {
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(String(worker))) throw error('Invalid worker identifier');
    await col.settings.updateOne({ _id: 'autonomy:heartbeat' }, { $set: { worker, at: now.toISOString() }, $inc: { observations: 1 } }, { upsert: true });
  }
  async function status() {
    const p = await policy(); const h = await col.settings.findOne({ _id: 'autonomy:heartbeat' });
    const age = h ? clock().getTime() - Date.parse(h.at) : null;
    const lastCycle = await col.settings.findOne({ _id: 'autonomy:lastCycle' });
    const activeAffiliates = await col.affiliates.find({ status: 'active', liveAffiliateId: { $regex: '^[a-f0-9]{24}$' } }, { projection: { _id: 0, id: 1, name: 1, liveAffiliateId: 1 } }).limit(100).toArray();
    return { policy: p, lastCycle, activeAffiliates, heartbeat: h ? { worker: h.worker, at: h.at, observations: h.observations, healthy: age >= 0 && age <= 35 * 60000 } : null, queue: { pending: await col.jobs.countDocuments({ state: 'pending' }), retrying: await col.jobs.countDocuments({ state: 'retry' }), running: await col.jobs.countDocuments({ state: 'running' }), failed: await col.jobs.countDocuments({ state: 'failed' }) }, liveApproved: config.autonomy?.liveApproved === true, limits: { paidAdvertising: false, maxSpendCents: 0 }, warning: 'A heartbeat is not proof of 24/7 uptime. In-flight provider requests cannot be unsent.' };
  }
  async function run(now = clock()) {
    const p = await policy(); const out = { approved: [], held: [], scheduled: [] };
    if (!p.enabled || p.paused) return { ...out, skipped: p.paused ? 'emergency_stop' : 'policy_not_enabled' };

    if (p.mode === 'approved-delivery' && !config.autonomy?.liveApproved) return { ...out, skipped: 'live_authorization_missing' };
    const drafts = await col.drafts.find({ status: 'needs_owner_review', kind: { $in: p.departments }, genre: { $in: p.genres } }).sort({ createdAt: 1 }).limit(100).toArray();
    for (const d of drafts) {
      const latest = await policy(); if (latest.paused || !latest.enabled || latest.version !== p.version) break;
      let reason = '';
      if (p.mode === 'sandbox' && (d.kind === 'marketing' ? config.social.provider !== 'sandbox' : config.delivery.realDelivery || !['sandbox-capture','sandbox-smtp'].includes(config.delivery.provider))) reason = 'department_sandbox_provider_unavailable';
      if (p.mode === 'approved-delivery' && (d.kind === 'marketing' ? config.social.provider !== 'live' || !config.social.approved : !config.delivery.realDelivery)) reason = 'department_live_provider_unavailable';
      if (d.kind === 'marketing' && !config.posters?.enabled) reason = 'verified_poster_generation_required';
      if (d.kind !== 'marketing' && !reason) {
        if (!d.recipient || await suppression.isSuppressed(d.recipient)) reason = 'recipient_missing_or_opted_out';
        else if (!d.contactSource || !/^https:\/\//.test(d.contactSource) || !d.consentBasis || !d.relevanceSource) reason = 'contact_or_relevance_evidence_missing';
        else if (p.mode === 'approved-delivery' && !p.approvedRecipients.includes(d.recipient.toLowerCase())) reason = 'recipient_requires_owner_authorization';
        else if (p.mode === 'sandbox' && !p.allowPublishedBusinessContacts && !p.approvedRecipients.includes(d.recipient.toLowerCase())) reason = 'contact_basis_not_authorized_by_policy';
      }
      if (reason) { out.held.push({ id: d.id, reason }); continue; }
      const claimId = `autonomy:approval:${d.id}`;
      try { await col.settings.insertOne({ _id: claimId, state: 'claimed', policyVersion: p.version, at: now.toISOString() }); }
      catch (e) { if (e.code === 11000) { const previous = await col.settings.findOne({ _id: claimId }); if (previous?.state === 'claimed') out.held.push({ id: d.id, reason: 'prior_policy_action_requires_reconciliation' }); continue; } throw e; }
      const budgetId = `autonomy:budget:${now.toISOString().slice(0,10)}:${d.kind}`;
      await col.settings.updateOne({ _id: budgetId }, { $setOnInsert: { count: 0 } }, { upsert: true });
      const budget = await col.settings.findOneAndUpdate({ _id: budgetId, count: { $lt: p.maxCampaignsPerDepartmentPerDay } }, { $inc: { count: 1 } }, { returnDocument: 'after' });
      if (!budget) { await col.settings.deleteOne({ _id: claimId, state: 'claimed' }); out.held.push({ id: d.id, reason: 'daily_policy_limit' }); continue; }
      if (await isPaused()) { out.held.push({ id: d.id, reason: 'emergency_stop' }); break; }
      const result = await approveDraft(d.id, { admin: `owner-policy:${p.approvedBy}`, acceptTextPoster: false, now });
      await col.settings.updateOne({ _id: claimId }, { $set: { state: result.ok ? 'approved' : 'held', reason: result.reason || null } });
      if (!result.ok) { out.held.push({ id: d.id, reason: result.reason }); continue; }
      await col.drafts.updateOne({ id: d.id }, { $set: { approvalMode: 'owner_policy', approvalPolicyVersion: p.version, policyApprovedBy: p.approvedBy } });
      out.approved.push(d.id);
      if (d.kind === 'marketing' && !await isPaused()) {
        const scheduled = await social.schedule(d.id, { channels: p.channels, scheduledAt: now.toISOString(), admin: `owner-policy:${p.approvedBy}`, now });
        out.scheduled.push({ id: d.id, ...scheduled });
        for (const affiliateId of p.affiliateIds || []) {
          if (await isPaused()) break;
          const variantBudget = await col.settings.findOneAndUpdate({ _id: budgetId, count: { $lt: p.maxCampaignsPerDepartmentPerDay } }, { $inc: { count: 1 } }, { returnDocument: 'after' });
          if (!variantBudget) { out.held.push({ id: d.id, affiliateId, reason: 'daily_policy_limit' }); break; }
          const variant = await social.schedule(d.id, { channels: p.channels, scheduledAt: now.toISOString(), affiliateId, admin: `owner-policy:${p.approvedBy}`, now });
          out.scheduled.push({ id: d.id, affiliateId, ...variant });
        }
      }
    }
    await col.settings.updateOne({ _id: 'autonomy:lastCycle' }, { $set: { at: now.toISOString(), policyVersion: p.version, approved: out.approved, held: out.held, scheduled: out.scheduled } }, { upsert: true });
    if (out.approved.length || out.held.length) await audit('autonomy_cycle', { policyVersion: p.version, approved: out.approved, held: out.held });
    return out;
  }
  return { policy, save, stop, isPaused, heartbeat, status, run };
}
module.exports = { createAutonomy, validatePolicy, defaults };
