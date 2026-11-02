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
const { playerLink } = require('./growth-affiliate-program');
const fightUrls = require('./growth-fight-urls');

const clean = (s, n = 200) => String(s ?? '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, n);
const MAX_ATTEMPTS = 3;
const STUCK_MINUTES = 10;
const DUPLICATE_WINDOW_DAYS = 7;
const ACTIVE = ['scheduled', 'publishing', 'published', 'needs_check'];
// Same channel + same caption + same image = the same post, whichever campaign it came from.
// The campaign's generated FANTASY MMADNESS poster (4:5 for feeds, 9:16 for TikTok);
// campaigns made before posters existed fall back to the contest's own artwork.
const imageFor = (d, ch) => (ch === 'tiktok' ? d.poster?.story?.url : d.poster?.portrait?.url) || d.contest?.posterUrl || null;
const fingerprint = (channel, text, imageUrl) => crypto.createHash('sha256').update([channel, String(text || '').trim().replace(/\s+/g, ' '), imageUrl || ''].join('|')).digest('hex').slice(0, 24);
const CONTEST_LINK = /https:\/\/www\.fantasymmadness\.com\/\S*utm_campaign=combat_fans_gs_\S*/;

function createSocialScheduler({ col, social, publisher, reverifyMarketing, alert, audit, liveTestApproved = false }) {
  const strip = ({ _id, claimToken, ...p }) => p;
  async function init() {
    await col.social.createIndex({ id: 1 }, { unique: true });
    await col.social.createIndex({ status: 1, scheduledAt: 1 });
    await col.social.createIndex({ fingerprint: 1, status: 1 });
  }
  async function duplicateOf(fp, { excludeId, now }) {
    const since = new Date(now.getTime() - DUPLICATE_WINDOW_DAYS * 86400000).toISOString();
    return col.social.findOne({ fingerprint: fp, id: { $ne: excludeId }, status: { $in: ACTIVE }, $or: [{ status: { $ne: 'published' } }, { publishedAt: { $gte: since } }] });
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

  async function schedule(draftId, { channels, scheduledAt, affiliateId, admin, now = new Date() } = {}) {
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
    let aff = null;
    if (affiliateId) {
      aff = await col.affiliates.findOne({ id: clean(affiliateId, 80) });
      if (!aff) return { ok: false, reason: 'affiliate_not_found' };
      if (!playerLink(aff, d.contest)) return { ok: false, reason: 'affiliate_is_not_active_with_a_live_affiliate_id' };
    }
    const results = [];
    for (const ch of list) {
      let text = d.posts?.[ch];
      if (!text) { results.push({ channel: ch, ok: false, reason: 'no_post_for_this_channel' }); continue; }
      if (aff) {
        // Affiliate-credited post: the fight link becomes the affiliate's player link
        // (the live site's own ?ref= referral), tagged with the channel.
        if (!CONTEST_LINK.test(text)) { results.push({ channel: ch, ok: false, reason: 'this_channel_has_no_link_to_credit' }); continue; }
        text = text.replace(CONTEST_LINK, `${playerLink(aff, d.contest)}&utm_term=${ch}`);
      }
      const needsImage = ch === 'instagram' || ch === 'tiktok';
      const posterImage = imageFor(d, ch);
      if (needsImage && !posterImage) { results.push({ channel: ch, ok: false, reason: 'channel_needs_a_fight_poster_image' }); continue; }
      const id = `${d.id}__${ch}${aff ? `__${aff.code}` : ''}`;
      const existing = await col.social.findOne({ id });
      if (existing && ACTIVE.includes(existing.status)) { results.push({ channel: ch, ok: false, reason: `already_${existing.status}` }); continue; }
      const imageUrl = posterImage;
      const fp = fingerprint(ch, text, imageUrl);
      const dup = await duplicateOf(fp, { excludeId: id, now });
      if (dup) { results.push({ channel: ch, ok: false, reason: `duplicate_of_${dup.status}_post`, duplicateOf: dup.id }); continue; }
      const doc = { id, draftId: d.id, contestId: d.contestId, genre: d.genre, channel: ch, text, imageUrl, fingerprint: fp, cleanUrl: d.contest.cleanUrl || null, affiliate: aff ? { id: aff.id, code: aff.code, name: clean(aff.name, 120) } : null, scheduledAt: when.toISOString(), status: 'scheduled', attempts: 0, scheduledBy: clean(admin, 120), createdAt: now.toISOString(), history: [{ at: now.toISOString(), status: 'scheduled', by: clean(admin, 120), note: aff ? `affiliate link: ${aff.code}` : undefined }] };
      if (existing) await col.social.replaceOne({ id }, doc); else await col.social.insertOne(doc);
      results.push({ channel: ch, ok: true, id });
    }
    await audit('schedule_posts', { id: d.id, admin: clean(admin, 120), affiliate: aff?.code || null, channels: results.filter((r) => r.ok).map((r) => r.channel) });
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
      const ch = await publisher.channelState(p.channel);
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
      // Use the website's current address for this fight (fighter-name address, else ID address).
      const c = v.contest;
      if (c && c.idBase) {
        const to = c.cleanUrl || c.idBase;
        const text = p.channel === 'tiktok' ? fightUrls.tiktokLine(p.text, c) : [c.idBase, p.cleanUrl].filter(Boolean).reduce((acc, f) => fightUrls.relink(acc, f, to), p.text);
        if (text !== p.text) {
          const fp2 = fingerprint(p.channel, text, p.imageUrl);
          await col.social.updateOne({ id: p.id, status: 'scheduled' }, { $set: { text, fingerprint: fp2, cleanUrl: c.cleanUrl || null }, $push: { history: { at: now.toISOString(), status: 'scheduled', note: c.cleanUrl ? 'link updated to the fighter-name address' : 'link set to the fight ID address' } } });
          p.text = text; p.fingerprint = fp2;
        }
      }
      const dup = await duplicateOf(p.fingerprint || fingerprint(p.channel, p.text, p.imageUrl), { excludeId: p.id, now });
      if (dup && ['publishing', 'published', 'needs_check'].includes(dup.status)) {
        await col.social.updateOne({ id: p.id, status: 'scheduled' }, { $set: { status: 'cancelled', cancelReason: `duplicate of ${dup.id}` }, $push: { history: { at: now.toISOString(), status: 'cancelled', note: `duplicate of ${dup.id} (${dup.status})` } } });
        out.cancelled++; continue;
      }
      const token = crypto.randomBytes(8).toString('hex');
      const claimed = await col.social.findOneAndUpdate({ id: p.id, status: 'scheduled' }, { $set: { status: 'publishing', claimedAt: now.toISOString(), claimToken: token }, $inc: { attempts: 1 } }, { returnDocument: 'after' });
      if (!claimed) continue;
      let result;
      try { result = await publisher.publish(claimed); } catch (e) { result = { ok: false, retryable: true, reason: clean(e.message) }; }
      if (result.ok) {
        const r = result.receipt;
        await col.social.updateOne({ id: p.id, claimToken: token }, { $set: { status: 'published', publishedAt: now.toISOString(), providerPostId: r.providerPostId, url: r.url || null, sandbox: r.sandbox === true, pending: r.pending || null, preflight: r.preflight || null, lastError: null }, $push: { history: { at: now.toISOString(), status: 'published', note: r.sandbox ? `sandbox (simulated; nothing sent to ${p.channel})${r.connectedAccount ? ' · connected account checked' : ''}` : 'live' } } });
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
  // Controlled live test: ONE real post per channel, of an owner-approved fight campaign,
  // through the connected account. Requires the owner's explicit authorization
  // (GROWTH_SOCIAL_LIVE_TEST_APPROVED=true), a typed confirmation, the campaign
  // re-verified against the live contest list, and no duplicate.
  async function liveTest(draftId, { channel, confirmText, admin, now = new Date() } = {}) {
    if (!liveTestApproved) return { ok: false, reason: 'live_test_not_authorized_by_owner' };
    if (String(confirmText || '').trim().toUpperCase() !== 'POST LIVE') return { ok: false, reason: 'type_POST_LIVE_to_confirm' };
    const ch = String(channel || '').toLowerCase();
    if (!['facebook', 'instagram'].includes(ch)) return { ok: false, reason: 'live_test_is_for_facebook_or_instagram' };
    if ((await isPaused()).paused) return { ok: false, reason: 'publishing_is_paused' };
    const used = await col.social.findOne({ liveTest: true, channel: ch, status: { $in: ['publishing', 'published', 'needs_check'] } });
    if (used) return { ok: false, reason: 'the_live_test_for_this_channel_was_already_used', post: strip(used) };
    const d = await col.drafts.findOne({ id: clean(draftId, 160) });
    if (!d || d.kind !== 'marketing' || !d.contestId) return { ok: false, reason: 'only_verified_fight_campaigns' };
    if (!['approved', 'published'].includes(d.status)) return { ok: false, reason: 'approve_the_campaign_first' };
    const v = await reverifyMarketing({ ...d, status: 'needs_owner_review' }, now);
    if (!v.ok) return { ok: false, reason: v.reason };
    const text = d.posts?.[ch]; const imageUrl = imageFor(d, ch);
    if (!text) return { ok: false, reason: 'no_post_for_this_channel' };
    if (ch === 'instagram' && !imageUrl) return { ok: false, reason: 'channel_needs_a_fight_poster_image' };
    const fp = fingerprint(ch, text, imageUrl);
    const id = `${d.id}__${ch}__livetest`;
    const dup = await duplicateOf(fp, { excludeId: id, now });
    if (dup && (dup.status !== 'published' || dup.sandbox !== true)) return { ok: false, reason: `duplicate_of_${dup.status}_post`, duplicateOf: dup.id };
    const token = crypto.randomBytes(8).toString('hex');
    const doc = { id, draftId: d.id, contestId: d.contestId, genre: d.genre, channel: ch, text, imageUrl, fingerprint: fp, liveTest: true, scheduledAt: now.toISOString(), status: 'publishing', claimedAt: now.toISOString(), claimToken: token, attempts: 1, scheduledBy: clean(admin, 120), createdAt: now.toISOString(), history: [{ at: now.toISOString(), status: 'publishing', by: clean(admin, 120), note: 'controlled live test' }] };
    try { await col.social.insertOne(doc); } catch { return { ok: false, reason: 'the_live_test_for_this_channel_was_already_used' }; }
    await audit('live_test_started', { id, channel: ch, admin: clean(admin, 120) });
    let result; try { result = await publisher.publishLive(doc); } catch (e) { result = { ok: false, reason: clean(e.message) }; }
    if (result.ok) {
      const r = result.receipt;
      await col.social.updateOne({ id, claimToken: token }, { $set: { status: 'published', publishedAt: now.toISOString(), providerPostId: r.providerPostId, url: r.url || null, sandbox: false }, $push: { history: { at: now.toISOString(), status: 'published', note: 'live (controlled test)' } } });
      await col.drafts.updateOne({ id: d.id, status: 'approved' }, { $set: { status: 'published', publishedAt: now.toISOString(), publishedVia: 'live_test' } });
      await audit('live_test_published', { id, channel: ch, admin: clean(admin, 120), providerPostId: r.providerPostId });
      return { ok: true, post: strip(await col.social.findOne({ id })) };
    }
    // A failed live test does not use up the test: the record is removed so it can be tried again.
    await col.social.deleteOne({ id, claimToken: token });
    await audit('live_test_failed', { id, channel: ch, admin: clean(admin, 120), reason: result.reason });
    return { ok: false, reason: 'meta_did_not_publish', detail: result.reason };
  }
  return { init, schedule, cancel, retry, list, dispatch, isPaused, setPaused, liveTest, fingerprint };
}

module.exports = { createSocialScheduler };
