'use strict';
// Scheduling + publishing queue for owner-approved fight campaigns.
// Gates (all must pass, every time a post goes out):
//   1. the campaign is owner-approved and tied to a verified contest
//   2. the fight is re-verified against the live contest list right before posting
//   3. the channel is authorized (see growth-social-publishing.js)
//   4. publishing is not paused (console switch or GROWTH_SOCIAL_PAUSED)
// Each post is claimed once; a post interrupted mid-publish is never retried
// automatically (it might already be live) — it is flagged for the owner to check.
const crypto = require('crypto');
const { CHANNELS } = require('./growth-social-publishing');

const clean = (s, n = 200) => String(s ?? '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, n);
const MAX_ATTEMPTS = 3;
const STUCK_MINUTES = 10;

function createSocialScheduler({ col, social, publisher, reverifyMarketing, alert, audit }) {
  const strip = ({ _id, claimToken, ...p }) => p;
  async function init() {
    await col.social.createIndex({ id: 1 }, { unique: true });
    await col.social.createIndex({ status: 1, scheduledAt: 1 });
  }
  async function isPaused() {
    if (social.paused) return { paused: true, by: 'environment (GROWTH_SOCIAL_PAUSED)' };
    const s = await col.settings.findOne({ key: 'social' });
    return { paused: s?.paused === true, by: s?.pausedBy || null, at: s?.pausedAt || null };
  }
  async function setPaused(paused, { admin, now = new Date() } = {}) {
    await col.settings.updateOne({ key: 'social' }, { $set: { key: 'social', paused: Boolean(paused), pausedBy: clean(admin, 120), pausedAt: now.toISOString() } }, { upsert: true });
    await audit(paused ? 'pause_publishing' : 'resume_publishing', { admin: clean(admin, 120) });
    return isPaused();
  }

  async function schedule(draftId, { channels, scheduledAt, admin, now = new Date() } = {}) {
    const d = await col.drafts.findOne({ id: clean(draftId, 160) });
    if (!d) return { ok: false, reason: 'not_found' };
    if (d.kind !== 'marketing' || !d.contestId || !d.contest) return { ok: false, reason: 'only_verified_fight_campaigns_can_be_scheduled' };
    if (d.status !== 'approved') return { ok: false, reason: 'approve_the_campaign_before_scheduling' };
    const list = [...new Set((Array.isArray(channels) ? channels : []).map((c) => String(c).toLowerCase()))];
    if (!list.length || list.some((c) => !CHANNELS.includes(c))) return { ok: false, reason: 'choose_at_least_one_valid_channel' };
    const when = new Date(scheduledAt);
    if (!Number.isFinite(when.getTime())) return { ok: false, reason: 'invalid_time' };
    if (when.getTime() < now.getTime() - 120000) return { ok: false, reason: 'time_is_in_the_past' }; // the time box has minute precision
    const lastMoment = Date.parse(`${d.contest.dateKey}T23:59:59Z`) + 14 * 3600000; // end of fight day, any timezone
    if (when.getTime() > lastMoment) return { ok: false, reason: 'time_is_after_the_fight' };
    const results = [];
    for (const ch of list) {
      const text = d.posts?.[ch];
      if (!text) { results.push({ channel: ch, ok: false, reason: 'no_post_for_this_channel' }); continue; }
      const needsImage = ch === 'instagram' || ch === 'tiktok';
      if (needsImage && !d.contest.posterUrl) { results.push({ channel: ch, ok: false, reason: 'channel_needs_a_fight_poster_image' }); continue; }
      const id = `${d.id}__${ch}`;
      const existing = await col.social.findOne({ id });
      if (existing && ['scheduled', 'publishing', 'published', 'needs_check'].includes(existing.status)) { results.push({ channel: ch, ok: false, reason: `already_${existing.status}` }); continue; }
      const doc = { id, draftId: d.id, contestId: d.contestId, genre: d.genre, channel: ch, text, imageUrl: needsImage ? d.contest.posterUrl : (d.contest.posterUrl || null), scheduledAt: when.toISOString(), status: 'scheduled', attempts: 0, scheduledBy: clean(admin, 120), createdAt: now.toISOString(), history: [{ at: now.toISOString(), status: 'scheduled', by: clean(admin, 120) }] };
      if (existing) await col.social.replaceOne({ id }, doc); else await col.social.insertOne(doc);
      results.push({ channel: ch, ok: true, id });
    }
    await audit('schedule_posts', { id: d.id, admin: clean(admin, 120), channels: results.filter((r) => r.ok).map((r) => r.channel) });
    return { ok: results.some((r) => r.ok), results, reason: results.every((r) => !r.ok) ? results[0]?.reason : undefined };
  }
  async function cancel(postId, { admin, now = new Date() } = {}) {
    const r = await col.social.findOneAndUpdate({ id: clean(postId, 220), status: { $in: ['scheduled', 'held', 'failed'] } }, { $set: { status: 'cancelled', cancelledBy: clean(admin, 120), cancelledAt: now.toISOString() }, $push: { history: { at: now.toISOString(), status: 'cancelled', by: clean(admin, 120) } } }, { returnDocument: 'after' });
    if (!r) return { ok: false, reason: 'only_scheduled_held_or_failed_posts_can_be_cancelled' };
    await audit('cancel_post', { id: r.id, admin: clean(admin, 120) });
    return { ok: true, post: strip(r) };
  }
  // Re-queue a held/failed post. A "needs_check" post (interrupted mid-publish)
  // can only be re-queued after the owner confirms it is NOT already live.
  async function retry(postId, { admin, confirmNotPublished = false, now = new Date() } = {}) {
    const p = await col.social.findOne({ id: clean(postId, 220) });
    if (!p) return { ok: false, reason: 'not_found' };
    if (p.status === 'needs_check' && confirmNotPublished !== true) return { ok: false, reason: 'confirm_the_post_is_not_already_live' };
    if (!['held', 'failed', 'needs_check'].includes(p.status)) return { ok: false, reason: 'only_held_failed_or_unchecked_posts_can_be_retried' };
    await col.social.updateOne({ id: p.id }, { $set: { status: 'scheduled', attempts: 0, lastError: null, scheduledAt: new Date(now.getTime() + 60000).toISOString() }, $push: { history: { at: now.toISOString(), status: 'scheduled', by: clean(admin, 120), note: 'retry' } } });
    await audit('retry_post', { id: p.id, admin: clean(admin, 120) });
    return { ok: true };
  }
  async function list({ status, limit = 200 } = {}) {
    const q = status ? { status: clean(status, 20) } : {};
    return (await col.social.find(q).sort({ scheduledAt: -1 }).limit(Math.min(500, Number(limit) || 200)).toArray()).map(strip);
  }

  async function dispatch(now = new Date()) {
    const out = { published: 0, held: 0, failed: 0, cancelled: 0, retrying: 0, needsCheck: 0, paused: false };
    // Recovery: interrupted publishes are flagged, never reposted automatically.
    const stuckBefore = new Date(now.getTime() - STUCK_MINUTES * 60000).toISOString();
    for (const p of await col.social.find({ status: 'publishing', claimedAt: { $lt: stuckBefore } }).toArray()) {
      await col.social.updateOne({ id: p.id, status: 'publishing' }, { $set: { status: 'needs_check' }, $push: { history: { at: now.toISOString(), status: 'needs_check', note: 'interrupted while publishing' } } });
      await alert(`social-check:${p.id}`, 'social', p.id, 'publishing was interrupted; check the channel before retrying (it may already be live)', now);
      out.needsCheck++;
    }
    const pause = await isPaused();
    if (pause.paused) { out.paused = true; return out; }
    const due = await col.social.find({ status: 'scheduled', scheduledAt: { $lte: now.toISOString() } }).sort({ scheduledAt: 1 }).limit(20).toArray();
    const verified = new Map();
    for (const p of due) {
      const ch = social.channels[p.channel];
      if (!ch?.ready) {
        await col.social.updateOne({ id: p.id, status: 'scheduled' }, { $set: { status: 'held', heldReason: (ch?.blockers || ['channel unknown']).join('; ') }, $push: { history: { at: now.toISOString(), status: 'held' } } });
        out.held++; continue;
      }
      const draft = await col.drafts.findOne({ id: p.draftId });
      if (!draft || !['approved', 'published'].includes(draft.status)) {
        await col.social.updateOne({ id: p.id, status: 'scheduled' }, { $set: { status: 'cancelled', cancelReason: 'campaign is no longer approved' }, $push: { history: { at: now.toISOString(), status: 'cancelled', note: 'campaign no longer approved' } } });
        out.cancelled++; continue;
      }
      if (!verified.has(draft.id)) verified.set(draft.id, await reverifyMarketing({ ...draft, status: 'needs_owner_review' }, now));
      const v = verified.get(draft.id);
      if (!v.ok) {
        if (v.reason === 'contest_feed_unreachable_try_again') { out.retrying++; continue; } // try next tick
        await col.social.updateOne({ id: p.id, status: 'scheduled' }, { $set: { status: 'cancelled', cancelReason: v.reason }, $push: { history: { at: now.toISOString(), status: 'cancelled', note: v.reason } } });
        out.cancelled++; continue;
      }
      const token = crypto.randomBytes(8).toString('hex');
      const claimed = await col.social.findOneAndUpdate({ id: p.id, status: 'scheduled' }, { $set: { status: 'publishing', claimedAt: now.toISOString(), claimToken: token }, $inc: { attempts: 1 } }, { returnDocument: 'after' });
      if (!claimed) continue;
      let result;
      try { result = await publisher.publish(claimed); } catch (e) { result = { ok: false, retryable: true, reason: clean(e.message) }; }
      if (result.ok) {
        const r = result.receipt;
        await col.social.updateOne({ id: p.id, claimToken: token }, { $set: { status: 'published', publishedAt: now.toISOString(), providerPostId: r.providerPostId, url: r.url || null, sandbox: r.sandbox === true, pending: r.pending || null, lastError: null }, $push: { history: { at: now.toISOString(), status: 'published', note: r.sandbox ? 'sandbox (simulated)' : 'live' } } });
        if (!r.sandbox) await col.drafts.updateOne({ id: draft.id, status: 'approved' }, { $set: { status: 'published', publishedAt: now.toISOString(), publishedVia: 'scheduler' } });
        await audit('post_published', { id: p.id, channel: p.channel, sandbox: r.sandbox === true, admin: 'scheduler' });
        out.published++;
      } else if (result.retryable && claimed.attempts < MAX_ATTEMPTS) {
        await col.social.updateOne({ id: p.id, claimToken: token }, { $set: { status: 'scheduled', lastError: result.reason, scheduledAt: new Date(now.getTime() + 5 * 60000 * 2 ** (claimed.attempts - 1)).toISOString() }, $push: { history: { at: now.toISOString(), status: 'retry', note: result.reason } } });
        out.retrying++;
      } else {
        await col.social.updateOne({ id: p.id, claimToken: token }, { $set: { status: 'failed', lastError: result.reason }, $push: { history: { at: now.toISOString(), status: 'failed', note: result.reason } } });
        await alert(`social:${p.id}`, 'social', p.id, result.reason, now);
        out.failed++;
      }
    }
    return out;
  }
  return { init, schedule, cancel, retry, list, dispatch, isPaused, setPaused };
}

module.exports = { createSocialScheduler };
