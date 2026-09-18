'use strict';

const clean = (value, max = 240) => String(value || '').trim().slice(0, max);
const normalizeVerified = (user = {}) => {
  const value = user.verified ?? user.isVerified ?? user.emailVerified ?? user.accountVerified ?? user.verificationStatus ?? user.accountStatus;
  if (value === true || value === 1) return true;
  return ['true','1','yes','verified','active','approved','complete','completed'].includes(String(value ?? '').toLowerCase());
};
const memberId = (entry) => {
  if (typeof entry === 'string' || typeof entry === 'number') return String(entry);
  if (entry?.userId && typeof entry.userId === 'object') return String(entry.userId._id || entry.userId.id || '');
  return String(entry?.userId || entry?._id || entry?.id || '');
};
const memberEmail = (entry) => String(entry?.email || entry?.userId?.email || '').trim().toLowerCase();

module.exports = function registerAffiliateLeagueRoster({ app, mongoose, Affiliate, User, verifyToken, requireScope, affiliateScope }) {
  const stateSchema = new mongoose.Schema({
    affiliateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Affiliate', required: true, index: true },
    memberKey: { type: String, required: true },
    archived: { type: Boolean, default: false, index: true },
    testAccount: { type: Boolean, default: false, index: true },
    removed: { type: Boolean, default: false, index: true },
    note: { type: String, default: '' },
    updatedBy: { type: String, default: '' },
  }, { timestamps: true });
  stateSchema.index({ affiliateId: 1, memberKey: 1 }, { unique: true });
  const RosterState = mongoose.models.AffiliateLeagueRosterState || mongoose.model('AffiliateLeagueRosterState', stateSchema);
  const auth = [verifyToken, requireScope(affiliateScope)];
  const affiliateIdFrom = (req) => String(req.user?.id || req.user?._id || '');

  const loadRoster = async (affiliateId) => {
    const affiliate = await Affiliate.findById(affiliateId).select('_id usersJoined').lean();
    if (!affiliate) return null;
    const entries = Array.isArray(affiliate.usersJoined) ? affiliate.usersJoined : [];
    const ids = entries.map(memberId).filter((id) => mongoose.Types.ObjectId.isValid(id));
    const emails = entries.map(memberEmail).filter(Boolean);
    const filters = [];
    if (ids.length) filters.push({ _id: { $in: ids } });
    if (emails.length) filters.push({ email: { $in: emails } });
    const users = filters.length ? await User.find({ $or: filters })
      .select('_id playerName firstName lastName email profileUrl currentPlan isSubscribed verified isVerified emailVerified accountVerified verificationStatus accountStatus createdAt updatedAt lastLoginAt lastLogin lastActiveAt').lean() : [];
    const byId = new Map(users.map((user) => [String(user._id), user]));
    const byEmail = new Map(users.map((user) => [String(user.email || '').toLowerCase(), user]));
    const keys = entries.map((entry, index) => memberId(entry) || memberEmail(entry) || 'member-' + index);
    const states = await RosterState.find({ affiliateId, memberKey: { $in: keys } }).lean();
    const stateByKey = new Map(states.map((state) => [state.memberKey, state]));
    return entries.map((entry, index) => {
      const key = keys[index];
      const user = byId.get(memberId(entry)) || byEmail.get(memberEmail(entry)) || (entry?.userId && typeof entry.userId === 'object' ? entry.userId : entry);
      const state = stateByKey.get(key) || {};
      return {
        id: String(user?._id || memberId(entry) || key), key,
        name: user?.playerName || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'League member',
        email: user?.email || memberEmail(entry) || 'Email unavailable',
        avatar: user?.profileUrl || '',
        plan: user?.currentPlan || (user?.isSubscribed ? 'Subscribed' : 'Member'),
        subscribed: Boolean(user?.isSubscribed),
        verified: normalizeVerified(user),
        joinedAt: entry?.joinedAt || user?.createdAt || null,
        lastActiveAt: user?.lastActiveAt || user?.lastLoginAt || user?.lastLogin || user?.updatedAt || null,
        archived: Boolean(state.archived), testAccount: Boolean(state.testAccount), removed: Boolean(state.removed),
      };
    });
  };

  app.get('/api/affiliates/me/league-members', ...auth, async (req, res) => {
    try {
      const members = await loadRoster(affiliateIdFrom(req));
      if (!members) return res.status(404).json({ ok: false, message: 'Affiliate account not found.' });
      return res.json({ ok: true, members });
    } catch (error) {
      console.error('Affiliate roster load failed:', error);
      return res.status(500).json({ ok: false, message: 'Could not load the affiliate roster.' });
    }
  });

  app.patch('/api/affiliates/me/league-members/:memberKey', ...auth, async (req, res) => {
    try {
      const affiliateId = affiliateIdFrom(req);
      const roster = await loadRoster(affiliateId);
      const key = clean(req.params.memberKey, 180);
      const member = roster?.find((row) => row.key === key || row.id === key);
      if (!member) return res.status(404).json({ ok: false, message: 'League member not found.' });
      const action = clean(req.body?.action, 30);
      const updates = {
        archive: { archived: true, removed: false },
        restore: { archived: false, removed: false },
        mark_test: { testAccount: true },
        unmark_test: { testAccount: false },
        remove: { removed: true, archived: false },
      }[action];
      if (!updates) return res.status(422).json({ ok: false, message: 'Choose a valid roster action.' });
      await RosterState.findOneAndUpdate(
        { affiliateId, memberKey: member.key },
        { $set: { ...updates, note: clean(req.body?.note, 300), updatedBy: affiliateId } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      const updatedRoster = await loadRoster(affiliateId);
      const updatedMember = updatedRoster?.find((row) => row.key === member.key);
      return res.json({ ok: true, action, memberKey: member.key, member: updatedMember || member });
    } catch (error) {
      console.error('Affiliate roster update failed:', error);
      return res.status(500).json({ ok: false, message: 'Could not update that league member.' });
    }
  });

  return { RosterState };
};
