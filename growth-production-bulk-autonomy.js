'use strict';
// "APPROVE ALL & SEND" and owner-policy Autonomous Mode.
//
// Both features only feed the existing exact-delivery path:
//   review.decide (content approval)  ->  distribution.authorize (exact payload,
//   destination, schedule, unique queue key)  ->  distribution.dispatch (receipts).
// Nothing here talks to a provider, relaxes a safety gate, or touches the fight
// Registry, scoring, payments, affiliate attribution or fighter records.
const crypto = require('node:crypto');
const { contentVersion } = require('./growth-production-review');

const KINDS = ['marketing', 'pr', 'affiliate'];
const CHANNELS = { marketing: ['facebook', 'instagram'], pr: ['email'], affiliate: ['email'] };
// Provider grants that do not exist yet are reported, never worked around.
const UNSUPPORTED = { x: 'x_tweet_write_permission_not_granted', tiktok: 'tiktok_video_publish_permission_not_granted' };
const HARD_LIMITS = { email: { maxPerDay: 50, minSpacingMinutes: 2 }, facebook: { maxPerDay: 6, minSpacingMinutes: 30 }, instagram: { maxPerDay: 6, minSpacingMinutes: 30 } };
const DEFAULT_LIMITS = { email: { maxPerDay: 30, minSpacingMinutes: 3 }, facebook: { maxPerDay: 4, minSpacingMinutes: 60 }, instagram: { maxPerDay: 4, minSpacingMinutes: 60 } };
const ACTIVE = ['scheduled', 'sending', 'accepted', 'published', 'needs_check'];
const BULK_CONFIRMATION = 'APPROVE ALL AND SEND';
const POLICY_CONFIRMATION = 'SAVE AUTONOMOUS POLICY';
const ENABLE_CONFIRMATION = 'ENABLE AUTONOMOUS MODE';
const PREVIEW_TTL_MS = 15 * 60000;
const MAX_PER_BATCH = 60;
const HORIZON_MS = 6 * 86400000; // authorize() accepts at most seven days ahead.
const MINUTE = 60000, DAY = 86400000;

const digest = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const isOwnerId = x => /^[a-f0-9]{24}$/.test(String(x || ''));
const clean = (s, n = 300) => String(s ?? '').replace(/[\x00-\x1f]/g, ' ').slice(0, n);
const int = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };

// The content template a prepared campaign was built from. A human edit makes the
// campaign one-off content, so it never matches a template and always needs the owner.
function templateOf(d) {
  if (!d || d.editCount > 0 || d.editedBy || d.editedAt) return null;
  if (d.kind === 'marketing') return Number.isInteger(d.copyVersion) ? 'marketing/platform-copy-v' + d.copyVersion : null;
  if (d.kind === 'pr' || d.kind === 'affiliate') {
    if (Number.isInteger(d.emailQualityVersion)) return d.kind + '/outreach-v' + d.emailQualityVersion;
    if (/^[a-z]{2,20}$/.test(d.templateType || '')) return d.kind + '/' + d.templateType;
  }
  return null;
}

function normalizePolicy(input = {}) {
  const kinds = {};
  for (const kind of KINDS) {
    const k = input.kinds?.[kind] || {};
    const channels = [...new Set((Array.isArray(k.channels) ? k.channels : []).filter(c => CHANNELS[kind].includes(c)))];
    const templates = [...new Set((Array.isArray(k.templates) ? k.templates : []).map(String).filter(t => new RegExp('^' + kind + '/[a-z0-9-]{1,40}$').test(t)))].slice(0, 20);
    kinds[kind] = { enabled: k.enabled === true && channels.length > 0 && templates.length > 0, channels, templates };
    if (kind !== 'marketing') kinds[kind].recontactDays = int(k.recontactDays, 14, 365, 60);
  }
  const limits = {};
  for (const ch of Object.keys(HARD_LIMITS)) {
    const l = input.limits?.[ch] || {};
    limits[ch] = { maxPerDay: int(l.maxPerDay, 0, HARD_LIMITS[ch].maxPerDay, DEFAULT_LIMITS[ch].maxPerDay), minSpacingMinutes: int(l.minSpacingMinutes, HARD_LIMITS[ch].minSpacingMinutes, 24 * 60, DEFAULT_LIMITS[ch].minSpacingMinutes) };
  }
  const includePreviouslyApproved = input.includePreviouslyApproved === true;
  const startHour = int(input.sendWindow?.startHour, 0, 23, 9), endHour = int(input.sendWindow?.endHour, 1, 24, 21);
  return {
    kinds, limits,
    sendWindow: { startHour, endHour: Math.max(endHour, startHour + 1), timeZone: 'America/New_York' },
    maxAutoApprovalsPerRun: int(input.maxAutoApprovalsPerRun, 1, 25, 10),
    // Off by default: switching Autonomous Mode on never sends the existing backlog.
    includePreviouslyApproved,
  };
}
const DEFAULT_WINDOW = { startHour: 8, endHour: 22, timeZone: 'America/New_York' };
const hourIn = (date, timeZone) => Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(date));

function createBulkAutonomy({ db, col, queue, distribution, review, owners, clock = () => new Date(), autoApprovalReleased = false, environment = 'production' } = {}) {
  if (!db || !col?.drafts || !queue || !distribution || !review || !Array.isArray(owners)) throw Error('bulk_autonomy_dependencies_required');
  const batches = db.collection('bulk_batches');
  const policyVersions = db.collection('autonomous_policy_versions');
  const decisions = db.collection('autonomous_decisions');
  const settings = col.settings, audit = col.audit;
  const now = () => clock();
  const iso = d => new Date(d).toISOString();

  async function init() {
    await batches.createIndex({ createdAt: -1 });
    await decisions.createIndex({ draftId: 1, version: 1 }, { unique: true });
    await decisions.createIndex({ at: -1 });
  }

  // ---------- shared eligibility + scheduling ----------

  async function providerFor(channel) {
    const r = await distribution.readiness();
    return channel === 'email' ? r.email : r.channels?.[channel];
  }

  // Blockers that apply regardless of channel. Reuses the distribution assessment;
  // only "not approved yet" is ignored because approval is what this feature grants.
  async function campaignBlockers(d) {
    if (!['needs_owner_review', 'approved'].includes(d.status)) return ['not_awaiting_approval_or_delivery'];
    const blockers = (await distribution.assessCampaign({ ...d, status: 'approved', ownerApproved: true })).filter(b => b !== 'content_approval_required');
    return [...new Set(blockers)];
  }

  async function channelBlockers(d, channel, provider, at, { recontactDays = 60 } = {}) {
    const out = [];
    if (!provider?.ready) out.push('provider_not_verified');
    if (channel !== 'email' && d.platformCopy?.[channel]?.ready === false) out.push('platform_copy_not_ready');
    const payload = distribution.deliveryPayload(d, channel, provider?.destinationId);
    if (!payload.text) out.push('approved_text_missing');
    if (channel !== 'email' && !payload.imageUrl) out.push('approved_artwork_missing');
    if (channel !== 'email' && at) {
      const late = require('./growth-contest-campaigns').checkCampaign(d, d.contest, { now: at });
      if (late.length) out.push('expired_after_fight_entry_deadline');
    }
    // Duplicate protection beyond the unique queue key.
    if (await queue.findOne({ draftId: d.id, 'payload.channel': channel, status: { $in: ACTIVE } })) out.push('already_scheduled_or_sent');
    if (channel === 'email' && d.recipient) {
      const since = iso(+now() - recontactDays * DAY);
      if (await queue.findOne({ 'payload.recipient': d.recipient, status: { $in: ACTIVE }, scheduledAt: { $gte: since } })) out.push('recipient_contacted_recently');
    }
    if (d.kind === 'marketing' && d.contestId) {
      const siblings = (await col.drafts.find({ contestId: d.contestId, id: { $ne: d.id } }, { projection: { id: 1 } }).toArray()).map(x => x.id);
      if (siblings.length && await queue.findOne({ draftId: { $in: siblings }, 'payload.channel': channel, status: { $in: ACTIVE }, scheduledAt: { $gte: iso(+now() - 3 * DAY) } })) out.push('fight_already_posted_on_channel');
    }
    return { blockers: out, payload };
  }

  // Finds the next slot honoring spacing, a rolling 24-hour cap and the send window.
  function makePlanner(limits, window) {
    const taken = {};
    async function load(channel) {
      if (taken[channel]) return taken[channel];
      const rows = await queue.find({ 'payload.channel': channel, status: { $in: ACTIVE }, scheduledAt: { $gte: iso(+now() - DAY) } }, { projection: { scheduledAt: 1 } }).toArray();
      return (taken[channel] = rows.map(r => Date.parse(r.scheduledAt)).filter(Number.isFinite));
    }
    return async function next(channel, earliest) {
      const l = limits[channel];
      if (!l || l.maxPerDay < 1) return null;
      const times = await load(channel);
      let t = Math.max(+earliest, +now() + 5 * MINUTE);
      for (let guard = 0; guard < 2000; guard++) {
        if (t > +now() + HORIZON_MS) return null;
        const h = hourIn(new Date(t), window.timeZone);
        if (h < window.startHour || h >= window.endHour) { t += 15 * MINUTE; continue; }
        const near = times.find(x => Math.abs(x - t) < l.minSpacingMinutes * MINUTE);
        if (near !== undefined) { t = near + l.minSpacingMinutes * MINUTE; continue; }
        const inDay = times.filter(x => x > t - DAY && x <= t).sort((a, b) => a - b);
        if (inDay.length >= l.maxPerDay) { t = inDay[inDay.length - l.maxPerDay] + DAY + MINUTE; continue; }
        times.push(t);
        return new Date(t);
      }
      return null;
    };
  }

  function describe(d, channel, payload, provider, at) {
    return {
      draftId: d.id, kind: d.kind, genre: d.genre || null, title: clean(d.headline || d.subject || d.id, 200), channel,
      destination: channel === 'email' ? payload.recipient : provider?.name || provider?.destinationId || null,
      destinationId: channel === 'email' ? null : provider?.destinationId || null, recipient: channel === 'email' ? payload.recipient : null,
      subject: payload.subject || null, text: payload.text || '', imageUrl: payload.imageUrl || null,
      scheduledAt: at ? at.toISOString() : null, version: contentVersion(d), payloadHash: digest(payload), template: templateOf(d),
      needsContentApproval: d.status === 'needs_owner_review',
    };
  }

  // Approves (if needed) and authorizes one prepared delivery through the existing gates.
  async function approveAndAuthorize(item, owner, reason) {
    const d = await col.drafts.findOne({ id: item.draftId });
    if (!d || contentVersion(d) !== item.version) return { ok: false, reason: 'campaign_changed_since_preview' };
    if (d.status === 'needs_owner_review') {
      const r = await review.decide(d.id, { action: 'approve', owner, version: item.version, reason });
      if (!r.ok) return { ok: false, reason: r.reason, blockers: r.blockers || [] };
    }
    const fresh = await col.drafts.findOne({ id: item.draftId });
    if (!fresh || contentVersion(fresh) !== item.version) return { ok: false, reason: 'campaign_changed_since_preview' };
    if (digest(distribution.deliveryPayload(fresh, item.channel, item.destinationId)) !== item.payloadHash) return { ok: false, reason: 'delivery_content_changed_since_preview' };
    const body = { confirmation: 'AUTHORIZE THIS EXACT DELIVERY', version: item.version, channel: item.channel, scheduledAt: item.scheduledAt, payloadHash: item.payloadHash };
    if (item.channel === 'email') body.recipient = item.recipient; else body.destinationId = item.destinationId;
    return distribution.authorize(item.draftId, body, owner);
  }

  async function candidateDrafts(kinds, extra = {}, limit = 200) {
    return col.drafts.find({ kind: { $in: kinds }, status: { $in: ['needs_owner_review', 'approved'] }, ...extra }).sort({ createdAt: 1 }).limit(limit).toArray();
  }

  // ---------- FEATURE 1: APPROVE ALL & SEND ----------

  async function bulkPreview(owner) {
    if (!owners.includes(owner)) return { ok: false, reason: 'verified_owner_required' };
    const auto = await settings.findOne({ _id: 'autonomous-mode' });
    const limits = auto?.policy?.limits || normalizePolicy({}).limits;
    const plan = makePlanner(limits, auto?.policy?.sendWindow || DEFAULT_WINDOW);
    const providers = { email: await providerFor('email'), facebook: await providerFor('facebook'), instagram: await providerFor('instagram') };
    const items = [], excluded = [];
    const drafts = await candidateDrafts(KINDS, {}, 400);
    let truncated = 0;
    for (const d of drafts) {
      const base = { draftId: d.id, kind: d.kind, genre: d.genre || null, title: clean(d.headline || d.subject || d.id, 200), status: d.status };
      for (const ch of (d.channels || []).filter(c => UNSUPPORTED[c])) excluded.push({ ...base, channel: ch, reasons: [UNSUPPORTED[ch]] });
      if (items.length >= MAX_PER_BATCH) { truncated++; continue; }
      const general = await campaignBlockers(d);
      if (general.length) { excluded.push({ ...base, channel: null, reasons: general }); continue; }
      for (const channel of CHANNELS[d.kind]) {
        const provider = providers[channel];
        const at = provider?.ready ? await plan(channel, now()) : null;
        const { blockers, payload } = await channelBlockers(d, channel, provider, at);
        if (!at && provider?.ready) blockers.push('daily_limit_reached_offer_again_later');
        if (blockers.length) excluded.push({ ...base, channel, reasons: [...new Set(blockers)] });
        else items.push(describe(d, channel, payload, provider, at));
      }
    }
    const createdAt = now();
    const batch = {
      _id: 'batch-' + crypto.randomUUID(), owner, state: 'previewed', createdAt: createdAt.toISOString(), expiresAt: iso(+createdAt + PREVIEW_TTL_MS),
      items, excluded, truncated,
      totals: { campaigns: new Set(items.map(i => i.draftId)).size, deliveries: items.length, excluded: excluded.length, byKind: Object.fromEntries(KINDS.map(k => [k, items.filter(i => i.kind === k).length])), byChannel: Object.fromEntries(Object.keys(HARD_LIMITS).map(c => [c, items.filter(i => i.channel === c).length])) },
    };
    batch.digest = digest(items.map(i => [i.draftId, i.channel, i.version, i.payloadHash, i.scheduledAt]));
    await batches.insertOne(batch);
    await audit.insertOne({ action: 'bulk_approve_all_previewed', batchId: batch._id, owner, digest: batch.digest, deliveries: items.length, excluded: excluded.length, at: batch.createdAt });
    return { ok: true, ...publicBatch(batch), confirmation: BULK_CONFIRMATION };
  }

  async function bulkConfirm(batchId, body = {}, owner) {
    if (!owners.includes(owner)) return { ok: false, reason: 'verified_owner_required' };
    if (body.confirmation !== BULK_CONFIRMATION) return { ok: false, reason: 'explicit_owner_confirmation_required' };
    const batch = await batches.findOne({ _id: String(batchId) });
    if (!batch) return { ok: false, reason: 'batch_not_found' };
    if (batch.digest !== body.digest) return { ok: false, reason: 'batch_changed_preview_again' };
    if (Date.parse(batch.expiresAt) < +now()) return { ok: false, reason: 'preview_expired_preview_again' };
    if (!batch.items.length) return { ok: false, reason: 'no_eligible_campaigns' };
    // One confirmation per preview: atomic state change blocks double clicks and replays.
    const claimed = await batches.findOneAndUpdate({ _id: batch._id, state: 'previewed' }, { $set: { state: 'sending', confirmedBy: owner, confirmedAt: now().toISOString() } }, { returnDocument: 'after' });
    if (!claimed) return { ok: false, reason: 'batch_already_confirmed' };
    await audit.insertOne({ action: 'bulk_approve_all_confirmed', batchId: batch._id, owner, digest: batch.digest, deliveries: batch.items.length, at: now().toISOString() });
    // If the owner took a few minutes to read, keep the exact order and spacing.
    const first = Math.min(...batch.items.map(i => Date.parse(i.scheduledAt)));
    const shift = Math.max(0, +now() + 2 * MINUTE - first);
    const results = [];
    for (const item of batch.items) {
      const scheduledAt = iso(Date.parse(item.scheduledAt) + shift);
      let r;
      if (Date.parse(scheduledAt) > +now() + 7 * DAY - MINUTE) r = { ok: false, reason: 'schedule_outside_seven_day_window' };
      else { try { r = await approveAndAuthorize({ ...item, scheduledAt }, owner, 'APPROVE ALL & SEND ' + batch._id); } catch { r = { ok: false, reason: 'authorization_error' }; } }
      results.push({ draftId: item.draftId, channel: item.channel, scheduledAt, ok: r.ok === true, key: r.key || null, reason: r.ok ? null : r.reason, blockers: r.blockers || [] });
    }
    await batches.updateOne({ _id: batch._id }, { $set: { state: 'confirmed', results, completedAt: now().toISOString() } });
    await audit.insertOne({ action: 'bulk_approve_all_queued', batchId: batch._id, owner, queued: results.filter(r => r.ok).length, held: results.filter(r => !r.ok).length, at: now().toISOString() });
    return bulkStatus(batch._id);
  }

  function publicBatch(b) {
    return { batchId: b._id, state: b.state, createdAt: b.createdAt, expiresAt: b.expiresAt, digest: b.digest, totals: b.totals, items: b.items, excluded: b.excluded, truncated: b.truncated || 0 };
  }

  // Successful = provider receipt. Queued is never reported as success.
  async function bulkStatus(batchId) {
    const b = await batches.findOne({ _id: String(batchId) });
    if (!b) return { ok: false, reason: 'batch_not_found' };
    const groups = { succeeded: [], failed: [], held: [], queued: [] };
    for (const x of b.excluded) groups.held.push({ ...x, stage: 'not_included' });
    if (b.state === 'previewed') return { ok: true, ...publicBatch(b), groups: { ...groups, notConfirmed: b.items.length } };
    const keys = (b.results || []).filter(r => r.key).map(r => r.key);
    const jobs = keys.length ? await queue.find({ key: { $in: keys } }, { projection: { claim: 0, providerAttemptClaim: 0 } }).toArray() : [];
    for (const r of b.results || []) {
      const item = b.items.find(i => i.draftId === r.draftId && i.channel === r.channel) || {};
      const row = { draftId: r.draftId, kind: item.kind, title: item.title, channel: r.channel, destination: item.destination, scheduledAt: r.scheduledAt };
      if (!r.ok) { groups.held.push({ ...row, stage: 'at_confirmation', reasons: [r.reason, ...r.blockers].filter(Boolean) }); continue; }
      const job = jobs.find(j => j.key === r.key);
      const status = job?.status || 'unknown';
      const out = { ...row, key: r.key, status, receipt: job?.receipt || null, lastError: job?.lastError || null, reasons: job?.blockers || [] };
      if (['published', 'accepted'].includes(status) && job?.receipt) groups.succeeded.push({ ...out, note: status === 'accepted' ? 'Accepted by the email provider; inbox delivery is not confirmed.' : 'Published; provider post ID recorded.' });
      else if (['failed', 'needs_check'].includes(status)) groups.failed.push(out);
      else if (['held', 'cancelled'].includes(status)) groups.held.push({ ...out, stage: 'before_delivery' });
      else groups.queued.push(out);
    }
    return { ok: true, ...publicBatch(b), confirmedAt: b.confirmedAt || null, groups };
  }

  async function bulkList() {
    const rows = await batches.find({}, { projection: { items: 0, excluded: 0 } }).sort({ createdAt: -1 }).limit(20).toArray();
    return { ok: true, batches: rows.map(b => ({ batchId: b._id, state: b.state, createdAt: b.createdAt, confirmedAt: b.confirmedAt || null, totals: b.totals, queued: (b.results || []).filter(r => r.ok).length, heldAtConfirmation: (b.results || []).filter(r => !r.ok).length })) };
  }

  // ---------- FEATURE 2: AUTONOMOUS MODE ----------

  async function current() { return (await settings.findOne({ _id: 'autonomous-mode' })) || { _id: 'autonomous-mode', enabled: false, version: 0, policy: null }; }

  async function savePolicy(input, owner, confirmation, source = 'owner_edit') {
    if (!owners.includes(owner)) return { ok: false, reason: 'verified_owner_required' };
    if (confirmation !== POLICY_CONFIRMATION) return { ok: false, reason: 'explicit_policy_confirmation_required' };
    const policy = normalizePolicy(input);
    const cur = await current(), version = (cur.version || 0) + 1, at = now().toISOString();
    try { await policyVersions.insertOne({ _id: 'v' + version, version, policy, policyHash: digest(policy), savedBy: owner, savedAt: at, source }); }
    catch (e) { if (e.code === 11000) return { ok: false, reason: 'policy_changed_concurrently_reload' }; throw e; }
    // Compare-and-set on the version; null also matches a settings record with no policy yet.
    let r;
    try { r = await settings.updateOne({ _id: 'autonomous-mode', version: cur.version ? cur.version : null }, { $set: { policy, version, policyHash: digest(policy), updatedBy: owner, updatedAt: at } }, { upsert: true }); }
    catch (e) { if (e.code === 11000) return { ok: false, reason: 'policy_changed_concurrently_reload' }; throw e; }
    if (!r.modifiedCount && !r.upsertedCount) return { ok: false, reason: 'policy_changed_concurrently_reload' };
    await audit.insertOne({ action: 'autonomous_policy_saved', version, source, owner, policyHash: digest(policy), at });
    return { ok: true, ...await autonomousStatus() };
  }

  async function setEnabled(enabled, owner, body = {}) {
    if (!owners.includes(owner) || typeof enabled !== 'boolean') return { ok: false, reason: 'verified_owner_required' };
    const cur = await current(), at = now().toISOString();
    if (enabled) {
      if (body.confirmation !== ENABLE_CONFIRMATION) return { ok: false, reason: 'explicit_enable_confirmation_required' };
      if (!cur.policy || body.version !== cur.version) return { ok: false, reason: 'review_current_policy_version_first' };
      if (!KINDS.some(k => cur.policy.kinds[k].enabled)) return { ok: false, reason: 'policy_authorizes_nothing' };
      if (!autoApprovalReleased) return { ok: false, reason: 'autonomous_mode_release_not_owner_approved' };
      if ((await distribution.policy()).emergencyStopped) return { ok: false, reason: 'emergency_stop_active' };
    }
    await settings.updateOne({ _id: 'autonomous-mode' }, { $set: { enabled, ...(enabled ? { activatedAt: at, enabledBy: owner, enabledVersion: cur.version } : { disabledAt: at, disabledBy: owner }) } }, { upsert: true });
    await audit.insertOne({ action: enabled ? 'autonomous_mode_enabled' : 'autonomous_mode_disabled', owner, version: cur.version, at });
    return { ok: true, ...await autonomousStatus() };
  }

  // Stops automatic approvals AND pauses all distribution. Preparation keeps running,
  // so the worker generation, connections and credentials are untouched.
  async function emergencyStop(owner) {
    if (!owners.includes(owner)) return { ok: false, reason: 'verified_owner_required' };
    const at = now().toISOString();
    await settings.updateOne({ _id: 'autonomous-mode' }, { $set: { enabled: false, emergencyStoppedAt: at, emergencyStoppedBy: owner } }, { upsert: true });
    const paused = await distribution.pause(true, owner);
    const waiting = await queue.countDocuments({ status: 'scheduled' });
    await audit.insertOne({ action: 'autonomous_emergency_stop', owner, distributionPaused: paused.ok === true, scheduledDeliveriesHeldByPause: waiting, at });
    return { ok: true, distributionPaused: paused.ok === true, scheduledDeliveriesHeldByPause: waiting, ...await autonomousStatus() };
  }

  async function rollback(version, owner) {
    if (!owners.includes(owner)) return { ok: false, reason: 'verified_owner_required' };
    const target = await policyVersions.findOne({ _id: 'v' + int(version, 1, 1e6, 0) });
    if (!target) return { ok: false, reason: 'policy_version_not_found' };
    return savePolicy(target.policy, owner, POLICY_CONFIRMATION, 'rollback_to_v' + target.version);
  }

  async function templateCatalog() {
    const rows = await col.drafts.find({ kind: { $in: KINDS } }, { projection: { kind: 1, copyVersion: 1, emailQualityVersion: 1, templateType: 1, editCount: 1, editedBy: 1, editedAt: 1, headline: 1, subject: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(500).toArray();
    const map = {};
    for (const d of rows) { const t = templateOf(d); if (!t) continue; map[t] ||= { id: t, kind: d.kind, campaigns: 0, example: clean(d.headline || d.subject, 160) }; map[t].campaigns++; }
    return Object.values(map);
  }

  async function autonomousStatus() {
    const cur = await current();
    const since = iso(+now() - DAY);
    return {
      ok: true, enabled: cur.enabled === true, version: cur.version || 0, policy: cur.policy || null, defaults: normalizePolicy({}), hardLimits: HARD_LIMITS,
      activatedAt: cur.activatedAt || null, enabledBy: cur.enabledBy || null, emergencyStoppedAt: cur.emergencyStoppedAt || null,
      releaseApproved: autoApprovalReleased, environment, distribution: await distribution.policy(),
      unsupportedChannels: UNSUPPORTED, templates: await templateCatalog(),
      versions: await policyVersions.find({}, { projection: { policy: 0 } }).sort({ version: -1 }).limit(20).toArray(),
      lastRun: await settings.findOne({ _id: 'autonomous-last-run' }, { projection: { _id: 0 } }),
      last24h: { autoApproved: await decisions.countDocuments({ state: 'distributed', autoApproved: true, at: { $gte: since } }), distributed: await decisions.countDocuments({ state: 'distributed', at: { $gte: since } }), held: await decisions.countDocuments({ state: 'held', at: { $gte: since } }) },
      recent: await decisions.find({}, { projection: { _id: 0 } }).sort({ at: -1 }).limit(50).toArray(),
    };
  }

  async function recordDecision(d, state, extra) {
    const version = contentVersion(d), at = now().toISOString();
    await decisions.updateOne({ draftId: d.id, version }, { $set: { draftId: d.id, version, kind: d.kind, title: clean(d.headline || d.subject || d.id, 200), state, at, ...extra } }, { upsert: true });
  }

  // Called by the existing scheduled worker before dispatch.
  async function tick({ trigger = 'platform_cron' } = {}) {
    const cur = await current(), startedAt = now().toISOString();
    const finish = async result => { const row = { trigger, startedAt, completedAt: now().toISOString(), policyVersion: cur.version || 0, ...result }; await settings.updateOne({ _id: 'autonomous-last-run' }, { $set: row }, { upsert: true }); return row; };
    if (!cur.enabled) return finish({ skipped: 'autonomous_mode_off' });
    if (!autoApprovalReleased) return finish({ skipped: 'autonomous_mode_release_not_owner_approved' });
    if (!cur.policy) return finish({ skipped: 'no_policy' });
    const dp = await distribution.policy();
    if (dp.paused) return finish({ skipped: dp.emergencyStopped ? 'emergency_stop_active' : 'distribution_paused' });
    const owner = cur.enabledBy;
    if (!isOwnerId(owner) || !owners.includes(owner)) return finish({ skipped: 'policy_owner_no_longer_verified' });
    const lease = crypto.randomUUID();
    const got = await settings.findOneAndUpdate({ _id: 'autonomous-lease', $or: [{ until: { $exists: false } }, { until: { $lte: startedAt } }] }, { $set: { lease, until: iso(+now() + 10 * MINUTE) } }, { upsert: true, returnDocument: 'after' }).catch(e => { if (e.code === 11000) return null; throw e; });
    if (!got || got.lease !== lease) return finish({ skipped: 'another_run_in_progress' });
    const policy = cur.policy, out = { approved: 0, queued: 0, held: 0, skippedBeforeActivation: 0 };
    try {
      const plan = makePlanner(policy.limits, policy.sendWindow);
      const kinds = KINDS.filter(k => policy.kinds[k].enabled);
      const providers = {}; for (const c of ['email', 'facebook', 'instagram']) providers[c] = await providerFor(c);
      const fresh = await candidateDrafts(kinds, { status: 'needs_owner_review', createdAt: { $gte: cur.activatedAt } }, 100);
      const approvedSince = policy.includePreviouslyApproved ? {} : { 'contentApproval.at': { $gte: cur.activatedAt } };
      const approved = await candidateDrafts(kinds, { status: 'approved', ownerApproved: true, ...approvedSince }, 100);
      const recheckAfter = iso(+now() - 6 * 60 * MINUTE);
      for (const d of [...approved, ...fresh]) {
        if (out.approved >= policy.maxAutoApprovalsPerRun) break;
        if ((await distribution.policy()).paused || !(await current()).enabled) break;
        const rule = policy.kinds[d.kind], version = contentVersion(d);
        const ownerApprovedUnchanged = d.status === 'approved' && d.ownerApproved === true && d.contentApproval?.version === version;
        const prior = await decisions.findOne({ draftId: d.id, version });
        if (prior?.state === 'distributed' || (prior?.state === 'held' && prior.at > recheckAfter)) continue;
        if (!ownerApprovedUnchanged) {
          // Never sweep up older campaigns: only work prepared after Autonomous Mode was switched on.
          if (!(Date.parse(d.createdAt) >= Date.parse(cur.activatedAt))) { out.skippedBeforeActivation++; continue; }
          if (!rule.templates.includes(templateOf(d))) { await recordDecision(d, 'held', { reasons: ['content_template_not_in_owner_policy'], template: templateOf(d) }); out.held++; continue; }
        }
        const general = await campaignBlockers(d);
        if (general.length) { await recordDecision(d, 'held', { reasons: general }); out.held++; continue; }
        const ready = [], holds = [];
        for (const channel of rule.channels) {
          const provider = providers[channel];
          const at = provider?.ready ? await plan(channel, now()) : null;
          const { blockers, payload } = await channelBlockers(d, channel, provider, at, { recontactDays: rule.recontactDays || 60 });
          if (!at && provider?.ready) blockers.push('policy_daily_limit_reached');
          if (blockers.length) holds.push({ channel, reasons: blockers }); else ready.push(describe(d, channel, payload, provider, at));
        }
        if (!ready.length) { await recordDecision(d, 'held', { reasons: [...new Set(holds.flatMap(h => h.reasons))], channels: holds }); out.held++; continue; }
        if (!ownerApprovedUnchanged) await audit.insertOne({ action: 'autonomous_policy_approval', draftId: d.id, version, template: templateOf(d), policyVersion: cur.version, onBehalfOf: owner, at: now().toISOString() });
        const keys = [];
        for (const item of ready) {
          const r = await approveAndAuthorize(item, owner, 'Autonomous Mode policy v' + cur.version);
          if (r.ok) { keys.push({ channel: item.channel, key: r.key, scheduledAt: item.scheduledAt }); out.queued++; }
          else holds.push({ channel: item.channel, reasons: [r.reason, ...(r.blockers || [])].filter(Boolean) });
        }
        if (!ownerApprovedUnchanged && (await col.drafts.findOne({ id: d.id }))?.status === 'approved') out.approved++;
        await recordDecision(d, keys.length ? 'distributed' : 'held', { autoApproved: !ownerApprovedUnchanged, policyVersion: cur.version, deliveries: keys, channelHolds: holds, reasons: keys.length ? [] : [...new Set(holds.flatMap(h => h.reasons))] });
        if (!keys.length) out.held++;
      }
    } finally {
      await settings.updateOne({ _id: 'autonomous-lease', lease }, { $unset: { lease: '', until: '' } });
    }
    return finish(out);
  }

  return { init, bulkPreview, bulkConfirm, bulkStatus, bulkList, savePolicy, setEnabled, emergencyStop, rollback, autonomousStatus, tick };
}

module.exports = { createBulkAutonomy, normalizePolicy, templateOf, BULK_CONFIRMATION, POLICY_CONFIRMATION, ENABLE_CONFIRMATION, HARD_LIMITS };
