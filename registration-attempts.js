'use strict';

// Registration attempt tracking (admin only).
//
// Records every player / creator sign-up attempt: when it happened, whether it
// worked, and why it failed. It never changes the sign-up itself and never
// stores passwords, verification tokens or any other credential.
//
// What is stored per attempt:
//   at, kind (player|creator), source (server|browser), result, reason,
//   HTTP status, email (lower-cased) when appropriate, a keyed hash of the email,
//   a keyed hash of the IP address (never the raw IP), whether an affiliate
//   referral was present.
// Safeguards:
//   * Records delete themselves after RETENTION_DAYS (database TTL index).
//   * Rate-limited/abusive traffic is counted but its email is NOT stored.
//   * Per-visitor cap on stored records; extra attempts are only counted.
//   * Browser reports are limited, validated and marked "unverified".
//   * Read access is admin-only.

const crypto = require('crypto');
const mongoose = require('mongoose');

const RETENTION_DAYS = 180;
const ZONE = 'America/New_York';
const TRACKED = { '/register': 'player', '/registerAffiliate': 'creator' };
const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,24}$/i;
const PER_VISITOR_LIMIT = 20;            // stored records per visitor per window
const PER_VISITOR_WINDOW_MS = 10 * 60 * 1000;
const CLIENT_LIMIT = 6;                  // browser reports per visitor per window

const schema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  kind: { type: String, enum: ['player', 'creator'], default: 'player' },
  source: { type: String, enum: ['server', 'browser'], default: 'server' },
  result: { type: String, enum: ['success', 'failed', 'blocked'], required: true },
  reason: { type: String, maxlength: 60 },
  status: Number,
  email: { type: String, maxlength: 254 },
  emailHash: { type: String, maxlength: 64, index: true },
  visitorHash: { type: String, maxlength: 64, index: true },
  withReferral: { type: Boolean, default: false },
}, { versionKey: false });
schema.index({ at: -1 });
schema.index({ at: 1 }, { expireAfterSeconds: RETENTION_DAYS * 24 * 60 * 60, name: 'retention_ttl' });
const Attempt = mongoose.models.RegistrationAttempt || mongoose.model('RegistrationAttempt', schema, 'registration_attempts');

const overflowSchema = new mongoose.Schema({ hour: { type: String, unique: true }, suppressed: { type: Number, default: 0 }, at: { type: Date, default: Date.now } }, { versionKey: false });
overflowSchema.index({ at: 1 }, { expireAfterSeconds: RETENTION_DAYS * 24 * 60 * 60 });
const Overflow = mongoose.models.RegistrationAttemptOverflow || mongoose.model('RegistrationAttemptOverflow', overflowSchema, 'registration_attempt_overflow');

const key = () => String(process.env.JWT_SECRET_ADMIN || process.env.JWT_SECRET || 'fmm-attempts');
const hmac = (value) => crypto.createHmac('sha256', key()).update(String(value)).digest('hex').slice(0, 32);
const visitorOf = (req) => hmac(`ip:${String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim()}`);
const cleanEmail = (value) => {
  const email = String(value || '').trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : '';
};

// Per-instance counters (serverless instances are short-lived; this is a cap, not an exact meter).
const buckets = new Map();
const allow = (bucketKey, limit) => {
  const now = Date.now();
  let b = buckets.get(bucketKey);
  if (!b || b.resetAt < now) { b = { count: 0, resetAt: now + PER_VISITOR_WINDOW_MS }; buckets.set(bucketKey, b); }
  b.count += 1;
  if (buckets.size > 5000) for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
  return b.count <= limit;
};
const countSuppressed = () => {
  const hour = new Date().toISOString().slice(0, 13);
  Overflow.updateOne({ hour }, { $inc: { suppressed: 1 }, $setOnInsert: { at: new Date() } }, { upsert: true }).catch(() => {});
};

// Map the existing sign-up responses to a plain reason. The sign-up code is not touched.
function classify(status, payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const text = String(typeof payload === 'string' ? payload : (body.error || body.message || '')).toLowerCase();
  const code = String(body.code || '');
  if (status === 200 || status === 201) {
    if (body.emailFailed) return ['success', 'created_email_failed'];
    return ['success', 'created'];
  }
  if (status === 429 || code === 'RATE_LIMITED') return ['blocked', 'too_many_attempts'];
  if (code === 'PENDING_VERIFICATION') return ['failed', 'already_registered_pending'];
  if (code === 'DUPLICATE_EMAIL_ALIAS' || /already registered|already exists/.test(text)) return ['failed', 'already_registered'];
  if (code === 'DEVICE_LIMIT_REACHED') return ['blocked', 'device_limit'];
  if (/red list/.test(text)) return ['blocked', 'blocked_red_list'];
  if (/missing required/.test(text)) return ['failed', 'missing_fields'];
  if (/invitation/.test(text)) return ['failed', 'invitation_problem'];
  if (status === 503 || code === 'DATABASE_NOT_READY') return ['failed', 'server_busy'];
  if (status >= 500) return ['failed', 'server_error'];
  return ['failed', `rejected_${status}`];
}

const REASON_LABELS = {
  created: 'Account created',
  created_email_failed: 'Account created, verification email failed to send',
  too_many_attempts: 'Too many attempts (rate limit)',
  already_registered_pending: 'Already registered, not yet verified',
  already_registered: 'Email already registered',
  device_limit: 'Device already used for an account',
  blocked_red_list: 'Email is on the red list',
  missing_fields: 'Missing required details',
  invitation_problem: 'Creator invitation problem',
  server_busy: 'Server was busy / database waking up',
  server_error: 'Server error',
  captcha_not_completed: 'Did not complete "I\'m not a robot"',
  terms_not_accepted: 'Did not accept the terms',
  could_not_reach_server: 'Could not reach the server',
};
const labelOf = (reason) => REASON_LABELS[reason] || String(reason || '').replace(/_/g, ' ');

// Express middleware: observes the response of the two sign-up routes only.
function attemptRecorder(req, res, next) {
  const kind = req.method === 'POST' ? TRACKED[req.path] : null;
  if (!kind) return next();
  let payload;
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  res.json = (body) => { payload = body; return originalJson(body); };
  res.send = (body) => { if (payload === undefined) payload = body; return originalSend(body); };
  res.once('finish', () => {
    try {
      if (mongoose.connection.readyState !== 1) return;
      const visitorHash = visitorOf(req);
      const [result, reason] = classify(res.statusCode, typeof payload === 'string' ? (() => { try { return JSON.parse(payload); } catch { return payload; } })() : payload);
      if (!allow(`s:${visitorHash}`, PER_VISITOR_LIMIT)) { countSuppressed(); return; }
      const email = cleanEmail(req.body?.email);
      // Abusive/rate-limited traffic: count it, but do not keep the address.
      const keepEmail = reason !== 'too_many_attempts' && reason !== 'blocked_red_list';
      Attempt.create({
        kind, source: 'server', result, reason, status: res.statusCode,
        email: keepEmail ? email || undefined : undefined,
        emailHash: email ? hmac(`e:${email}`) : undefined,
        visitorHash,
        withReferral: Boolean(req.body?.referrerId),
      }).catch(() => {});
    } catch (_ignored) { /* tracking must never affect sign-up */ }
  });
  return next();
}

const formatET = (date) => (date ? new Intl.DateTimeFormat('en-US', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(date) : '');
const offsetMinutes = (date) => {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, timeZoneName: 'shortOffset' }).formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || 'GMT-5';
  const m = part.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0;
};
const nyMidnight = (ymd) => {
  const [y, mo, d] = ymd.split('-').map(Number);
  let start = new Date(Date.UTC(y, mo - 1, d) - offsetMinutes(new Date(Date.UTC(y, mo - 1, d, 12))) * 60000);
  const again = offsetMinutes(start);
  start = new Date(Date.UTC(y, mo - 1, d) - again * 60000);
  return start;
};
const nextDay = (ymd) => { const t = new Date(`${ymd}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
const todayET = () => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date());
const csvCell = (value) => {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

function registerRegistrationAttemptRoutes({ app, verifyAdminToken }) {
  // Browser-side report for attempts the server never sees (robot check not done,
  // terms not accepted, server unreachable). Strictly limited and marked unverified.
  const CLIENT_REASONS = new Set(['captcha_not_completed', 'terms_not_accepted', 'could_not_reach_server']);
  app.post('/api/registration-attempts/client', async (req, res) => {
    try {
      const reason = String(req.body?.reason || '');
      const kind = req.body?.kind === 'creator' ? 'creator' : 'player';
      if (!CLIENT_REASONS.has(reason)) return res.status(400).json({ ok: false });
      const visitorHash = visitorOf(req);
      if (!allow(`c:${visitorHash}`, CLIENT_LIMIT)) { countSuppressed(); return res.status(202).json({ ok: true }); }
      const email = cleanEmail(req.body?.email);
      if (mongoose.connection.readyState === 1) {
        await Attempt.create({ kind, source: 'browser', result: 'failed', reason, email: email || undefined, emailHash: email ? hmac(`e:${email}`) : undefined, visitorHash, withReferral: Boolean(req.body?.withReferral) });
      }
      return res.status(202).json({ ok: true });
    } catch (_error) {
      return res.status(202).json({ ok: true });
    }
  });

  app.get('/api/admin/registration-attempts', verifyAdminToken, async (req, res) => {
    try {
      const valid = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
      const from = valid(req.query.from) ? String(req.query.from) : todayET();
      let to = valid(req.query.to) ? String(req.query.to) : from;
      if (to < from) to = from;
      if ((Date.parse(to) - Date.parse(from)) / 86400000 > 62) return res.status(400).json({ message: 'Choose a range of 62 days or less.' });
      const start = nyMidnight(from);
      const end = nyMidnight(nextDay(to));
      const rows = await Attempt.find({ at: { $gte: start, $lt: end } }).sort({ at: -1 }).limit(5000).lean();

      // Pending verification for successful sign-ups (read-only lookup).
      const User = mongoose.models.User;
      const createdEmails = [...new Set(rows.filter((r) => r.result === 'success' && r.kind === 'player' && r.email).map((r) => r.email))];
      const verifiedSet = new Set();
      if (User && createdEmails.length) {
        (await User.collection.find({ email: { $in: createdEmails } }, { projection: { email: 1, verified: 1 } }).toArray())
          .forEach((u) => { if (u.verified) verifiedSet.add(String(u.email).toLowerCase()); });
      }
      const people = new Set(rows.map((r) => r.emailHash || `v:${r.visitorHash}`));
      const peopleSucceeded = new Set(rows.filter((r) => r.result === 'success').map((r) => r.emailHash || `v:${r.visitorHash}`));
      const reasons = {};
      rows.forEach((r) => { reasons[r.reason] = (reasons[r.reason] || 0) + 1; });
      const overflow = await Overflow.find({ at: { $gte: new Date(start.getTime() - 3600000), $lt: end } }).lean();

      const list = rows.map((r) => ({
        atET: formatET(r.at),
        kind: r.kind === 'creator' ? 'Creator' : 'Player',
        source: r.source === 'browser' ? 'Browser (unverified)' : 'Server',
        result: r.result === 'success' ? 'Success' : r.result === 'blocked' ? 'Blocked' : 'Failed',
        reason: labelOf(r.reason),
        email: r.email || (r.emailHash ? '(not kept)' : ''),
        verification: r.result === 'success' && r.kind === 'player' && r.email ? (verifiedSet.has(r.email) ? 'Verified' : 'Pending verification') : '',
        referral: r.withReferral ? 'Yes' : 'No',
      }));
      const report = {
        from, to, timeZone: 'Eastern Time (America/New_York)', retentionDays: RETENTION_DAYS,
        windowET: `${formatET(start)} to ${formatET(new Date(end.getTime() - 1000))}`,
        totals: {
          attempts: rows.length,
          peopleWhoTried: people.size,
          peopleWhoSucceeded: peopleSucceeded.size,
          succeeded: rows.filter((r) => r.result === 'success').length,
          failed: rows.filter((r) => r.result === 'failed').length,
          blocked: rows.filter((r) => r.result === 'blocked').length,
          pendingVerification: list.filter((r) => r.verification === 'Pending verification').length,
          verified: list.filter((r) => r.verification === 'Verified').length,
          extraAttemptsCountedOnly: overflow.reduce((n, o) => n + (o.suppressed || 0), 0),
        },
        reasons: Object.entries(reasons).map(([reason, count]) => ({ reason: labelOf(reason), count })).sort((a, b) => b.count - a.count),
        attempts: list,
        trackingStarted: await Attempt.findOne({}).sort({ at: 1 }).select('at').lean().then((r) => (r ? formatET(r.at) : null)),
      };
      res.set('Cache-Control', 'no-store');
      if (req.query.format !== 'csv') return res.json(report);
      const headers = ['Time (Eastern)', 'Account type', 'Recorded by', 'Result', 'Reason', 'Email', 'Verification', 'Came with a referral'];
      const keys = ['atET', 'kind', 'source', 'result', 'reason', 'email', 'verification', 'referral'];
      const lines = [headers.map(csvCell).join(','), ...list.map((r) => keys.map((k) => csvCell(r[k])).join(','))];
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="fmm-registration-attempts-${from}${to !== from ? `_to_${to}` : ''}-eastern.csv"`);
      return res.send(`﻿${lines.join('\r\n')}\r\n`);
    } catch (error) {
      console.error('[registration-attempts] report failed:', error && error.message);
      return res.status(500).json({ message: 'Could not load registration attempts.' });
    }
  });
}

module.exports = { attemptRecorder, registerRegistrationAttemptRoutes, classify };
