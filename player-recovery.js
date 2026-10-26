'use strict';

const crypto = require('crypto');

// Player Recovery (admin only).
//
// Players who signed up while the verification link pointed at the wrong server
// were left "pending". This module lets the owner see them, download a copy of
// every account, preview an apology/recovery email and — only after typing an
// explicit confirmation — send it in small batches with per-player delivery
// tracking.
//
// SAFETY RULES (do not relax without the owner's approval):
// * Player (User) documents are only READ here. Nothing is deleted, reset or
//   overwritten. The recovery email re-uses the player's existing verification
//   token, so their record is not changed at all.
// * State lives in separate collections: PlayerRecoveryCohort,
//   PlayerRecoveryCampaign, PlayerRecoveryMessage.
// * A player can receive a campaign email at most once (unique index), even if
//   two people press "send" at the same time.
// * The FM COINS goodwill bonus is PREVIEW ONLY. There is no award route.
// * The ONE exception to "read only" is the owner-approved Membership Plan Coin
//   Restoration: it ADDS a confirmed loss to the player's current balance inside a
//   database transaction (never sets a balance), writes a coin-history entry, keeps
//   a copy of the account from just before the change, requires a fresh full backup
//   download plus a typed confirmation, and can never restore the same loss twice.

const CAMPAIGN_ID = 'verification-apology-2026-10';
const CONFIRM_PHRASE = 'SEND RECOVERY EMAILS';
const MAX_BATCH = 25;
const BACKUP_PART_SIZE = 10000;
const SITE = 'https://www.fantasymmadness.com';

const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function buildRecoveryEmail({ firstName, link }) {
  const name = String(firstName || '').trim() || 'there';
  const subject = 'Your FANTASY MMADNESS account is saved — finish verifying';
  const text = [
    `Hi ${name},`,
    '',
    "We're sorry. A technical problem on our side broke the verification link we emailed you when you signed up for FANTASY MMADNESS.",
    '',
    "Your account has been kept safe — you do not need to sign up again. Everything you had is still there.",
    '',
    'Finish verifying here, then sign in with the email and password you chose:',
    link,
    '',
    `If the link doesn't work, go to ${SITE}/auth?mode=login&role=player and press "Resend verification email".`,
    '',
    'Thank you for your patience,',
    'The FANTASY MMADNESS team',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#0b0b0f;font-family:Arial,Helvetica,sans-serif;color:#f4f4f6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b0f;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#16161d;border-radius:14px;padding:28px">
<tr><td style="font-size:13px;letter-spacing:.12em;color:#f2b544;font-weight:bold">FANTASY MMADNESS</td></tr>
<tr><td style="padding-top:14px;font-size:22px;font-weight:bold;color:#ffffff">Your account is saved — let's finish verifying</td></tr>
<tr><td style="padding-top:16px;font-size:15px;line-height:1.6;color:#d8d8de">Hi ${escapeHtml(name)},</td></tr>
<tr><td style="padding-top:10px;font-size:15px;line-height:1.6;color:#d8d8de">We're sorry. A technical problem on our side broke the verification link we emailed you when you signed up.</td></tr>
<tr><td style="padding-top:10px;font-size:15px;line-height:1.6;color:#d8d8de"><strong style="color:#ffffff">Your account has been kept safe.</strong> You do not need to sign up again — everything you had is still there.</td></tr>
<tr><td style="padding-top:22px" align="center"><a href="${escapeHtml(link)}" style="display:inline-block;background:#e11d2e;color:#ffffff;text-decoration:none;font-weight:bold;font-size:16px;padding:14px 26px;border-radius:10px">Verify my account</a></td></tr>
<tr><td style="padding-top:20px;font-size:13px;line-height:1.6;color:#a9a9b3">Then sign in with the email and password you chose. If the button doesn't work, open <a href="${SITE}/auth?mode=login&amp;role=player" style="color:#f2b544">the sign-in page</a> and press "Resend verification email".</td></tr>
<tr><td style="padding-top:20px;font-size:14px;color:#d8d8de">Thank you for your patience,<br>The FANTASY MMADNESS team</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

module.exports = function registerPlayerRecovery({ app, mongoose, verifyAdminToken }) {
  const User = mongoose.models.User;
  if (!User) throw new Error('Player recovery requires the User model.');
  const users = () => User.collection;

  const Cohort = mongoose.models.PlayerRecoveryCohort || mongoose.model('PlayerRecoveryCohort', new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    userCreatedAt: Date,
    addedAt: { type: Date, default: Date.now },
  }));
  const Campaign = mongoose.models.PlayerRecoveryCampaign || mongoose.model('PlayerRecoveryCampaign', new mongoose.Schema({
    campaignId: { type: String, required: true, unique: true },
    approvedAt: Date,
    approvedTotal: Number,
    approvedBy: String,
  }, { timestamps: true }));
  const Message = mongoose.models.PlayerRecoveryMessage || mongoose.model('PlayerRecoveryMessage', (() => {
    const schema = new mongoose.Schema({
      campaignId: { type: String, required: true },
      userId: { type: mongoose.Schema.Types.ObjectId, required: true },
      email: String,
      status: { type: String, enum: ['sending', 'sent', 'failed', 'skipped'], default: 'sending' },
      error: String,
      sentAt: Date,
    }, { timestamps: true });
    schema.index({ campaignId: 1, userId: 1 }, { unique: true });
    return schema;
  })());

  // One row per restored loss event. restorationId is derived from the coin-history
  // record of the original loss, so the same loss can never be restored twice
  // (double clicks, retries and repeated approvals all hit the unique index).
  const Restoration = mongoose.models.CoinRestoration || mongoose.model('CoinRestoration', new mongoose.Schema({
    restorationId: { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    email: String,
    sourceRecordId: { type: String, required: true, unique: true },
    plan: String,
    lossAt: Date,
    originalBalance: Number,
    originalLoss: Number,
    amount: { type: Number, required: true },
    balanceBefore: Number,
    balanceAfter: Number,
    reason: { type: String, default: 'Membership Plan Coin Restoration' },
    status: { type: String, enum: ['complete'], default: 'complete' },
    approvedBy: String,
    approvalBatch: String,
    accountBefore: mongoose.Schema.Types.Mixed, // copy of the account just before the change (no secrets)
  }, { timestamps: true }));
  // Record of each backup file the owner downloaded (no account data is stored here).
  const BackupDownload = mongoose.models.PlayerBackupDownload || mongoose.model('PlayerBackupDownload', new mongoose.Schema({
    part: Number, parts: Number, count: Number, totalAccounts: Number, by: String,
  }, { timestamps: true }));
  const RESTORE_BACKUP_WINDOW_MS = 12 * 60 * 60 * 1000;
  const SECRET_FIELDS = { password: 0, verificationToken: 0, resetPasswordToken: 0, resetPasswordExpires: 0, preferredPaymentMethodValue: 0, profileDeleteUrl: 0, billing: 0 };
  const adminName = (req) => String(req.admin?.email || req.admin?.username || req.admin?.id || req.admin?._id || 'administrator').slice(0, 120);

  // Real players only; test accounts are reported separately.
  const REAL = { isTestAccount: { $ne: true } };
  const PENDING = { ...REAL, verified: { $ne: true } };
  const HAS_LINK = { verificationToken: { $type: 'string', $regex: /^[a-f0-9]{40}$/i } };
  const HAS_EMAIL = { email: { $type: 'string', $regex: /@/ } };
  const createdOf = (doc) => doc.createdAt || (doc._id && doc._id.getTimestamp && doc._id.getTimestamp()) || null;

  const redListEmails = async () => {
    const Red = mongoose.models.Redusers;
    if (!Red) return [];
    const rows = await Red.find({}).select('email').lean();
    return rows.map((row) => String(row.email || '').toLowerCase()).filter(Boolean);
  };

  // Every currently pending player is remembered once, so "returned" can be measured later.
  const refreshCohort = async () => {
    const pending = await users().find(PENDING, { projection: { _id: 1, createdAt: 1 } }).toArray();
    if (!pending.length) return 0;
    const ops = pending.map((doc) => ({
      updateOne: { filter: { userId: doc._id }, update: { $setOnInsert: { userId: doc._id, userCreatedAt: createdOf(doc), addedAt: new Date() } }, upsert: true },
    }));
    for (let i = 0; i < ops.length; i += 1000) await Cohort.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
    return pending.length;
  };

  const recipientFilter = async () => {
    // Anyone already attempted (sent, failed or in flight) is never picked again automatically.
    const already = await Message.find({ campaignId: CAMPAIGN_ID }).distinct('userId');
    const red = await redListEmails();
    return { ...PENDING, ...HAS_LINK, ...HAS_EMAIL, _id: { $nin: already }, ...(red.length ? { email: { $type: 'string', $regex: /@/, $nin: red } } : {}) };
  };

  const coinsOf = (match) => users().aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: { $convert: { input: '$tokens', to: 'double', onError: 0, onNull: 0 } } } } },
  ]).toArray().then((rows) => Math.round(rows[0]?.total || 0));

  app.get('/api/admin/player-recovery/summary', verifyAdminToken, async (_req, res) => {
    try {
      await refreshCohort();
      const now = Date.now();
      const since = (days) => new Date(now - days * 86400000);
      const [total, verified, pending, pendingWithLink, pendingWithAffiliate, pending7, pending30, testAccounts, pendingCoins] = await Promise.all([
        users().countDocuments(REAL),
        users().countDocuments({ ...REAL, verified: true }),
        users().countDocuments(PENDING),
        users().countDocuments({ ...PENDING, ...HAS_LINK }),
        users().countDocuments({ ...PENDING, referredAffiliateId: { $exists: true, $ne: null } }),
        users().countDocuments({ ...PENDING, createdAt: { $gte: since(7) } }),
        users().countDocuments({ ...PENDING, createdAt: { $gte: since(30) } }),
        users().countDocuments({ isTestAccount: true }),
        coinsOf(PENDING),
      ]);
      const cohortIds = await Cohort.distinct('userId');
      const cohortReturned = cohortIds.length ? await users().countDocuments({ _id: { $in: cohortIds }, verified: true }) : 0;
      const [sent, failed, inFlight, emailedIds, campaign, remaining] = await Promise.all([
        Message.countDocuments({ campaignId: CAMPAIGN_ID, status: 'sent' }),
        Message.countDocuments({ campaignId: CAMPAIGN_ID, status: 'failed' }),
        Message.countDocuments({ campaignId: CAMPAIGN_ID, status: 'sending' }),
        Message.find({ campaignId: CAMPAIGN_ID, status: 'sent' }).distinct('userId'),
        Campaign.findOne({ campaignId: CAMPAIGN_ID }).lean(),
        recipientFilter().then((filter) => users().countDocuments(filter)),
      ]);
      const returnedAfterEmail = emailedIds.length ? await users().countDocuments({ _id: { $in: emailedIds }, verified: true }) : 0;

      // Other legitimate records, reported (never recreated): sign-ups whose device
      // record points at an account that no longer exists, and email-list sign-ups.
      let orphanSignupRecords = null;
      let emailListOnly = null;
      const SignupDevice = mongoose.models.SignupDevice;
      if (SignupDevice) {
        const deviceUserIds = await SignupDevice.distinct('userId', { userId: { $ne: null } });
        const existing = deviceUserIds.length ? await users().countDocuments({ _id: { $in: deviceUserIds } }) : 0;
        orphanSignupRecords = deviceUserIds.length - existing;
      }
      if (mongoose.models.Usernonregistered) emailListOnly = await mongoose.models.Usernonregistered.estimatedDocumentCount();

      res.set('Cache-Control', 'no-store');
      return res.json({
        generatedAt: new Date().toISOString(),
        accounts: { allAccountsIncludingTest: total + testAccounts, total, verified, pending, pendingWithLink, pendingWithoutLink: pending - pendingWithLink, pendingWithAffiliate, pendingLast7Days: pending7, pendingLast30Days: pending30, pendingCoinBalanceTotal: pendingCoins, testAccountsExcluded: testAccounts },
        recovery: { cohort: cohortIds.length, returned: cohortReturned, stillPending: cohortIds.length - cohortReturned, emailsSent: sent, emailsFailed: failed, emailsInFlight: inFlight, returnedAfterEmail, remainingRecipients: remaining, campaignApproved: Boolean(campaign?.approvedAt), approvedAt: campaign?.approvedAt || null, approvedTotal: campaign?.approvedTotal ?? null },
        otherRecords: { signupRecordsWithoutAccount: orphanSignupRecords, emailListSignupsNotAccounts: emailListOnly },
        backupParts: Math.max(1, Math.ceil((total + testAccounts) / BACKUP_PART_SIZE)),
      });
    } catch (error) {
      console.error('[player-recovery] summary failed:', error && error.message);
      return res.status(500).json({ message: 'Could not build the recovery summary.' });
    }
  });

  // Owner's own downloadable copy of every account (no passwords or secret tokens).
  app.get('/api/admin/player-recovery/backup', verifyAdminToken, async (req, res) => {
    try {
      const part = Math.max(1, Number.parseInt(req.query.part, 10) || 1);
      const rows = await users().find({}, {
        projection: { password: 0, verificationToken: 0, resetPasswordToken: 0, resetPasswordExpires: 0, preferredPaymentMethodValue: 0, profileDeleteUrl: 0 },
      }).sort({ _id: 1 }).skip((part - 1) * BACKUP_PART_SIZE).limit(BACKUP_PART_SIZE).toArray();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      res.set('Cache-Control', 'no-store');
      res.set('Content-Type', 'application/json; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="fmm-players-backup-${stamp}-part${part}.json"`);
      const totalAccounts = await users().countDocuments({});
      const body = JSON.stringify({ exportedAt: new Date().toISOString(), part, partSize: BACKUP_PART_SIZE, count: rows.length, note: 'Passwords and secret tokens are intentionally excluded.', players: rows });
      await BackupDownload.create({ part, parts: Math.max(1, Math.ceil(totalAccounts / BACKUP_PART_SIZE)), count: rows.length, totalAccounts, by: adminName(req) }).catch(() => {});
      return res.send(body);
    } catch (error) {
      console.error('[player-recovery] backup failed:', error && error.message);
      return res.status(500).json({ message: 'Could not create the backup file.' });
    }
  });

  app.get('/api/admin/player-recovery/campaign', verifyAdminToken, async (_req, res) => {
    try {
      const filter = await recipientFilter();
      const [recipients, pendingAll, pendingWithLink, sample] = await Promise.all([
        users().countDocuments(filter),
        users().countDocuments(PENDING),
        users().countDocuments({ ...PENDING, ...HAS_LINK }),
        users().findOne(filter, { projection: { firstName: 1 } }),
      ]);
      const skippedNoLink = pendingAll - pendingWithLink;
      // Prove the links will work: they use each player's EXISTING token on this
      // server's own address, and that address must answer right now.
      const linkBase = String(app.locals.backendPublicUrl || '').replace(/\/$/, '');
      let linkServerResponding = false;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const probe = await fetch(`${linkBase}/verify-email`, { redirect: 'manual', signal: controller.signal });
        clearTimeout(timer);
        linkServerResponding = probe.status === 302 && /fantasymmadness\.com\/auth/.test(probe.headers.get('location') || '');
      } catch (_probeError) { linkServerResponding = false; }
      const linkCheck = { linkBase, usesExistingTokens: true, linkServerResponding, oldBrokenServer: 'https://fantasymmadness-game-server-three.vercel.app', usesOldBrokenServer: /\/\/fantasymmadness-game-server-three\.vercel\.app/i.test(linkBase) };
      const preview = buildRecoveryEmail({ firstName: sample?.firstName || 'Alex', link: `${app.locals.backendPublicUrl || ''}/verify-email?token=(each player's own link)` });
      res.set('Cache-Control', 'no-store');
      return res.json({ campaignId: CAMPAIGN_ID, recipients, skippedNoLink, linkCheck, confirmPhrase: CONFIRM_PHRASE, maxBatch: MAX_BATCH, mailProvider: typeof app.locals.transactionalMailProvider === 'function' ? app.locals.transactionalMailProvider() : 'unknown', ...preview });
    } catch (error) {
      console.error('[player-recovery] campaign preview failed:', error && error.message);
      return res.status(500).json({ message: 'Could not build the campaign preview.' });
    }
  });

  // Sends ONE batch. Requires the exact confirmation phrase; the first batch also
  // requires the recipient count the owner approved to still be correct.
  app.post('/api/admin/player-recovery/campaign/send', verifyAdminToken, async (req, res) => {
    try {
      if (String(req.body?.confirm || '') !== CONFIRM_PHRASE) return res.status(400).json({ message: `Type ${CONFIRM_PHRASE} to confirm.` });
      const send = app.locals.sendTransactionalMail;
      const base = String(app.locals.backendPublicUrl || '').replace(/\/$/, '');
      if (typeof send !== 'function' || !/^https:\/\//.test(base)) return res.status(503).json({ message: 'Email sending is not available on this server.' });
      if (/\/\/fantasymmadness-game-server-three\.vercel\.app/i.test(base)) return res.status(503).json({ message: 'Links would point at the old broken server. Sending is blocked.' });
      let campaign = await Campaign.findOne({ campaignId: CAMPAIGN_ID }).lean();
      const filter = await recipientFilter();
      if (!campaign?.approvedAt) {
        const current = await users().countDocuments(filter);
        if (Number(req.body?.expectedRecipients) !== current) return res.status(409).json({ message: `The recipient count is now ${current}. Review the preview again before sending.`, recipients: current });
        campaign = await Campaign.findOneAndUpdate({ campaignId: CAMPAIGN_ID }, { $setOnInsert: { campaignId: CAMPAIGN_ID, approvedAt: new Date(), approvedTotal: current, approvedBy: String(req.admin?.email || req.admin?.id || 'admin') } }, { upsert: true, new: true }).lean();
      }
      const size = Math.min(MAX_BATCH, Math.max(1, Number.parseInt(req.body?.batchSize, 10) || MAX_BATCH));
      const batch = await users().find(filter, { projection: { _id: 1, email: 1, firstName: 1, verificationToken: 1 } }).sort({ _id: 1 }).limit(size).toArray();
      const results = { sent: 0, failed: 0, skipped: 0 };
      for (const player of batch) {
        try {
          // Claim first: the unique index guarantees one email per player per campaign.
          await Message.create({ campaignId: CAMPAIGN_ID, userId: player._id, email: player.email, status: 'sending' });
        } catch (claimError) {
          results.skipped += 1;
          continue;
        }
        try {
          const link = `${base}/verify-email?token=${player.verificationToken}`;
          const mail = buildRecoveryEmail({ firstName: player.firstName, link });
          await send({ to: player.email, subject: mail.subject, text: mail.text, html: mail.html });
          await Message.updateOne({ campaignId: CAMPAIGN_ID, userId: player._id }, { $set: { status: 'sent', sentAt: new Date() } });
          results.sent += 1;
        } catch (mailError) {
          await Message.updateOne({ campaignId: CAMPAIGN_ID, userId: player._id }, { $set: { status: 'failed', error: String(mailError?.message || 'send failed').slice(0, 300) } });
          results.failed += 1;
        }
      }
      const remaining = await users().countDocuments(await recipientFilter());
      return res.json({ ...results, remaining });
    } catch (error) {
      console.error('[player-recovery] send failed:', error && error.message);
      return res.status(500).json({ message: 'The batch could not be sent.' });
    }
  });

  app.get('/api/admin/player-recovery/messages', verifyAdminToken, async (req, res) => {
    try {
      const status = ['sent', 'failed', 'sending'].includes(req.query.status) ? req.query.status : 'failed';
      const rows = await Message.find({ campaignId: CAMPAIGN_ID, status }).sort({ updatedAt: -1 }).limit(200).select('email status error sentAt updatedAt').lean();
      res.set('Cache-Control', 'no-store');
      return res.json({ status, rows });
    } catch (error) {
      return res.status(500).json({ message: 'Could not load delivery results.' });
    }
  });

  // PREVIEW ONLY: how many players a goodwill bonus would reach. No coins are issued here.
  app.get('/api/admin/player-recovery/goodwill-preview', verifyAdminToken, async (req, res) => {
    try {
      const amount = Math.max(0, Math.min(100000, Number.parseInt(req.query.amount, 10) || 2500));
      await refreshCohort();
      const cohortIds = await Cohort.distinct('userId');
      const affected = cohortIds.length;
      const returnedSoFar = affected ? await users().countDocuments({ _id: { $in: cohortIds }, verified: true }) : 0;
      res.set('Cache-Control', 'no-store');
      return res.json({ amount, affectedPlayers: affected, returnedSoFar, coinsIfAllAffected: amount * affected, coinsIfReturnedSoFar: amount * returnedSoFar, awardingEnabled: false });
    } catch (error) {
      return res.status(500).json({ message: 'Could not build the bonus preview.' });
    }
  });

  // ---------------------------------------------------------------------------
  // Daily registration report (read-only). The day is a calendar day in New York
  // time (Eastern, daylight/standard handled automatically).
  // ---------------------------------------------------------------------------
  const ZONE = 'America/New_York';
  // When the corrected verification link went live (production deploy, 2026-10-25 09:48 ET).
  const LINK_FIX_DEPLOYED_AT = Date.parse('2026-10-25T13:48:02Z');
  const zoneOffsetMinutes = (date) => {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, timeZoneName: 'shortOffset' })
      .formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || 'GMT-5';
    const m = part.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return 0;
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
  };
  // UTC instant of local midnight for YYYY-MM-DD in New York.
  const nyMidnight = (ymd) => {
    const [y, mo, d] = ymd.split('-').map(Number);
    const guess = new Date(Date.UTC(y, mo - 1, d, 12));
    const offset = zoneOffsetMinutes(guess);
    let start = new Date(Date.UTC(y, mo - 1, d) - offset * 60000);
    // Re-check at the computed instant (covers the rare DST-change day).
    const offsetAtStart = zoneOffsetMinutes(start);
    if (offsetAtStart !== offset) start = new Date(Date.UTC(y, mo - 1, d) - offsetAtStart * 60000);
    return start;
  };
  const nextDay = (ymd) => { const t = new Date(`${ymd}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
  const formatET = (date) => (date ? new Intl.DateTimeFormat('en-US', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(date) : '');
  const csvCell = (value) => {
    let text = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // stop spreadsheet formulas
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const buildDayReport = async (ymd, toYmd = ymd, scope = 'day') => {
    const allPending = scope === 'all-pending';
    const start = allPending ? new Date(0) : nyMidnight(ymd);
    const end = allPending ? new Date(Date.now() + 60000) : nyMidnight(nextDay(toYmd));
    // Older records may lack createdAt; their id still carries the creation time.
    const idStart = mongoose.Types.ObjectId.createFromTime(Math.floor(start.getTime() / 1000));
    const idEnd = mongoose.Types.ObjectId.createFromTime(Math.floor(end.getTime() / 1000));
    const rows = await users().aggregate([
      { $match: allPending ? PENDING : { $or: [{ createdAt: { $gte: start, $lt: end } }, { createdAt: { $exists: false }, _id: { $gte: idStart, $lt: idEnd } }] } },
      { $project: {
        email: 1, firstName: 1, lastName: 1, playerName: 1, createdAt: 1, verified: 1, isTestAccount: 1,
        referredAffiliateId: 1, referredFightId: 1, campaignSource: '$campaignAttribution.source',
        hasPassword: { $eq: [{ $type: '$password' }, 'string'] },
        
      } },
      { $sort: { createdAt: 1, _id: 1 } },
    ]).toArray();

    const affiliateIds = [...new Set(rows.map((r) => r.referredAffiliateId).filter(Boolean).map(String))];
    const Affiliate = mongoose.models.Affiliate;
    const affiliates = affiliateIds.length && Affiliate
      ? await Affiliate.collection.find({ _id: { $in: affiliateIds.map((id) => new mongoose.Types.ObjectId(id)) } }, { projection: { firstName: 1, lastName: 1, playerName: 1 } }).toArray()
      : [];
    const affiliateName = new Map(affiliates.map((a) => [String(a._id), [a.firstName, a.lastName].filter(Boolean).join(' ') || a.playerName || '']));
    const Referral = mongoose.models.Referral;
    const playerReferred = Referral && rows.length ? new Set((await Referral.collection.find({ referredUser: { $in: rows.map((r) => r._id) } }, { projection: { referredUser: 1 } }).toArray()).map((r) => String(r.referredUser))) : new Set();
    const recoverySent = new Set((await Message.find({ campaignId: CAMPAIGN_ID, status: 'sent', userId: { $in: rows.map((r) => r._id) } }).select('userId').lean()).map((m) => String(m.userId)));

    const list = rows.map((r) => {
      const created = createdOf(r);
      const google = !r.hasPassword;
      let verificationEmail;
      if (google) verificationEmail = 'Not needed (signed up with Google)';
      else if (r.verified) verificationEmail = 'Sent and used (player verified)';
      else verificationEmail = created && new Date(created).getTime() < LINK_FIX_DEPLOYED_AT
        ? 'Sent automatically at sign-up; delivery not recorded. Link pointed to the old broken server'
        : 'Sent automatically at sign-up; delivery not recorded. Link points to our live server';
      if (recoverySent.has(String(r._id))) verificationEmail += ' · Recovery email sent';
      const affId = r.referredAffiliateId ? String(r.referredAffiliateId) : '';
      return {
        id: String(r._id),
        email: r.email || '',
        firstName: r.firstName || '',
        lastName: r.lastName || '',
        registeredAtET: formatET(created),
        registeredAtUTC: created ? new Date(created).toISOString() : '',
        status: r.verified ? 'Verified' : 'Pending verification',
        signupMethod: google ? 'Google' : 'Email and password',
        verificationEmail,
        viaAffiliate: affId ? 'Yes' : 'No',
        affiliateName: affId ? (affiliateName.get(affId) || '(affiliate not found)') : '',
        affiliateId: affId,
        referredFightId: r.referredFightId ? String(r.referredFightId) : '',
        referredByPlayer: playerReferred.has(String(r._id)) ? 'Yes' : 'No',
        campaignSource: r.campaignSource || '',
        testAccount: r.isTestAccount ? 'Yes' : 'No',
      };
    });

    // Attempts that never became accounts: only anonymous counts exist (no emails stored).
    let signupPageSends = null;
    const RevenueEvent = mongoose.models.RevenueEvent;
    if (RevenueEvent) signupPageSends = await RevenueEvent.countDocuments({ event: 'signup_gate', createdAt: { $gte: start, $lt: end } });
    let emailListSignups = [];
    if (mongoose.models.Usernonregistered) {
      emailListSignups = (await mongoose.models.Usernonregistered.collection.find({ createdAt: { $gte: start, $lt: end } }, { projection: { email: 1, fullName: 1, createdAt: 1 } }).toArray())
        .map((e) => ({ email: e.email || '', name: e.fullName || '', atET: formatET(e.createdAt) }));
    }

    // Creators/affiliates sign up separately (not player accounts); list them too.
    let affiliateSignups = [];
    if (!allPending && mongoose.models.Affiliate) {
      affiliateSignups = (await mongoose.models.Affiliate.collection.find({ createdAt: { $gte: start, $lt: end }, isTestAccount: { $ne: true } }, { projection: { email: 1, firstName: 1, lastName: 1, playerName: 1, verified: 1, createdAt: 1 } }).sort({ createdAt: 1 }).toArray())
        .map((a) => ({ email: a.email || '', name: [a.firstName, a.lastName].filter(Boolean).join(' ') || a.playerName || '', registeredAtET: formatET(a.createdAt), status: a.verified ? 'Approved' : 'Waiting for approval' }));
    }
    const real = list.filter((r) => r.testAccount === 'No');
    return {
      date: allPending ? 'all-pending' : (toYmd === ymd ? ymd : `${ymd}_to_${toYmd}`),
      scope: allPending ? 'All players still pending verification (any sign-up date)' : (toYmd === ymd ? `Accounts created on ${ymd}` : `Accounts created ${ymd} through ${toYmd}`),
      timeZone: 'Eastern Time (America/New_York)',
      windowET: allPending ? 'Any sign-up date' : `${formatET(start)} to ${formatET(new Date(end.getTime() - 1000))}`,
      windowUTC: { start: start.toISOString(), end: end.toISOString() },
      totals: { accounts: list.length, realAccounts: real.length, verified: real.filter((r) => r.status === 'Verified').length, pending: real.filter((r) => r.status !== 'Verified').length, viaAffiliate: real.filter((r) => r.viaAffiliate === 'Yes').length, google: real.filter((r) => r.signupMethod === 'Google').length, testAccounts: list.length - real.length },
      registrations: list,
      affiliateSignups,
      failedAttempts: {
        identifiableWithEmail: 0,
        signupPageVisitsFromFights: signupPageSends,
        emailListSignupsNotAccounts: emailListSignups,
        unavailable: [
          'Sign-up attempts that failed before an account was saved are not stored in the database, so their email addresses cannot be recovered from it.',
          'The sign-up device log exists in the code but is never written, so it holds no attempts.',
          'Whether each automatic verification email was delivered was never recorded.',
          'Server request logs (kept by Vercel, not in the database) are short-lived and were not readable from here.',
        ],
      },
    };
  };

  const dayParam = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : '2026-10-24');

  app.get('/api/admin/player-recovery/registrations', verifyAdminToken, async (req, res) => {
    try {
      const from = dayParam(req.query.from || req.query.date);
      let to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || '')) ? String(req.query.to) : from;
      if (to < from) to = from;
      // Keep one report to at most 62 days so it stays fast.
      if ((Date.parse(to) - Date.parse(from)) / 86400000 > 62) return res.status(400).json({ message: 'Choose a range of 62 days or less.' });
      const report = await buildDayReport(from, to, req.query.scope === 'all-pending' ? 'all-pending' : 'day');
      res.set('Cache-Control', 'no-store');
      if (req.query.format !== 'csv') return res.json(report);
      const headers = ['Email', 'First name', 'Last name', 'Registered (Eastern Time)', 'Registered (UTC)', 'Status', 'Sign-up method', 'Verification email', 'Via affiliate', 'Affiliate name', 'Affiliate ID', 'Referred fight ID', 'Referred by a player', 'Campaign source', 'Test account', 'Account ID'];
      const keys = ['email', 'firstName', 'lastName', 'registeredAtET', 'registeredAtUTC', 'status', 'signupMethod', 'verificationEmail', 'viaAffiliate', 'affiliateName', 'affiliateId', 'referredFightId', 'referredByPlayer', 'campaignSource', 'testAccount', 'id'];
      const lines = [headers.map(csvCell).join(','), ...report.registrations.map((r) => keys.map((k) => csvCell(r[k])).join(','))];
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="fmm-registrations-${report.date}-eastern.csv"`);
      return res.send(`﻿${lines.join('\r\n')}\r\n`);
    } catch (error) {
      console.error('[player-recovery] registration report failed:', error && error.message);
      return res.status(500).json({ message: 'Could not build the registration report.' });
    }
  });

  // ---------------------------------------------------------------------------
  // FM COINS lost to the old membership-plan bug (READ-ONLY).
  // Before the fix (production 2026-10-25), choosing Free SET the balance to 20 and
  // Standard SET it to 100. This report never changes a balance; it only lists
  // evidence so the owner can decide on any restoration.
  //  - Confirmed: a coin-history record written by the plan change itself shows the
  //    exact balance before and after.
  //  - Possible: the player chose a plan but no such record exists; the amount is
  //    never guessed, only the surrounding evidence is shown.
  //  - No loss: the plan change was recorded and did not reduce the balance.
  // ---------------------------------------------------------------------------
  const PLAN_AMOUNT = { Free: 20, Standard: 100 };
  const FREE_PLAN_DAYS = 30;
  // Production deploy of the fix (dpl_5WBDvjoqjarBpzgZhBAEx8HefpSb), 2026-10-25 5:41 PM ET.
  const PLAN_FIX_AT = Date.parse('2026-10-25T21:41:15Z');
  const num = (value) => { const n = Number.parseInt(String(value ?? ''), 10); return Number.isFinite(n) ? n : null; };

  const buildPlanLossReport = async () => {
    const Ledger = mongoose.models.FightEntryLedger;
    const ledger = Ledger ? Ledger.collection : mongoose.connection.collection('fightentryledgers');
    const planRows = await ledger.find({ 'metadata.reason': 'plan_allotment' }).sort({ createdAt: 1 }).toArray();
    const planRowsByUser = new Map();
    for (const row of planRows) {
      const key = String(row.userId);
      if (!planRowsByUser.has(key)) planRowsByUser.set(key, []);
      planRowsByUser.get(key).push(row);
    }

    // Everyone who ever chose a plan, plus anyone named in a plan-change record.
    const recordedIds = [...planRowsByUser.keys()].filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id) => new mongoose.Types.ObjectId(id));
    const players = await users().find(
      { $or: [{ hasAvailedFreePlan: true }, { currentPlan: { $in: ['Free', 'Standard'] } }, { freePlanExpiryDate: { $exists: true, $ne: null } }, ...(recordedIds.length ? [{ _id: { $in: recordedIds } }] : [])] },
      { projection: { email: 1, firstName: 1, lastName: 1, tokens: 1, currentPlan: 1, hasAvailedFreePlan: 1, freePlanExpiryDate: 1, createdAt: 1, isTestAccount: 1, referredAffiliateId: 1 } },
    ).toArray();

    // Full coin history for these players only (used as evidence around the plan date).
    const historyByUser = new Map();
    const ids = players.map((p) => p._id);
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = await ledger.find(
        { userId: { $in: [...chunk, ...chunk.map(String)] } },
        { projection: { userId: 1, amount: 1, balanceBefore: 1, balanceAfter: 1, createdAt: 1, matchId: 1, 'metadata.reason': 1 } },
      ).sort({ createdAt: 1 }).toArray();
      for (const row of rows) {
        const key = String(row.userId);
        if (!historyByUser.has(key)) historyByUser.set(key, []);
        historyByUser.get(key).push(row);
      }
    }

    const confirmed = [];
    const probableList = [];
    const noLoss = [];
    for (const p of players) {
      const id = String(p._id);
      const base = {
        id,
        email: p.email || '',
        name: [p.firstName, p.lastName].filter(Boolean).join(' '),
        currentBalance: num(p.tokens) ?? 0,
        currentPlan: p.currentPlan || 'None',
        accountCreatedET: formatET(createdOf(p)),
        viaAffiliate: p.referredAffiliateId ? 'Yes' : 'No',
        testAccount: p.isTestAccount ? 'Yes' : 'No',
      };
      const history = historyByUser.get(id) || [];
      const recorded = planRowsByUser.get(id) || [];

      if (recorded.length) {
        const losses = recorded.filter((r) => Number(r.amount) < 0);
        if (!losses.length) {
          noLoss.push({ ...base, evidenceLevel: 'records', reason: `Plan change recorded ${recorded.length === 1 ? 'once' : `${recorded.length} times`}; balance was not reduced.` });
          continue;
        }
        const events = losses.map((r) => {
          const idx = history.findIndex((h) => String(h._id) === String(r._id));
          const prior = idx > 0 ? history[idx - 1] : null;
          const priorMatches = prior && Number(prior.balanceAfter) === Number(r.balanceBefore);
          return {
            plan: r.metadata?.plan || String(r.matchId || '').split(':')[0] || 'Unknown',
            atET: formatET(r.createdAt),
            balanceBefore: Number(r.balanceBefore),
            balanceAfter: Number(r.balanceAfter),
            lost: -Number(r.amount),
            recordId: String(r._id),
            evidence: `Coin-history record ${String(r._id)} written by the plan change on ${formatET(r.createdAt)}: balance ${Number(r.balanceBefore).toLocaleString()} → ${Number(r.balanceAfter).toLocaleString()} FM COINS.`
              + (prior ? (priorMatches ? ` The previous record (${formatET(prior.createdAt)}) also ends at ${Number(prior.balanceAfter).toLocaleString()}, which agrees.` : ` The previous record (${formatET(prior.createdAt)}) ends at ${Number(prior.balanceAfter).toLocaleString()}; the difference came from a change that was not recorded.`) : ''),
          };
        });
        confirmed.push({ ...base, originalBalance: events[0].balanceBefore, amountLost: events.reduce((s, e) => s + e.lost, 0), events });
        continue;
      }

      // No record written by the plan change. Sort by the evidence that exists;
      // an amount is shown only when records on both sides of the plan choice give it,
      // and even then it stays "probable" (needs the owner's approval), never confirmed.
      const chose = [];
      if (p.hasAvailedFreePlan || p.freePlanExpiryDate || p.currentPlan === 'Free') chose.push('Free');
      if (p.currentPlan === 'Standard') chose.push('Standard');
      const evidence = [];
      let chosenAt = null;
      if (chose.includes('Free')) {
        if (p.freePlanExpiryDate) {
          chosenAt = new Date(new Date(p.freePlanExpiryDate).getTime() - FREE_PLAN_DAYS * 86400000);
          evidence.push(`Free plan chosen around ${formatET(chosenAt)} (its 30-day expiry is ${formatET(new Date(p.freePlanExpiryDate))}).`);
        } else evidence.push('Free plan was chosen; the date is not recorded.');
      }
      if (chose.includes('Standard')) {
        const paid = history.some((h) => h.metadata?.reason === 'card_payment_credit');
        evidence.push(paid
          ? 'Current plan is Standard and a card payment credit is on record (the paid route adds coins and does not reduce them).'
          : 'Current plan is Standard with no card payment on record, so it may have been set through the plan screen; the date is not recorded.');
        if (paid && !chose.includes('Free')) { noLoss.push({ ...base, evidenceLevel: 'records', reason: 'Standard plan came from a card payment, which only adds FM COINS.' }); continue; }
      }
      if (chosenAt && chosenAt.getTime() >= PLAN_FIX_AT && !chose.includes('Standard')) {
        noLoss.push({ ...base, evidenceLevel: 'records', reason: `Free plan chosen ${formatET(chosenAt)}, after the fix went live, so the balance could not be reduced.` });
        continue;
      }
      const planAmount = chose.includes('Free') ? PLAN_AMOUNT.Free : PLAN_AMOUNT.Standard;
      const before = chosenAt ? history.filter((h) => new Date(h.createdAt) < chosenAt) : [];
      const after = chosenAt ? history.filter((h) => new Date(h.createdAt) >= chosenAt) : [];
      const lastBefore = before.length ? before[before.length - 1] : null;
      const firstAfter = after.length ? after[0] : null;
      const knownBefore = lastBefore ? Number(lastBefore.balanceAfter) : null;
      const noLaterRecords = chosenAt ? after.length === 0 : history.length === 0;
      // The old bug always left the balance at exactly the plan amount.
      const signature = firstAfter ? Number(firstAfter.balanceBefore) === planAmount : (noLaterRecords && base.currentBalance === planAmount);
      if (lastBefore) evidence.push(`Last recorded balance before the plan choice: ${knownBefore.toLocaleString()} FM COINS (${formatET(lastBefore.createdAt)}).`);
      else if (chosenAt) evidence.push('No coin history before the plan choice, so the balance at that moment is not recorded.');
      if (firstAfter) evidence.push(`First recorded balance after it: ${Number(firstAfter.balanceBefore).toLocaleString()} FM COINS (${formatET(firstAfter.createdAt)}).`);
      else if (noLaterRecords && history.length) evidence.push('No coin activity was recorded after the plan choice.');
      if (!history.length) evidence.push('This player has no coin history at all.');
      evidence.push(`Current balance: ${base.currentBalance.toLocaleString()} FM COINS.`);
      const probable = (indicatedLoss, indication) => probableList.push({ ...base, plansChosen: chose.join(' and ') || 'Unknown', planChosenAtET: chosenAt ? formatET(chosenAt) : '', amountLost: null, indicatedLoss, indication, evidence });

      if (knownBefore !== null && knownBefore <= planAmount) {
        noLoss.push({ ...base, evidenceLevel: 'records', reason: `Recorded balance just before the plan choice was ${knownBefore}, at or below the plan amount (${planAmount}), so the plan could only raise it.` });
      } else if (signature && knownBefore !== null) {
        probable(knownBefore - planAmount, `Probable loss of ${(knownBefore - planAmount).toLocaleString()} FM COINS: the last record before the plan choice shows ${knownBefore.toLocaleString()} and the balance afterwards was exactly ${planAmount}, the old problem's signature. Changes in between could have gone unrecorded, so this needs your approval.`);
      } else if (signature) {
        probable(null, `Probable loss, amount not determinable: the balance right after the plan choice was exactly ${planAmount} (the old problem's signature), but the balance before it was never recorded. For reference only: players who sign up today start with 500 FM COINS, so if this player had exactly that, the loss would have been ${(500 - planAmount).toLocaleString()}. That is not proof of what they had.`);
      } else if (firstAfter && Number(firstAfter.balanceBefore) > planAmount) {
        noLoss.push({ ...base, evidenceLevel: 'records', reason: `No sign of a loss: the first record after the plan choice shows ${Number(firstAfter.balanceBefore).toLocaleString()} FM COINS, not the ${planAmount} the old problem always left.` + (knownBefore !== null ? ` Last record before it: ${knownBefore.toLocaleString()}.` : '') });
      } else {
        noLoss.push({ ...base, evidenceLevel: 'none', reason: `No loss can be identified: there are no coin records around the plan choice, and the current balance (${base.currentBalance.toLocaleString()}) is not the plan amount.` });
      }
    }

    // Restoration status for every confirmed loss event.
    const restored = new Map((await Restoration.find({ userId: { $in: confirmed.map((c) => new mongoose.Types.ObjectId(c.id)) } }).lean()).map((r) => [r.sourceRecordId, r]));
    for (const c of confirmed) {
      for (const e of c.events) {
        const r = restored.get(e.recordId);
        e.restoration = r ? { restorationId: r.restorationId, amount: r.amount, atET: formatET(r.createdAt), status: r.status } : null;
      }
      c.restoredAmount = c.events.reduce((sum, e) => sum + (e.restoration ? e.restoration.amount : 0), 0);
      c.restorationComplete = c.restoredAmount >= c.amountLost;
    }

    const byEmail = (a, b) => a.email.localeCompare(b.email);
    confirmed.sort(byEmail); probableList.sort(byEmail); noLoss.sort(byEmail);
    const real = (list) => list.filter((r) => r.testAccount === 'No');
    return {
      generatedAt: new Date().toISOString(),
      readOnly: true,
      fixDeployedET: 'October 25, 2026, 5:41 PM ET',
      totals: {
        playersWhoChoseAPlan: players.filter((p) => !p.isTestAccount).length,
        confirmedPlayers: real(confirmed).length,
        confirmedCoinsLost: real(confirmed).reduce((s, r) => s + r.amountLost, 0),
        confirmedRestoredPlayers: real(confirmed).filter((r) => r.restorationComplete).length,
        confirmedCoinsRestored: real(confirmed).reduce((s, r) => s + r.restoredAmount, 0),
        probablePlayers: real(probableList).length,
        probableWithAmount: real(probableList).filter((r) => r.indicatedLoss !== null).length,
        probableIndicatedCoins: real(probableList).reduce((s, r) => s + (r.indicatedLoss || 0), 0),
        probableAmountUnknown: real(probableList).filter((r) => r.indicatedLoss === null).length,
        noLossPlayers: real(noLoss).length,
        noLossNoRecords: real(noLoss).filter((r) => r.evidenceLevel === 'none').length,
        testAccountsListed: players.filter((p) => p.isTestAccount).length,
        planChangeRecordsFound: planRows.length,
      },
      confirmed,
      probable: probableList,
      noLoss,
      notes: [
        'Viewing this report never changes a balance. Restoring coins happens only in the restoration step, after your approval.',
        'Confirmed amounts come only from the coin-history record written at the moment of the plan change.',
        'Probable losses show what the surrounding records indicate; no coins are given for them without your separate approval.',
        'Plan changes made before coin history was kept left no record, so those players can be at most probable.',
      ],
    };
  };

  app.get('/api/admin/player-recovery/plan-coin-losses', verifyAdminToken, async (req, res) => {
    try {
      const report = await buildPlanLossReport();
      res.set('Cache-Control', 'no-store');
      if (req.query.format !== 'csv') return res.json(report);
      const headers = ['Category', 'Email', 'Name', 'Original balance (FM COINS)', 'Amount lost (FM COINS)', 'Current balance (FM COINS)', 'Plan', 'When (Eastern Time)', 'Evidence', 'Account created (ET)', 'Via affiliate', 'Test account', 'Account ID'];
      const lines = [headers.map(csvCell).join(',')];
      for (const r of report.confirmed) for (const e of r.events) lines.push([e.restoration ? `Confirmed - restored ${e.restoration.atET}` : 'Confirmed', r.email, r.name, e.balanceBefore, e.lost, r.currentBalance, e.plan, e.atET, e.evidence, r.accountCreatedET, r.viaAffiliate, r.testAccount, r.id].map(csvCell).join(','));
      for (const r of report.probable) lines.push(['Probable - needs your approval', r.email, r.name, 'Not recorded', r.indicatedLoss === null ? 'Not determinable' : `Indicated ${r.indicatedLoss} (not confirmed)`, r.currentBalance, r.plansChosen, r.planChosenAtET, [r.indication, ...r.evidence].join(' '), r.accountCreatedET, r.viaAffiliate, r.testAccount, r.id].map(csvCell).join(','));
      for (const r of report.noLoss) lines.push([r.evidenceLevel === 'none' ? 'No loss identified (no records)' : 'No loss identified', r.email, r.name, '', 0, r.currentBalance, r.currentPlan, '', r.reason, r.accountCreatedET, r.viaAffiliate, r.testAccount, r.id].map(csvCell).join(','));
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="fmm-plan-coin-losses-${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.send(`﻿${lines.join('\r\n')}\r\n`);
    } catch (error) {
      console.error('[player-recovery] plan coin loss report failed:', error && error.message);
      return res.status(500).json({ message: 'Could not build the FM COINS loss report.' });
    }
  });

  // ---------------------------------------------------------------------------
  // Membership Plan Coin Restoration (owner-approved, confirmed losses only).
  // ---------------------------------------------------------------------------
  const ledgerCollection = () => (mongoose.models.FightEntryLedger ? mongoose.models.FightEntryLedger.collection : mongoose.connection.collection('fightentryledgers'));
  const RESTORE_REASON = 'membership_plan_coin_restoration';
  const RESTORE_LABEL = 'Membership Plan Coin Restoration';

  const backupStatus = async () => {
    const totalAccounts = await users().countDocuments({});
    const parts = Math.max(1, Math.ceil(totalAccounts / BACKUP_PART_SIZE));
    const since = new Date(Date.now() - RESTORE_BACKUP_WINDOW_MS);
    const recent = await BackupDownload.find({ createdAt: { $gte: since } }).sort({ createdAt: -1 }).lean();
    const have = new Set(recent.map((r) => r.part));
    const missing = [];
    for (let part = 1; part <= parts; part += 1) if (!have.has(part)) missing.push(part);
    return { ok: missing.length === 0, parts, missingParts: missing, totalAccounts, lastDownloadET: recent[0] ? formatET(recent[0].createdAt) : '', windowHours: RESTORE_BACKUP_WINDOW_MS / 3600000 };
  };

  const batchHash = (items, acknowledged) => crypto.createHash('sha256')
    .update(JSON.stringify({ items: items.map((i) => [i.restorationId, i.amount]).sort(), ack: [...acknowledged].sort() }))
    .digest('hex').slice(0, 16);

  const buildRestorationPreview = async () => {
    const report = await buildPlanLossReport();
    const ledger = ledgerCollection();
    const items = [];
    for (const c of report.confirmed) {
      const oid = new mongoose.Types.ObjectId(c.id);
      const account = await users().findOne({ _id: oid }, { projection: { tokens: 1 } });
      const currentBalance = num(account?.tokens);
      for (const e of c.events) {
        const lossRecord = await ledger.findOne({ _id: new mongoose.Types.ObjectId(e.recordId) });
        const lossAt = lossRecord?.createdAt ? new Date(lossRecord.createdAt) : null;
        const checks = [];
        const blocks = [];
        const warnings = [];
        if (c.testAccount === 'Yes') blocks.push('Test account: not included in restorations.');
        if (e.restoration) blocks.push(`Already restored on ${e.restoration.atET} (${e.restoration.amount.toLocaleString()} FM COINS).`);
        if (currentBalance === null) blocks.push('The current balance could not be read, so it is left untouched.');
        const later = lossAt ? await ledger.find({ userId: { $in: [oid, c.id] }, createdAt: { $gt: lossAt } }).sort({ createdAt: 1 }).toArray() : [];
        for (const r of later) {
          if (Number(r.amount) <= 0) continue;
          const reason = String(r.metadata?.reason || '');
          const text = `${reason} ${r.metadata?.label || ''} ${r.matchId || ''}`;
          const line = `+${Number(r.amount).toLocaleString()} FM COINS on ${formatET(r.createdAt)} (${reason || 'no reason recorded'})`;
          if (reason === RESTORE_REASON) blocks.push(`A restoration is already in the coin history: ${line}.`);
          else if (reason === 'admin_grant') warnings.push(`An administrator added coins after the loss: ${line}. Please confirm this was not a reimbursement.`);
          else if (/restor|reimburs|goodwill|compensat/i.test(text)) warnings.push(`A credit that looks like compensation: ${line}. Please confirm.`);
          else if (Number(r.amount) === e.lost) warnings.push(`A credit of exactly the lost amount: ${line}. Please confirm it was not a reimbursement.`);
        }
        checks.push(`Loss record ${e.recordId}: ${e.balanceBefore.toLocaleString()} → ${e.balanceAfter.toLocaleString()} FM COINS when choosing ${e.plan} on ${e.atET}.`);
        checks.push(`Coin history since the loss: ${later.length} record${later.length === 1 ? '' : 's'} checked.`);
        if (!warnings.length && !blocks.length) checks.push('No earlier reimbursement found (no administrator grants, restorations, compensation, or credits of the same amount since the loss).');
        items.push({
          restorationId: `plan-restore:${e.recordId}`,
          sourceRecordId: e.recordId,
          userId: c.id,
          email: c.email,
          name: c.name,
          testAccount: c.testAccount,
          plan: e.plan,
          lossAtET: e.atET,
          lossAt: lossAt ? lossAt.toISOString() : null,
          originalBalance: e.balanceBefore,
          amount: e.lost,
          currentBalance,
          newBalance: currentBalance === null ? null : currentBalance + e.lost,
          checks,
          warnings,
          blocks,
          eligible: blocks.length === 0 && warnings.length === 0,
          needsAcknowledgement: blocks.length === 0 && warnings.length > 0,
        });
      }
    }
    const ready = items.filter((i) => i.eligible);
    return {
      generatedAt: new Date().toISOString(),
      backup: await backupStatus(),
      items,
      readyCount: ready.length,
      readyCoins: ready.reduce((s, i) => s + i.amount, 0),
      rule: 'Each restoration ADDS the lost amount to the player\'s current balance. It never sets a balance.',
    };
  };

  const confirmPhraseFor = (coins) => `RESTORE ${coins} FM COINS`;

  app.get('/api/admin/player-recovery/plan-coin-restorations/preview', verifyAdminToken, async (req, res) => {
    try {
      const preview = await buildRestorationPreview();
      const list = (value) => String(value || '').split(',').map((x) => x.trim()).filter(Boolean);
      const ack = new Set(list(req.query.ack));
      // Default selection: every player with no warnings. The owner may add players
      // whose warnings she has checked (ack); blocked players can never be selected.
      const chosen = req.query.select !== undefined ? new Set(list(req.query.select)) : null;
      const selection = preview.items.filter((i) => (chosen ? chosen.has(i.restorationId) : i.eligible)
        && !i.blocks.length && (i.eligible || ack.has(i.restorationId)));
      const selectionAck = selection.filter((i) => i.needsAcknowledgement).map((i) => i.restorationId);
      const coins = selection.reduce((s, i) => s + i.amount, 0);
      res.set('Cache-Control', 'no-store');
      return res.json({ ...preview, selection: selection.map((i) => i.restorationId), selectionAck, selectionCoins: coins, previewHash: batchHash(selection, selectionAck), confirmPhrase: confirmPhraseFor(coins) });
    } catch (error) {
      console.error('[player-recovery] restoration preview failed:', error && error.message);
      return res.status(500).json({ message: 'Could not build the restoration preview.' });
    }
  });

  const restoreOne = async (item, { approvedBy, approvalBatch, acknowledged }) => {
    const oid = new mongoose.Types.ObjectId(item.userId);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const session = await mongoose.startSession();
      try {
        let outcome = null;
        await session.withTransaction(async () => {
          outcome = null;
          if (await Restoration.findOne({ restorationId: item.restorationId }).session(session).lean()) { outcome = { status: 'already_restored' }; return; }
          const account = await users().findOne({ _id: oid }, { session, projection: SECRET_FIELDS });
          if (!account) throw Object.assign(new Error('Player account not found.'), { permanent: true });
          const wallet = app.locals.coinWallet;
          if (!wallet) throw Object.assign(new Error('The coin wallet is not available.'), { permanent: true });
          // ADDS the loss to the live balance through the shared coin wallet: atomic,
          // recorded in the coin history with this restoration ID, and once only.
          const moved = await wallet.applyCoinChange({
            account: 'user', id: oid, delta: item.amount, reason: RESTORE_REASON, transactionId: item.restorationId,
            reference: 'membership-plan-coin-restoration', session,
            meta: { label: RESTORE_LABEL, restorationId: item.restorationId, sourceRecordId: item.sourceRecordId, approvalBatch },
          });
          if (moved.duplicate) { outcome = { status: 'already_restored' }; return; }
          const before = moved.balanceBefore;
          const after = moved.balanceAfter;
          await Restoration.create([{
            restorationId: item.restorationId, userId: oid, email: account.email || item.email, sourceRecordId: item.sourceRecordId,
            plan: item.plan, lossAt: item.lossAt ? new Date(item.lossAt) : null, originalBalance: item.originalBalance, originalLoss: item.amount,
            amount: item.amount, balanceBefore: before, balanceAfter: after, approvedBy, approvalBatch,
            accountBefore: { ...account, acknowledgedWarnings: acknowledged.includes(item.restorationId) ? item.warnings : [] },
          }], { session });
          outcome = { status: 'restored', balanceBefore: before, balanceAfter: after };
        });
        return outcome;
      } catch (error) {
        if (error && error.code === 11000) return { status: 'already_restored' };
        if (error && error.busy && attempt < 5) { await new Promise((r) => setTimeout(r, 50 * attempt)); continue; }
        return { status: 'failed', error: error && error.permanent ? error.message : 'The balance was changing at the same moment; nothing was changed. Please try again.' };
      } finally {
        await session.endSession();
      }
    }
    return { status: 'failed', error: 'The balance kept changing; nothing was changed. Please try again.' };
  };

  app.post('/api/admin/player-recovery/plan-coin-restorations/apply', verifyAdminToken, async (req, res) => {
    try {
      const requested = Array.isArray(req.body?.restorationIds) ? [...new Set(req.body.restorationIds.map(String))] : [];
      const acknowledged = Array.isArray(req.body?.acknowledged) ? [...new Set(req.body.acknowledged.map(String))] : [];
      if (!requested.length) return res.status(400).json({ message: 'Choose at least one player to restore.' });
      const preview = await buildRestorationPreview();
      const byId = new Map(preview.items.map((i) => [i.restorationId, i]));
      const selected = [];
      for (const id of requested) {
        const item = byId.get(id);
        if (!item) return res.status(409).json({ message: 'One of the chosen players is no longer on the confirmed list. Please refresh the preview.', code: 'NOT_IN_PREVIEW' });
        if (item.blocks.length) return res.status(409).json({ message: `${item.email}: ${item.blocks.join(' ')}`, code: 'BLOCKED' });
        if (item.needsAcknowledgement && !acknowledged.includes(id)) return res.status(409).json({ message: `${item.email} needs your confirmation first: ${item.warnings.join(' ')}`, code: 'NEEDS_ACK' });
        selected.push(item);
      }
      const coins = selected.reduce((s, i) => s + i.amount, 0);
      if (String(req.body?.previewHash || '') !== batchHash(selected, acknowledged.filter((id) => requested.includes(id)))) {
        return res.status(409).json({ message: 'The restoration list changed since you reviewed it. Please refresh the preview and check it again.', code: 'PREVIEW_CHANGED' });
      }
      if (String(req.body?.confirm || '').trim() !== confirmPhraseFor(coins)) {
        return res.status(400).json({ message: `Type exactly: ${confirmPhraseFor(coins)}`, code: 'CONFIRM_REQUIRED' });
      }
      if (!preview.backup.ok) {
        return res.status(409).json({ message: `Please download a full backup first (missing part${preview.backup.missingParts.length === 1 ? '' : 's'} ${preview.backup.missingParts.join(', ')} within the last ${preview.backup.windowHours} hours).`, code: 'BACKUP_REQUIRED' });
      }
      const approvalBatch = `batch-${new Date().toISOString()}-${crypto.randomBytes(4).toString('hex')}`;
      const approvedBy = adminName(req);
      const results = [];
      for (const item of selected) {
        const outcome = await restoreOne(item, { approvedBy, approvalBatch, acknowledged });
        results.push({ restorationId: item.restorationId, email: item.email, amount: item.amount, ...outcome });
      }
      res.set('Cache-Control', 'no-store');
      return res.json({
        approvalBatch,
        restored: results.filter((r) => r.status === 'restored').length,
        coinsRestored: results.filter((r) => r.status === 'restored').reduce((s, r) => s + r.amount, 0),
        alreadyRestored: results.filter((r) => r.status === 'already_restored').length,
        failed: results.filter((r) => r.status === 'failed').length,
        results,
      });
    } catch (error) {
      console.error('[player-recovery] restoration failed:', error && error.message);
      return res.status(500).json({ message: 'The restoration could not be completed. No duplicate coins can be created; refresh to see what was saved.' });
    }
  });

  app.get('/api/admin/player-recovery/plan-coin-restorations', verifyAdminToken, async (_req, res) => {
    try {
      const rows = await Restoration.find({}).sort({ createdAt: -1 }).lean();
      const ledger = ledgerCollection();
      const out = [];
      for (const r of rows) {
        const account = await users().findOne({ _id: r.userId }, { projection: { tokens: 1, email: 1 } });
        const later = await ledger.find({ userId: { $in: [r.userId, String(r.userId)] }, createdAt: { $gt: r.createdAt }, idempotencyKey: { $ne: r.restorationId } }, { projection: { amount: 1 } }).toArray();
        const expected = Number(r.balanceAfter) + later.reduce((s, x) => s + Number(x.amount || 0), 0);
        const current = num(account?.tokens);
        out.push({
          restorationId: r.restorationId,
          email: r.email || account?.email || '',
          plan: r.plan,
          lossAtET: formatET(r.lossAt),
          originalLoss: r.originalLoss,
          amountRestored: r.amount,
          balanceBefore: r.balanceBefore,
          balanceAfter: r.balanceAfter,
          restoredAtET: formatET(r.createdAt),
          reason: r.reason,
          status: r.status === 'complete' ? 'Complete' : r.status,
          approvedBy: r.approvedBy,
          currentBalance: current,
          balanceCheck: current === expected
            ? 'Current balance matches the coin history since the restoration.'
            : `Current balance differs from the coin history by ${(current - expected).toLocaleString()} FM COINS (a change that was not recorded in the coin history). Please review.`,
        });
      }
      res.set('Cache-Control', 'no-store');
      return res.json({ rows: out, totalRestored: out.reduce((s, r) => s + r.amountRestored, 0) });
    } catch (error) {
      console.error('[player-recovery] restoration history failed:', error && error.message);
      return res.status(500).json({ message: 'Could not load the restoration history.' });
    }
  });

  // ---------------------------------------------------------------------------
  // Affiliate payout check (READ-ONLY). Answers: have any affiliates requested or
  // received payouts, and was any payout deducted twice (once at request, again at
  // confirmation, the old double-charge path)? Changes nothing.
  // ---------------------------------------------------------------------------
  app.get('/api/admin/player-recovery/payout-check', verifyAdminToken, async (_req, res) => {
    try {
      const Affiliate = mongoose.models.Affiliate;
      if (!Affiliate) return res.status(500).json({ message: 'Affiliate records are not available.' });
      const ledger = ledgerCollection();
      const affiliates = await Affiliate.collection.find({}, { projection: { email: 1, firstName: 1, lastName: 1, isTestAccount: 1, payouts: 1 } }).toArray();
      const statusCounts = {};
      const payoutRows = [];
      for (const a of affiliates) {
        for (const p of (Array.isArray(a.payouts) ? a.payouts : [])) {
          const status = String(p?.status || 'pending').toLowerCase();
          statusCounts[status] = (statusCounts[status] || 0) + 1;
          payoutRows.push({ affiliateId: a._id, email: a.email || '', testAccount: Boolean(a.isTestAccount), payoutId: p?._id ? String(p._id) : '', amount: Number(p?.amount) || 0, status, createdAt: p?.createdAt || null });
        }
      }
      const reasons = ['payout_requested', 'affiliate_payout_legacy', 'payout_rejected_credit_back'];
      const ledgerCounts = {};
      for (const reason of reasons) ledgerCounts[reason] = await ledger.countDocuments({ 'metadata.reason': reason });
      // A payout deducted twice: a request debit AND a confirmation debit for the same payout.
      const doubleDeductions = [];
      for (const row of payoutRows) {
        if (!row.amount) continue;
        const created = row.createdAt ? new Date(row.createdAt).getTime() : null;
        const requestDebit = await ledger.findOne({ userId: row.affiliateId, 'metadata.reason': 'payout_requested', $or: [
          { matchId: row.payoutId },
          ...(created ? [{ amount: -row.amount, createdAt: { $gte: new Date(created - 120000), $lte: new Date(created + 120000) } }] : []),
        ] });
        if (!requestDebit) continue;
        const confirmDebit = await ledger.findOne({ userId: row.affiliateId, 'metadata.reason': 'affiliate_payout_legacy', amount: -row.amount, createdAt: { $gte: requestDebit.createdAt } });
        if (confirmDebit) doubleDeductions.push({ email: row.email, testAccount: row.testAccount, amount: row.amount, requestedET: formatET(requestDebit.createdAt), confirmedET: formatET(confirmDebit.createdAt), payoutId: row.payoutId });
      }
      const realPayouts = payoutRows.filter((r) => !r.testAccount);
      const anyActivity = realPayouts.length > 0 || Object.values(ledgerCounts).some((n) => n > 0);
      res.set('Cache-Control', 'no-store');
      return res.json({
        generatedAt: new Date().toISOString(),
        readOnly: true,
        affiliates: affiliates.filter((a) => !a.isTestAccount).length,
        testAffiliates: affiliates.filter((a) => a.isTestAccount).length,
        payoutRequests: realPayouts.length,
        testAccountPayoutRequests: payoutRows.length - realPayouts.length,
        payoutsByStatus: statusCounts,
        payoutHistoryRecords: ledgerCounts,
        doubleDeductions,
        verdict: doubleDeductions.length
          ? `${doubleDeductions.length} payout${doubleDeductions.length === 1 ? ' was' : 's were'} deducted twice. Review needed.`
          : anyActivity
            ? 'Payouts exist, but none was deducted twice.'
            : 'No affiliate payout requests, confirmations or payout deductions exist. The double-charge fix was preventive only; no money was lost.',
        payouts: payoutRows.map((r) => ({ ...r, affiliateId: String(r.affiliateId), createdET: formatET(r.createdAt) })),
      });
    } catch (error) {
      console.error('[player-recovery] payout check failed:', error && error.message);
      return res.status(500).json({ message: 'Could not run the payout check.' });
    }
  });

  return { buildRecoveryEmail, CAMPAIGN_ID };
};

module.exports.buildRecoveryEmail = buildRecoveryEmail;
