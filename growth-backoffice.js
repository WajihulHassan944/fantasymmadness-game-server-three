'use strict';
// Back-office read models and owner actions for the isolated Growth Engine
// console. Reads and writes ONLY the dedicated fmgrowthtest collections exposed
// by the runtime. Never sends, publishes, charges, or touches production data.
const crypto = require('crypto');
const { GENRES } = require('./growth-ten-agent-discovery');
const { createRecruit, verifyPaidEntry, report: attributionReport } = require('./growth-affiliate-attribution');
const { playerLink } = require('./growth-affiliate-program');
const { safeReport } = require('./growth-unattended-controller');
const contestCampaigns = require('./growth-contest-campaigns');

const DEPARTMENTS = Object.freeze(['audience', 'marketing', 'public-relations', 'affiliate-recruitment', 'performance']);
const clean = (s, n = 200) => String(s ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ').trim().slice(0, n);
const oneLine = (s, n = 200) => clean(s, n).replace(/[\r\n]+/g, ' ');
const strip = ({ _id, ...x }) => x;
const lim = (v, d, max) => Math.min(max, Math.max(1, Number(v) || d));
const dayOf = (iso) => String(iso || '').slice(0, 10);

// ---- console sign-in ------------------------------------------------------
// GROWTH_ADMIN_PASSWORD_HASH = "scrypt$<salt base64>$<hash base64>" (64-byte key).
function hashPassword(password, salt = crypto.randomBytes(16)) {
  const key = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
function verifyPassword(password, stored) {
  const m = /^scrypt\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(String(stored || ''));
  if (!m || typeof password !== 'string' || !password) return false;
  const expected = Buffer.from(m[2], 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(m[1], 'base64'), expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function createLoginLimiter({ max = 10, windowMs = 15 * 60000, clock = Date.now } = {}) {
  const hits = new Map();
  return {
    allow(key) {
      const now = clock();
      const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (list.length >= max) { hits.set(key, list); return false; }
      list.push(now); hits.set(key, list); return true;
    },
    reset(key) { hits.delete(key); },
  };
}

function createBackoffice({ runtime, manualOnly = false }) {
  const col = runtime.collections;
  const audit = (action, details) => col.audit.insertOne({ action, ...details, at: new Date().toISOString() });

  async function prospectNames(ids) {
    const base = [...new Set(ids.map((id) => String(id).replace(/-affiliate$/, '')))];
    const rows = await col.prospects.find({ id: { $in: base } }, { projection: { id: 1, name: 1, sourceUrl: 1, genre: 1 } }).toArray();
    return new Map(rows.map((r) => [r.id, r]));
  }

  // ---- automation -----------------------------------------------------------
  async function runs({ limit } = {}) {
    return (await col.runs.find({}).sort({ createdAt: -1 }).limit(lim(limit, 50, 500)).toArray()).map(strip);
  }
  async function jobs({ state, limit } = {}) {
    const q = state ? { state: clean(state, 20) } : {};
    return (await col.jobs.find(q).sort({ dueAt: -1 }).limit(lim(limit, 60, 500)).toArray()).map(({ _id, leaseToken, ...j }) => j);
  }
  async function schedulerStatus(now = new Date()) {
    const last = await col.runs.find({ state: { $in: ['completed', 'failed'] } }).sort({ createdAt: -1 }).limit(1).next();
    const since = new Date(now.getTime() - 24 * 3600000).toISOString();
    const last24 = await col.runs.countDocuments({ createdAt: { $gte: since } });
    const lastAt = last ? Date.parse(last.finishedAt || last.createdAt) : null;
    const minutesSince = lastAt ? Math.round((now.getTime() - lastAt) / 60000) : null;
    return {
      schedulerEnabled: !manualOnly, schedule: manualOnly ? 'manual sandbox cycles only' : 'every 15 minutes', lastRunId: last?.runId || null, lastRunAt: last ? (last.finishedAt || last.createdAt) : null,
      lastRunState: last?.state || null, minutesSinceLastRun: minutesSince, runsLast24h: last24,
      healthy: !manualOnly && minutesSince !== null && minutesSince <= 35,
    };
  }

  // ---- workstreams (5 sports x 5 departments per run) ----------------------
  async function workstreams({ runId, department } = {}) {
    const recent = await col.workstreams.aggregate([
      { $group: { _id: '$runId', count: { $sum: 1 }, at: { $min: '$createdAt' } } }, { $sort: { _id: -1 } }, { $limit: 30 },
    ]).toArray();
    const chosen = runId ? clean(runId, 80) : recent[0]?._id;
    const q = { runId: chosen };
    if (department) q.functionName = clean(department, 40);
    const rows = chosen ? await col.workstreams.find(q).sort({ functionName: 1, genre: 1 }).toArray() : [];
    return {
      runs: recent.map((r) => ({ runId: r._id, workstreams: r.count, createdAt: r.at })),
      runId: chosen || null,
      workstreams: rows.map((w) => ({
        workstreamId: w.workstreamId, runId: w.runId, genre: w.genre, functionName: w.functionName, createdAt: w.createdAt,
        status: w.data?.status || null, draftCount: Array.isArray(w.data?.drafts) ? w.data.drafts.length : 0,
        verifiedProspects: Number.isInteger(w.data?.verifiedProspects) ? w.data.verifiedProspects : null,
        metrics: w.data?.metrics || null,
      })),
    };
  }
  async function workstreamDetail(runId, workstreamId) {
    const w = await col.workstreams.findOne({ runId: clean(runId, 80), workstreamId: clean(workstreamId, 120) });
    if (!w) return null;
    const drafts = Array.isArray(w.data?.drafts) ? w.data.drafts : [];
    const names = await prospectNames(drafts.map((d) => d.prospectId).filter(Boolean));
    return {
      workstreamId: w.workstreamId, runId: w.runId, genre: w.genre, functionName: w.functionName, createdAt: w.createdAt, status: w.data?.status || null,
      verifiedProspects: w.data?.verifiedProspects ?? null, metrics: w.data?.metrics || null,
      drafts: drafts.map((d) => {
        const p = d.prospectId ? names.get(String(d.prospectId).replace(/-affiliate$/, '')) : null;
        return {
          prospectId: d.prospectId ? String(d.prospectId).replace(/-affiliate$/, '') : null, prospectName: p?.name || null, sourceUrl: d.sourceUrl || p?.sourceUrl || null,
          title: d.title || null, subject: d.template?.subject || null, text: d.template?.text || null, html: d.template?.html || null,
          status: d.status || null, sent: d.sent === true, published: d.published === true,
        };
      }),
    };
  }

  // ---- campaign approvals: safe edits + manual publishing record -----------
  async function editDraft(id, { headline, text, subject, admin, now = new Date() } = {}) {
    const set = {};
    if (headline !== undefined) { if (!oneLine(headline, 180)) return { ok: false, reason: 'headline_required' }; set.headline = oneLine(headline, 180); }
    if (text !== undefined) { if (!clean(text, 4000)) return { ok: false, reason: 'text_required' }; set.text = clean(text, 4000); }
    if (subject !== undefined) { if (!oneLine(subject, 200)) return { ok: false, reason: 'subject_required' }; set.subject = oneLine(subject, 200); }
    if (!Object.keys(set).length) return { ok: false, reason: 'nothing_to_change' };
    const current = await col.drafts.findOne({ id: clean(id, 160) });
    if (!current) return { ok: false, reason: 'not_found' };
    if (current.status !== 'needs_owner_review') return { ok: false, reason: 'only_drafts_awaiting_review_can_be_edited' };
    // Emails: edited text replaces the plain part; the HTML part is regenerated
    // from the edited text so both stay consistent (escaped, no markup injection).
    if (set.text && current.html) {
      const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      set.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body style="margin:0;padding:24px 12px;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif"><div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e4e5e8;padding:28px;color:#30333a;font-size:15px;line-height:1.6">${set.text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}</div></body></html>`;
    }
    // Marketing edits must still describe the verified fight: names, link, no
    // prizes/money, no media names. The caption edit applies to Instagram and Facebook.
    if (current.kind === 'marketing') {
      if (!current.contestId || !current.contest) return { ok: false, reason: 'not_based_on_a_verified_contest' };
      // The edited caption is used for Instagram and Facebook; each keeps its own campaign tags.
      if (set.text) {
        set.posts = { ...(current.posts || {}), instagram: contestCampaigns.tagCampaignLinks(set.text, current.contest, 'instagram'), facebook: contestCampaigns.tagCampaignLinks(set.text, current.contest, 'facebook') };
        set.text = set.posts.instagram;
      }
      const rows = await col.prospects.find({}, { projection: { name: 1 } }).toArray();
      const mediaNames = new Set(rows.map((r) => contestCampaigns.norm(r.name)).filter((n) => n.length >= 4));
      const reasons = contestCampaigns.checkCampaign({ ...current, ...set }, current.contest, { now, mediaNames });
      if (reasons.length) return { ok: false, reason: 'edit_failed_safeguard', details: reasons };
    }
    set.editedBy = clean(admin, 120); set.editedAt = now.toISOString();
    const r = await col.drafts.findOneAndUpdate({ id: current.id, status: 'needs_owner_review' }, { $set: set, $inc: { editCount: 1 } }, { returnDocument: 'after' });
    if (!r) return { ok: false, reason: 'only_drafts_awaiting_review_can_be_edited' };
    await audit('edit_draft', { id: r.id, admin: clean(admin, 120), fields: Object.keys(set).filter((k) => !['editedBy', 'editedAt'].includes(k)) });
    return { ok: true, draft: strip(r) };
  }
  // Marketing posts are published by the owner in the social accounts (no
  // social-posting provider exists). This only records that it was done.
  async function markPublished(id, { postUrl = '', admin, now = new Date() } = {}) {
    const url = oneLine(postUrl, 500);
    if (url && !/^https:\/\//i.test(url)) return { ok: false, reason: 'post_link_must_start_with_https' };
    const r = await col.drafts.findOneAndUpdate({ id: clean(id, 160), kind: 'marketing', status: 'approved', contestId: { $exists: true } }, { $set: { status: 'published', publishedManually: true, postUrl: url || null, publishedBy: clean(admin, 120), publishedAt: now.toISOString() } }, { returnDocument: 'after' });
    if (!r) return { ok: false, reason: 'only_approved_marketing_posts_can_be_marked_published' };
    await audit('mark_published', { id: r.id, admin: clean(admin, 120) });
    return { ok: true, draft: strip(r) };
  }

  // ---- analytics -------------------------------------------------------------
  async function analytics(now = new Date()) {
    const group = async (c, id, match = {}) => (await c.aggregate([{ $match: match }, { $group: { _id: id, n: { $sum: 1 } } }]).toArray());
    const draftRows = await group(col.drafts, { kind: '$kind', status: '$status', genre: '$genre' });
    const drafts = { byKind: {}, byStatus: {}, byGenreKind: {} };
    for (const r of draftRows) {
      const { kind = 'unknown', status = 'unknown', genre = 'unknown' } = r._id || {};
      drafts.byKind[kind] = (drafts.byKind[kind] || 0) + r.n;
      drafts.byStatus[status] = (drafts.byStatus[status] || 0) + r.n;
      drafts.byGenreKind[genre] = drafts.byGenreKind[genre] || {};
      drafts.byGenreKind[genre][kind] = (drafts.byGenreKind[genre][kind] || 0) + r.n;
    }
    const total = Object.values(drafts.byKind).reduce((a, b) => a + b, 0);
    const decided = (drafts.byStatus.approved || 0) + (drafts.byStatus.delivered || 0) + (drafts.byStatus.published || 0) + (drafts.byStatus.rejected || 0) + (drafts.byStatus.suppressed || 0) + (drafts.byStatus.delivery_failed || 0);
    const approvedish = decided - (drafts.byStatus.rejected || 0);
    const prospectRows = await group(col.prospects, { genre: '$genre', focus: '$focus' });
    const prospects = { total: 0, byGenre: {}, withVerifiedContact: await col.prospects.countDocuments({ contactVerified: true }) };
    for (const r of prospectRows) {
      const g = r._id?.genre || 'unknown'; const f = r._id?.focus || 'unknown';
      prospects.byGenre[g] = prospects.byGenre[g] || { fans: 0, partners: 0 };
      prospects.byGenre[g][f] = (prospects.byGenre[g][f] || 0) + r.n; prospects.total += r.n;
    }
    const latest = await workstreams({});
    const matrix = {};
    for (const d of DEPARTMENTS) matrix[d] = Object.fromEntries(GENRES.map((g) => [g, null]));
    for (const w of latest.workstreams) if (matrix[w.functionName]) matrix[w.functionName][w.genre] = w.functionName === 'audience' ? w.verifiedProspects : w.functionName === 'performance' ? (Number.isInteger(w.metrics?.drafted) ? w.metrics.drafted : 0) : w.draftCount;
    const since = new Date(now.getTime() - 7 * 86400000).toISOString();
    const runRows = await col.runs.find({ createdAt: { $gte: since } }, { projection: { createdAt: 1, state: 1 } }).toArray();
    const runsByDay = {};
    for (const r of runRows) { const d = dayOf(r.createdAt); runsByDay[d] = runsByDay[d] || { completed: 0, failed: 0, stale: 0, claimed: 0 }; runsByDay[d][r.state] = (runsByDay[d][r.state] || 0) + 1; }
    const reports = (await col.reports.find({}).sort({ day: -1 }).limit(14).toArray()).map(strip).reverse();
    const firstProspect = await col.prospects.find({}).sort({ firstSeenAt: 1 }).limit(1).next();
    const newByDay = (await col.prospects.aggregate([{ $group: { _id: { $substr: ['$firstSeenAt', 0, 10] }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }, { $limit: 60 }]).toArray()).map((r) => ({ day: r._id, newProspects: r.n }));
    return {
      generatedAt: now.toISOString(),
      drafts: { ...drafts, total, decided, approvalRate: decided ? Math.round((approvedish / decided) * 100) : null },
      prospects: { ...prospects, firstSeenAt: firstProspect?.firstSeenAt || null, newByDay },
      workstreams: { runId: latest.runId, total: latest.workstreams.length, matrix, departments: DEPARTMENTS, genres: GENRES },
      runs: { last7Days: runRows.length, byDay: Object.entries(runsByDay).sort().map(([day, v]) => ({ day, ...v })) },
      deliveries: { real: await col.deliveries.countDocuments({ realDelivery: true }), total: await col.deliveries.countDocuments() },
      reports,
    };
  }

  // ---- revenue attribution ---------------------------------------------------
  // Credits revenue ONLY from server-verified, settled paid-entry events stored
  // in the isolated database. Nothing here reads or writes the live payment
  // system; no events means $0 credited, never an estimate.
  async function attribution() {
    const all = (await col.attribution.find({}).sort({ at: 1 }).limit(5000).toArray()).map(strip);
    const events = all.filter((e) => e.synthetic !== true); // real lane only
    // Only affiliates who joined the live program (owner-linked live affiliate ID) earn credit.
    const rows = await col.affiliates.find({ status: { $in: ['active', 'paused'] }, synthetic: { $ne: true } }).toArray();
    const affiliates = new Map();
    for (const a of rows) { try { affiliates.set(a.id, { ...createRecruit({ id: a.id, name: a.name, consent: true, approved: true }), genre: a.genre, code: a.code, liveAffiliateId: a.liveAffiliateId, lifecycle: a.status }); } catch { /* skip */ } }
    const entries = new Map(); const rejected = {};
    for (const e of events.filter((x) => x.type === 'paid_entry')) {
      const r = verifyPaidEntry(e, { affiliates, entries });
      if (!r.credited) rejected[r.reason] = (rejected[r.reason] || 0) + 1;
    }
    const totals = attributionReport(entries);
    const byGenre = {};
    for (const e of entries.values()) { const g = affiliates.get(e.affiliateId)?.genre || 'unknown'; byGenre[g] = byGenre[g] || { paidEntries: 0, revenueCents: 0 }; byGenre[g].paidEntries++; byGenre[g].revenueCents += e.amountCents; }
    const contests = await activeContests();
    return {
      paymentSource: { connected: events.some((e) => e.source === 'signed_ingest' && e.type === 'paid_entry'), note: 'Revenue is credited only from server-verified, settled paid-entry events (signed by a trusted server). Live payments are never read or changed from here.' },
      eventsRecorded: events.length,
      funnel: safeReport(events.map((e) => (e.type === 'registration' ? { ...e, type: 'signup' } : e))),
      affiliates: [...affiliates.values()].map((a) => {
        const t = totals[a.id] || { paidEntries: 0, revenueCents: 0 };
        const c = contests.find((x) => x.sport === a.genre) || contests[0];
        return { id: a.id, name: a.name, genre: a.genre, status: a.lifecycle === 'active' ? 'approved' : a.lifecycle, code: a.code, trackingLink: c ? playerLink({ status: a.lifecycle, liveAffiliateId: a.liveAffiliateId, code: a.code }, c) : null, trackingLinkFight: c ? `${c.fighterA} vs ${c.fighterB}` : null, ...t };
      }),
      byGenre: GENRES.map((g) => ({ genre: g, ...(byGenre[g] || { paidEntries: 0, revenueCents: 0 }) })),
      totalRevenueCents: [...entries.values()].reduce((n, e) => n + e.amountCents, 0),
      creditedEntries: entries.size,
      payingPlayers: new Set([...entries.values()].map((e) => e.playerId)).size,
      rejectedEvents: rejected,
      synthetic: await syntheticLane(all.filter((e) => e.synthetic === true)),
    };
  }

  // Synthetic test lane (staging): click -> registration -> settled TEST payment -> accepted
  // entry -> one affiliate credit. Same verification rules as real credit, plus the entry must
  // have been accepted. Never mixed into real totals.
  async function syntheticLane(events) {
    const synAff = new Map();
    for (const a of await col.affiliates.find({ synthetic: true }).toArray()) synAff.set(a.id, { ...createRecruit({ id: a.id, name: a.name, consent: true, approved: true }), code: a.code });
    const accepted = new Set(events.filter((e) => e.type === 'entry_accepted').map((e) => e.entryId));
    const entries = new Map(); const rejected = {};
    for (const e of events.filter((x) => x.type === 'paid_entry')) {
      if (e.paymentMode !== 'test') { rejected.not_a_test_payment = (rejected.not_a_test_payment || 0) + 1; continue; }
      const r = verifyPaidEntry(e, { affiliates: synAff, entries });
      if (!r.credited) { rejected[r.reason] = (rejected[r.reason] || 0) + 1; continue; }
      if (!accepted.has(e.entryId)) { entries.delete(e.entryId); rejected.entry_not_accepted = (rejected.entry_not_accepted || 0) + 1; }
    }
    const n = (t) => events.filter((e) => e.type === t).length;
    return {
      note: 'Synthetic staging test journeys only (event IDs syn_…). Not real players, payments or affiliate credit; excluded from every real total.',
      steps: { clicks: n('click'), registrations: n('registration'), settledTestPayments: events.filter((e) => e.type === 'paid_entry' && e.paymentStatus === 'settled' && e.paymentMode === 'test').length, acceptedEntries: accepted.size, affiliateCredits: entries.size },
      credits: [...entries.values()].map((e) => ({ entryId: e.entryId, affiliateId: e.affiliateId, playerId: e.playerId, fightId: e.fightId, amountCents: e.amountCents })),
      rejected,
    };
  }

  async function activeContests() {
    const ds = await col.drafts.find({ kind: 'marketing', contestId: { $exists: true }, status: { $in: ['needs_owner_review', 'approved', 'published'] } }, { projection: { contest: 1 } }).toArray();
    const seen = new Map(); for (const d of ds) if (d.contest && !seen.has(d.contest.id)) seen.set(d.contest.id, d.contest);
    return [...seen.values()].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  }

  // Campaign funnel. Each stage is counted from its own evidence and labelled with its source.
  async function funnel() {
    const count = (c, q) => c.countDocuments(q);
    const approvedStatuses = ['approved', 'published', 'delivered'];
    const kinds = ['marketing', 'pr', 'affiliate'];
    const approved = {}; for (const k of kinds) approved[k] = await count(col.drafts, { kind: k, ownerApproved: true, status: { $in: approvedStatuses } });
    const socialReal = await count(col.social, { status: 'published', sandbox: { $ne: true } });
    const socialSandbox = await count(col.social, { status: 'published', sandbox: true });
    const manual = await count(col.drafts, { kind: 'marketing', status: 'published', publishedManually: true });
    const regEvents = await count(col.attribution, { type: 'registration', verified: true, source: 'signed_ingest', synthetic: { $ne: true } });
    const live = await col.liveReports.find({}).sort({ day: -1 }).limit(1).next();
    const liveRegs = live ? live.groups.reduce((n, g) => n + g.registrations, 0) : 0;
    const att = await attribution();
    const aff = {}; for (const st of ['invite_prepared', 'invited', 'active', 'paused', 'declined']) aff[st] = await count(col.affiliates, { status: st, synthetic: { $ne: true } });
    return {
      stages: [
        { key: 'prospects', label: 'Discovered prospects', value: await count(col.prospects, {}), source: 'Public discovery (podcasts, shows, creators)' },
        { key: 'researched', label: 'Researched shows', value: await count(col.prospects, { researchedAt: { $exists: true } }), detail: { verifiedPublishedContacts: await count(col.prospects, { contactSource: { $exists: true } }) }, source: 'Each show’s own public feed (Apple Podcasts lookup + RSS)' },
        { key: 'drafted', label: 'Personalized drafts', value: await count(col.drafts, { autoResearched: true }), detail: { pr: await count(col.drafts, { autoResearched: true, kind: 'pr' }), affiliate: await count(col.drafts, { autoResearched: true, kind: 'affiliate' }), awaitingApproval: await count(col.drafts, { kind: { $in: ['pr', 'affiliate'] }, status: 'needs_owner_review' }) }, source: 'Research-backed drafts (verified contact + evidence)' },
        { key: 'approved', label: 'Approved content', value: approved.marketing + approved.pr + approved.affiliate, detail: approved, source: 'Owner approvals in this console' },
        { key: 'published', label: 'Published posts', value: socialReal + manual, detail: { scheduler: socialReal, markedByOwner: manual, sandboxSimulated: socialSandbox }, source: socialReal ? 'Channel receipts + owner records' : 'Owner records (simulated sandbox posts are not counted)' },
        { key: 'emails', label: 'Outreach emails delivered', value: await count(col.deliveries, { status: 'delivered', realDelivery: true }), detail: { sandboxCaptured: await count(col.deliveries, { status: 'delivered', realDelivery: { $ne: true } }) }, source: 'Email provider receipts (real sending is off; sandbox captures are not counted)' },
        { key: 'registrations', label: 'Registrations', value: regEvents + liveRegs, detail: { signedEvents: regEvents, liveSiteReport: liveRegs }, source: regEvents || live ? 'Verified by the live site' : 'Not connected yet' , connected: Boolean(regEvents || live) },
        { key: 'paying', label: 'Verified paying players', value: att.payingPlayers, detail: { creditedEntries: att.creditedEntries, revenueCents: att.totalRevenueCents }, source: att.paymentSource.connected ? 'Server-verified settled payments' : 'Not connected yet', connected: att.paymentSource.connected },
      ],
      affiliates: aff,
      liveReportDay: live?.day || null,
    };
  }

  async function marketingCoverage() {
    const latest = await col.coverage.find({}).sort({ day: -1 }).limit(1).next();
    const blocked = (await col.gateRejections.find({}).sort({ at: -1 }).limit(20).toArray()).map(strip);
    return { latest: latest ? strip(latest) : null, recentlyBlocked: blocked, sports: contestCampaigns.SPORTS, horizonNote: 'Campaigns are prepared only for published, open FANTASY MMADNESS contests in the next few weeks.' };
  }

  async function reports({ limit } = {}) { return (await col.reports.find({}).sort({ day: -1 }).limit(lim(limit, 30, 365)).toArray()).map(strip); }
  async function auditLog({ limit } = {}) { return (await col.audit.find({}).sort({ at: -1 }).limit(lim(limit, 100, 500)).toArray()).map(strip); }
  async function suppressions({ limit } = {}) {
    return (await col.suppressions.find({}).sort({ createdAt: -1 }).limit(lim(limit, 100, 500)).toArray()).map(({ _id, ...s }) => s);
  }

  return { funnel, activeContests, marketingCoverage, runs, jobs, schedulerStatus, workstreams, workstreamDetail, editDraft, markPublished, analytics, attribution, reports, auditLog, suppressions };
}

module.exports = { createBackoffice, hashPassword, verifyPassword, createLoginLimiter, DEPARTMENTS };
