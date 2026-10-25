'use strict';

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
      return res.send(JSON.stringify({ exportedAt: new Date().toISOString(), part, partSize: BACKUP_PART_SIZE, count: rows.length, note: 'Passwords and secret tokens are intentionally excluded.', players: rows }));
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

  return { buildRecoveryEmail, CAMPAIGN_ID };
};

module.exports.buildRecoveryEmail = buildRecoveryEmail;
