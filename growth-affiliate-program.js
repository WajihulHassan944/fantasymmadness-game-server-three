'use strict';
// Affiliate onboarding + referral attribution for the isolated Growth Engine.
//
// Lifecycle:  invite_prepared -> invited -> active  (or declined / paused)
//   invite_prepared  the owner approved a personalized invitation
//   invited          the invitation went out (email delivery) or the owner sent it personally
//   active           the creator joined the LIVE affiliate program and the owner linked
//                    their live affiliate ID (the live site's own referral system then
//                    credits their players; nothing here touches it or payments)
// Links use the live site's existing mechanisms only:
//   - onboarding:  /affiliate-create-account  + fan_acquisition campaign tags
//   - player link: the fight's address (fighter-name address from the website, else /fight/<id>)
//                  + ?play=1&ref=<live affiliate id> + fan_acquisition campaign tags
// Verified results arrive two ways, both read-only for production:
//   - signed events (HMAC) posted to /api/growth/events by a trusted server
//   - optional daily pull of the live registration report (read-only token)
const crypto = require('crypto');

const SITE = 'https://www.fantasymmadness.com';
const STATUSES = ['invite_prepared', 'invited', 'active', 'paused', 'declined'];
const clean = (s, n = 200) => String(s ?? '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, n);
const slug = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20) || 'creator';
const codeFor = (id, name) => `aff_${slug(name)}_${crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 4)}`;
const campaignFor = (code) => `combat_fans_${code}`; // matches the live site's registration capture

function tags(code, content) {
  const q = new URLSearchParams({ utm_source: 'fan_acquisition', utm_medium: 'partner_outreach', utm_campaign: campaignFor(code) });
  if (content) q.set('utm_content', String(content).replace(/[^a-z0-9_-]/gi, '').slice(0, 32));
  return q.toString();
}
function onboardingLink(a) { return `${SITE}/auth?mode=signup&role=affiliate&${tags(a.code, 'onboarding')}`; }
function playerLink(a, contest) {
  if (a.status !== 'active' || !/^[a-f0-9]{24}$/.test(String(a.liveAffiliateId || ''))) return null;
  // The website's fighter-name address when it has one (growth-fight-urls.js), else the ID address.
  const path = contest.cleanUrl || (contest.sport === 'pro-wrestling' ? `${SITE}/pro-wrestling/play/${encodeURIComponent(contest.id)}` : `${SITE}/fight/${encodeURIComponent(contest.id)}`);
  const base = contest.sport === 'pro-wrestling' ? `${path}?` : `${path}?play=1&`;
  return `${base}ref=${a.liveAffiliateId}&${tags(a.code, contest.sport)}`;
}

function verifySignature({ secret, rawBody, timestamp, signature, now = Date.now() }) {
  if (!secret || secret.length < 32) return { ok: false, reason: 'ingest_not_configured' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 5 * 60000) return { ok: false, reason: 'stale_or_missing_timestamp' };
  const expected = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const got = String(signature || '').replace(/^sha256=/, '');
  if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

function createAffiliateProgram({ col, audit }) {
  const strip = ({ _id, ...x }) => x;
  async function init() {
    await col.affiliates.createIndex({ id: 1 }, { unique: true });
    await col.affiliates.createIndex({ code: 1 }, { unique: true });
    await col.attribution.createIndex({ eventId: 1 }, { unique: true, partialFilterExpression: { eventId: { $type: 'string' } } });
  }
  const hist = (status, by, note, now) => ({ at: now.toISOString(), status, by: clean(by, 120), note: clean(note, 200) || undefined });

  // Called when the owner approves an affiliate invitation.
  async function fromApprovedInvite(draft, { admin, now = new Date() } = {}) {
    if (draft.kind !== 'affiliate' || !draft.prospectId) return null;
    const p = await col.prospects.findOne({ id: draft.prospectId }) || (col.recruitment ? await col.recruitment.findOne({id:draft.prospectId}) : null);
    const name = p?.name || draft.prospectId;
    const doc = { id: draft.prospectId, name, genre: draft.genre, email: draft.recipient || null, code: codeFor(draft.prospectId, name), status: 'invite_prepared', inviteDraftId: draft.id, liveAffiliateId: null, createdAt: now.toISOString(), history: [hist('invite_prepared', admin, 'invitation approved', now)] };
    await col.affiliates.updateOne({ id: doc.id }, { $setOnInsert: doc }, { upsert: true });
    return col.affiliates.findOne({ id: doc.id });
  }
  async function transition(id, to, { admin, note, liveAffiliateId, now = new Date() } = {}) {
    const a = await col.affiliates.findOne({ id: clean(id, 80) });
    if (!a) return { ok: false, reason: 'affiliate_not_found' };
    if (!STATUSES.includes(to)) return { ok: false, reason: 'invalid_status' };
    const allowed = { invite_prepared: ['invited', 'declined'], invited: ['active', 'declined'], active: ['paused'], paused: ['active', 'declined'], declined: [] };
    if (!allowed[a.status].includes(to)) return { ok: false, reason: `cannot_change_${a.status}_to_${to}` };
    const set = { status: to, updatedAt: now.toISOString() };
    if (to === 'active') {
      const live = clean(liveAffiliateId || a.liveAffiliateId, 40).toLowerCase();
      if (!/^[a-f0-9]{24}$/.test(live)) return { ok: false, reason: 'live_affiliate_id_required' };
      const dup = await col.affiliates.findOne({ liveAffiliateId: live, id: { $ne: a.id } });
      if (dup) return { ok: false, reason: 'live_affiliate_id_already_linked' };
      set.liveAffiliateId = live; set.activatedAt = set.activatedAt || now.toISOString();
    }
    const r = await col.affiliates.findOneAndUpdate({ id: a.id, status: a.status }, { $set: set, $push: { history: hist(to, admin, note, now) } }, { returnDocument: 'after' });
    if (!r) return { ok: false, reason: 'changed_by_someone_else_refresh' };
    await audit(`affiliate_${to}`, { id: a.id, admin: clean(admin, 120) });
    return { ok: true, affiliate: strip(r) };
  }
  async function list(contests = []) {
    const rows = (await col.affiliates.find({ synthetic: { $ne: true } }).sort({ createdAt: -1 }).limit(500).toArray()).map(strip);
    return rows.map((a) => ({ ...a, onboardingLink: onboardingLink(a), campaign: campaignFor(a.code), playerLinks: contests.filter((c) => !a.genre || c.sport === a.genre).slice(0, 5).map((c) => ({ contestId: c.id, label: `${c.fighterA} vs ${c.fighterB}`, link: playerLink(a, c) })).filter((x) => x.link) }));
  }

  // ---- verified events (signed) ----
  async function ingest(body, { now = new Date() } = {}) {
    const e = body && typeof body === 'object' ? body : {};
    const eventId = clean(e.eventId, 80);
    if (!/^[A-Za-z0-9:_-]{8,80}$/.test(eventId)) return { ok: false, reason: 'event_id_required' };
    if (!['registration', 'paid_entry', 'visit', 'click', 'entry_accepted'].includes(e.type)) return { ok: false, reason: 'unknown_event_type' };
    const playerRef = clean(e.playerRef, 80);
    if (!['visit', 'click'].includes(e.type) && !/^[A-Za-z0-9_-]{6,80}$/.test(playerRef)) return { ok: false, reason: 'player_ref_required (an opaque id, never personal data)' };
    if (e.type === 'entry_accepted' && !clean(e.entryId, 80)) return { ok: false, reason: 'entry_id_required' };
    // Synthetic test journeys (staging): event IDs start with "syn_". They are stored in their
    // own lane and never counted as real registrations, payments or affiliate credit.
    const synthetic = eventId.startsWith('syn_');
    const identities=e.liveAffiliateId?await col.affiliates.find({liveAffiliateId:clean(e.liveAffiliateId,40).toLowerCase()}).limit(2).toArray():[];
    if(identities.length>1)return{ok:false,reason:'ambiguous_affiliate_identity'};
    const byIdentity=identities[0]||null;
    const byCampaign=e.campaign?await col.affiliates.findOne({code:clean(e.campaign,80).replace(/^combat_fans_/,'')}):null;
    if(e.liveAffiliateId&&!byIdentity)return{ok:false,reason:'unknown_affiliate_identity'};
    if(byIdentity&&byCampaign&&byIdentity.id!==byCampaign.id)return{ok:false,reason:'affiliate_campaign_identity_mismatch'};
    const affiliate=byIdentity||byCampaign;
    if(e.referralAffiliateId&&(!affiliate||![affiliate.id,affiliate.liveAffiliateId].includes(e.referralAffiliateId)))return{ok:false,reason:'referral_identity_mismatch'};
    const doc = {
      eventId, type: e.type, verified: true, source: 'signed_ingest', at: new Date(e.occurredAt || now).toISOString(), receivedAt: now.toISOString(),
      playerId: playerRef || null, campaign: clean(e.campaign, 80) || null, channel: clean(e.channel, 20) || null,
      affiliateId: affiliate?.id || null, referralAffiliateId: affiliate?.id || null,
    };
    if (synthetic) Object.assign(doc, { synthetic: true });
    if (affiliate?.synthetic && !synthetic) return { ok: false, reason: 'synthetic_affiliate_is_test_only' };
    if (e.type === 'paid_entry') Object.assign(doc, { entryId: clean(e.entryId, 80) || null, fightId: clean(e.fightId, 80) || null, amountCents: Number(e.amountCents), paymentStatus: clean(e.paymentStatus, 20), paymentMode: clean(e.paymentMode, 10) || null });
    if (e.type === 'entry_accepted') Object.assign(doc, { entryId: clean(e.entryId, 80), fightId: clean(e.fightId, 80) || null });
    if (e.type === 'click') Object.assign(doc, { fightId: clean(e.fightId, 80) || null });
    try { await col.attribution.insertOne(doc); } catch (err) { if (err && err.code === 11000) return { ok: true, duplicate: true }; throw err; }
    return { ok: true, attributedTo: affiliate?.id || null };
  }

  return { init, fromApprovedInvite, transition, list, ingest };
}

module.exports = { createAffiliateProgram, verifySignature, onboardingLink, playerLink, codeFor, campaignFor, STATUSES };
