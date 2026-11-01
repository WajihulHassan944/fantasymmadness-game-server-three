'use strict';
// Back-office read models and owner actions for the isolated Growth Engine
// console. Reads and writes ONLY the dedicated fmgrowthtest collections exposed
// by the runtime. Never sends, publishes, charges, or touches production data.
const crypto = require('crypto');
const { GENRES } = require('./growth-ten-agent-discovery');
const { createRecruit, makeLink, verifyPaidEntry, report: attributionReport } = require('./growth-affiliate-attribution');
const { safeReport } = require('./growth-unattended-controller');

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

function createBackoffice({ runtime }) {
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
      schedule: 'every 15 minutes', lastRunId: last?.runId || null, lastRunAt: last ? (last.finishedAt || last.createdAt) : null,
      lastRunState: last?.state || null, minutesSinceLastRun: minutesSince, runsLast24h: last24,
      healthy: minutesSince !== null && minutesSince <= 35,
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
    const r = await col.drafts.findOneAndUpdate({ id: clean(id, 160), kind: 'marketing', status: 'approved' }, { $set: { status: 'published', publishedManually: true, postUrl: url || null, publishedBy: clean(admin, 120), publishedAt: now.toISOString() } }, { returnDocument: 'after' });
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
    for (const w of latest.workstreams) if (matrix[w.functionName]) matrix[w.functionName][w.genre] = w.functionName === 'audience' ? w.verifiedProspects : w.draftCount;
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
    const evCol = col.attribution;
    const events = evCol ? (await evCol.find({}).sort({ at: 1 }).limit(5000).toArray()).map(strip) : [];
    // Affiliates eligible for tracked links: verified contact + consent and an
    // owner-approved (or delivered) affiliate invitation.
    const approvedInvites = await col.drafts.find({ kind: 'affiliate', status: { $in: ['approved', 'delivered'] } }).toArray();
    const prospectIds = [...new Set(approvedInvites.map((d) => d.prospectId).filter(Boolean))];
    const pmap = await prospectNames(prospectIds);
    const affiliates = new Map();
    for (const pid of prospectIds) {
      const p = await col.prospects.findOne({ id: pid });
      if (!p) continue;
      try { affiliates.set(pid, { ...createRecruit({ id: pid, name: p.name, consent: p.consent === true, approved: p.contactVerified === true }), genre: p.genre }); } catch { /* skip */ }
    }
    const entries = new Map(); const rejected = {};
    for (const e of events.filter((x) => x.type === 'paid_entry')) {
      const r = verifyPaidEntry(e, { affiliates, entries });
      if (!r.credited) rejected[r.reason] = (rejected[r.reason] || 0) + 1;
    }
    const totals = attributionReport(entries);
    const byGenre = {};
    for (const e of entries.values()) { const g = affiliates.get(e.affiliateId)?.genre || 'unknown'; byGenre[g] = byGenre[g] || { paidEntries: 0, revenueCents: 0 }; byGenre[g].paidEntries++; byGenre[g].revenueCents += e.amountCents; }
    const funnel = safeReport(events);
    return {
      paymentSource: { connected: false, note: 'Live payments are not connected to staging. Revenue is credited only from verified, settled paid-entry events recorded in fmgrowthtest.' },
      eventsRecorded: events.length,
      funnel,
      affiliates: [...affiliates.values()].map((a) => {
        const t = totals[a.id] || { paidEntries: 0, revenueCents: 0 };
        let link = null; try { link = makeLink(a, 'next-event'); } catch { link = null; }
        return { id: a.id, name: pmap.get(a.id)?.name || a.name, genre: a.genre, status: a.status, trackingLink: link, ...t };
      }),
      byGenre: GENRES.map((g) => ({ genre: g, ...(byGenre[g] || { paidEntries: 0, revenueCents: 0 }) })),
      totalRevenueCents: [...entries.values()].reduce((n, e) => n + e.amountCents, 0),
      creditedEntries: entries.size,
      rejectedEvents: rejected,
    };
  }

  async function reports({ limit } = {}) { return (await col.reports.find({}).sort({ day: -1 }).limit(lim(limit, 30, 365)).toArray()).map(strip); }
  async function auditLog({ limit } = {}) { return (await col.audit.find({}).sort({ at: -1 }).limit(lim(limit, 100, 500)).toArray()).map(strip); }
  async function suppressions({ limit } = {}) {
    return (await col.suppressions.find({}).sort({ createdAt: -1 }).limit(lim(limit, 100, 500)).toArray()).map(({ _id, ...s }) => s);
  }

  return { runs, jobs, schedulerStatus, workstreams, workstreamDetail, editDraft, markPublished, analytics, attribution, reports, auditLog, suppressions };
}

module.exports = { createBackoffice, hashPassword, verifyPassword, createLoginLimiter, DEPARTMENTS };
