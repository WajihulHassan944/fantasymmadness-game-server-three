const crypto = require('crypto');
const axios = require('axios');

// OAuth secrets live only on the server. Set SOCIAL_TOKEN_ENCRYPTION_KEY to a
// random 64-character hex string before enabling any provider.
function registerAffiliateSocialRoutes({ app, mongoose, Affiliate, Match, verifyToken, requireScope, affiliateScope, isFightOpenForEntry }) {
  const schemaOptions = { strict: true, timestamps: true };
  const State = mongoose.models.AffiliateSocialState || mongoose.model('AffiliateSocialState', new mongoose.Schema({
    stateHash: { type: String, required: true, unique: true }, affiliateId: mongoose.Schema.Types.ObjectId,
    provider: String, verifier: String, fightId: String, expiresAt: { type: Date, expires: 0 },
  }, schemaOptions));
  const Account = mongoose.models.AffiliateSocialAccount || mongoose.model('AffiliateSocialAccount', new mongoose.Schema({
    affiliateId: { type: mongoose.Schema.Types.ObjectId, required: true }, provider: String, accountId: String,
    label: String, encryptedToken: String, encryptedRefresh: String, expiresAt: Date,
  }, schemaOptions));
  Account.schema.index({ affiliateId: 1, provider: 1 }, { unique: true });
  const Delivery = mongoose.models.AffiliateSocialDelivery || mongoose.model('AffiliateSocialDelivery', new mongoose.Schema({
    affiliateId: mongoose.Schema.Types.ObjectId, provider: String, fightId: mongoose.Schema.Types.ObjectId,
    status: String, remoteId: String, error: String, claimedAt: Date,
  }, schemaOptions));
  Delivery.schema.index({ affiliateId: 1, provider: 1, fightId: 1 }, { unique: true });

  const platforms = ['facebook', 'instagram', 'x'];
  const apiBase = String(process.env.SOCIAL_CALLBACK_BASE_URL || '').replace(/\/$/, '');
  const siteBase = String(process.env.PUBLIC_APP_URL || 'https://www.fantasymmadness.com').replace(/\/$/, '');
  const key = /^[a-f0-9]{64}$/i.test(process.env.SOCIAL_TOKEN_ENCRYPTION_KEY || '')
    ? Buffer.from(process.env.SOCIAL_TOKEN_ENCRYPTION_KEY, 'hex') : null;
  const configured = (provider) => Boolean(key && apiBase.startsWith('https://') && (
    provider === 'x' ? process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET
      : process.env.META_APP_ID && process.env.META_APP_SECRET));
  const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const encrypt = (value) => {
    if (!key) throw new Error('Social encryption is not configured.');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.');
  };
  const decrypt = (value) => {
    const [iv, tag, data] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  };
  const callback = (provider) => `${apiBase}/api/affiliates/social/${provider}/callback`;
  const graph = 'https://graph.facebook.com/v23.0';
  const xTokenUrl = 'https://api.x.com/2/oauth2/token';
  const http = axios.create({ timeout: 12000 });
  const identity = (req) => String(req.user?.id || req.user?._id || '');
  const auth = [verifyToken, requireScope(affiliateScope)];
  const safePlatform = (req, res, next) => platforms.includes(req.params.platform) ? next() : res.status(404).json({ message: 'Unknown platform.' });
  const returnUrl = (fightId, status) => `${siteBase}/affiliate/fight-launch?fightId=${encodeURIComponent(fightId)}&connection=${encodeURIComponent(status)}`;

  app.get('/api/affiliates/me/social/status', ...auth, async (req, res) => {
    try {
      const accounts = await Account.find({ affiliateId: identity(req) }).select('provider label expiresAt').lean();
      const deliveries = mongoose.isValidObjectId(req.query.fightId)
        ? await Delivery.find({ affiliateId: identity(req), fightId: req.query.fightId }).select('provider status remoteId').lean() : [];
      return res.json({ platforms: Object.fromEntries(platforms.map((provider) => {
        const account = accounts.find((item) => item.provider === provider);
        const delivery = deliveries.find((item) => item.provider === provider);
        return [provider, { configured: configured(provider), connected: Boolean(account), label: account?.label || '',
          status: delivery?.status || '', remoteId: delivery?.remoteId || '' }];
      })) });
    } catch { return res.status(500).json({ message: 'Could not load connected accounts.' }); }
  });

  app.post('/api/affiliates/me/social/:platform/connect', ...auth, safePlatform, async (req, res) => {
    const provider = req.params.platform;
    if (!configured(provider)) return res.status(503).json({ message: 'Account connection is awaiting platform app credentials.' });
    try {
      if (!await Affiliate.exists({ _id: identity(req) })) return res.status(403).json({ message: 'Affiliate account required.' });
      const fightId = mongoose.isValidObjectId(req.body?.fightId) ? req.body.fightId : '';
      const state = crypto.randomBytes(32).toString('base64url');
      const verifier = crypto.randomBytes(32).toString('base64url');
      await State.create({ stateHash: hash(state), affiliateId: identity(req), provider, verifier, fightId,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000) });
      let url;
      if (provider === 'x') {
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        url = new URL('https://x.com/i/oauth2/authorize');
        Object.entries({ response_type: 'code', client_id: process.env.X_CLIENT_ID, redirect_uri: callback(provider),
          scope: 'tweet.read tweet.write users.read offline.access', state, code_challenge: challenge,
          code_challenge_method: 'S256' }).forEach(([k, v]) => url.searchParams.set(k, v));
      } else {
        url = new URL('https://www.facebook.com/v23.0/dialog/oauth');
        Object.entries({ client_id: process.env.META_APP_ID, redirect_uri: callback(provider), state,
          scope: 'pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish' })
          .forEach(([k, v]) => url.searchParams.set(k, v));
      }
      return res.json({ url: url.toString() });
    } catch { return res.status(500).json({ message: 'Could not start account connection.' }); }
  });

  app.get('/api/affiliates/social/:platform/callback', safePlatform, async (req, res) => {
    const provider = req.params.platform;
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!state || !configured(provider)) return res.status(400).send('Connection could not be verified.');
    const record = await State.findOneAndDelete({ stateHash: hash(state), provider, expiresAt: { $gt: new Date() } });
    if (!record) return res.status(400).send('Connection expired. Please try again.');
    if (req.query.error || !req.query.code) return res.redirect(returnUrl(record.fightId, 'cancelled'));
    try {
      let token, refresh = '', expiresAt = null, accountId, label;
      if (provider === 'x') {
        const credentials = Buffer.from(`${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`).toString('base64');
        const response = await http.post(xTokenUrl, new URLSearchParams({ code: req.query.code,
          grant_type: 'authorization_code', redirect_uri: callback(provider), code_verifier: record.verifier }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${credentials}` } });
        token = response.data.access_token; refresh = response.data.refresh_token || '';
        expiresAt = new Date(Date.now() + Number(response.data.expires_in || 7200) * 1000);
        const profile = await http.get('https://api.x.com/2/users/me', { headers: { Authorization: `Bearer ${token}` } });
        accountId = profile.data.data.id; label = `@${profile.data.data.username}`;
      } else {
        const exchange = await http.get(`${graph}/oauth/access_token`, { params: {
          client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET,
          redirect_uri: callback(provider), code: req.query.code,
        } });
        const longLived = await http.get(`${graph}/oauth/access_token`, { params: {
          grant_type: 'fb_exchange_token', client_id: process.env.META_APP_ID,
          client_secret: process.env.META_APP_SECRET, fb_exchange_token: exchange.data.access_token,
        } });
        const pages = await http.get(`${graph}/me/accounts`, { params: {
          fields: 'id,name,access_token,instagram_business_account{id,username}', access_token: longLived.data.access_token,
        } });
        const page = (pages.data.data || []).find((item) => provider === 'facebook' ? item.access_token : item.access_token && item.instagram_business_account?.id);
        if (!page) throw new Error(provider === 'instagram' ? 'No linked Instagram professional account found.' : 'No Facebook Page with posting access found.');
        token = page.access_token;
        accountId = provider === 'instagram' ? page.instagram_business_account.id : page.id;
        label = provider === 'instagram' ? `@${page.instagram_business_account.username || accountId}` : page.name;
      }
      if (!token || !accountId) throw new Error('The provider did not return an account.');
      await Account.findOneAndUpdate({ affiliateId: record.affiliateId, provider }, { $set: {
        accountId, label, encryptedToken: encrypt(token), encryptedRefresh: refresh ? encrypt(refresh) : '', expiresAt,
      } }, { upsert: true, runValidators: true });
      return res.redirect(returnUrl(record.fightId, 'connected'));
    } catch (error) {
      console.error('Social OAuth failed:', provider, error.response?.status || error.message);
      return res.redirect(returnUrl(record.fightId, 'failed'));
    }
  });

  app.delete('/api/affiliates/me/social/:platform', ...auth, safePlatform, async (req, res) => {
    await Account.deleteOne({ affiliateId: identity(req), provider: req.params.platform });
    return res.json({ ok: true });
  });

  app.post('/api/affiliates/me/social/:platform/publish', ...auth, safePlatform, async (req, res) => {
    const provider = req.params.platform;
    const affiliateId = identity(req);
    const fightId = String(req.body?.fightId || '');
    if (!mongoose.isValidObjectId(fightId)) return res.status(400).json({ message: 'Choose a fight first.' });
    if (!configured(provider)) return res.status(503).json({ message: 'Publishing is awaiting platform app credentials.' });
    try {
      const [account, fight] = await Promise.all([
        Account.findOne({ affiliateId, provider }),
        Match.findById(fightId).select('matchFighterA matchFighterB matchDate matchDateKey matchStatus matchShadowOpenStatus matchShadowStatus entryClosedAt lockAt promotionBackground matchTime eventTimeZone').lean(),
      ]);
      if (!account) return res.status(409).json({ message: 'Connect your account first.' });
      if (!fight || !isFightOpenForEntry(fight)) return res.status(409).json({ message: 'This fight is no longer open for promotion.' });
      const fightLink = `${siteBase}/fight/${encodeURIComponent(fightId)}?ref=${encodeURIComponent(affiliateId)}`;
      const title = `${fight.matchFighterA || 'Fight'} vs ${fight.matchFighterB || 'Fight'}`;
      const disclosure = 'I’m a FANTASY MMADNESS affiliate and may earn from eligible entries through my link.';
      const xPrefix = `${disclosure} Predict `;
      const xSuffix = ` with me: ${fightLink} #FANTASYMMADNESS`;
      const xTitleLength = Math.max(0, 280 - xPrefix.length - xSuffix.length);
      const text = provider === 'x'
        ? `${xPrefix}${title.slice(0, xTitleLength)}${xSuffix}`
        : provider === 'instagram'
          ? `${disclosure}\n\nPredict ${title} with me. My tracked fight link: ${fightLink}\n\n#FANTASYMMADNESS #CombatSports #FightNight`
          : `${disclosure}\n\nThink you know ${title}? Predict the action with me: ${fightLink}\n\n#FANTASYMMADNESS #CombatSports #FightNight`;
      // A unique claim prevents double-clicks and concurrent requests from posting twice.
      const filter = { affiliateId, provider, fightId };
      const claim = await Delivery.findOneAndUpdate({ ...filter, status: { $nin: ['publishing', 'published', 'review'] } },
        { $set: { status: 'publishing', error: '', claimedAt: new Date() }, $setOnInsert: filter },
        { upsert: true, new: true });
      if (!claim) return res.status(409).json({ message: 'This fight was already published or is publishing to this account.' });
      try {
        let remoteId;
        let token = decrypt(account.encryptedToken);
        if (provider === 'x') {
          if (account.expiresAt && account.expiresAt.getTime() < Date.now() + 60000) {
            if (!account.encryptedRefresh) throw new Error('Reconnect X to renew your permission.');
            const credentials = Buffer.from(`${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`).toString('base64');
            const refreshed = await http.post(xTokenUrl, new URLSearchParams({ refresh_token: decrypt(account.encryptedRefresh), grant_type: 'refresh_token' }),
              { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${credentials}` } });
            token = refreshed.data.access_token;
            account.encryptedToken = encrypt(token);
            if (refreshed.data.refresh_token) account.encryptedRefresh = encrypt(refreshed.data.refresh_token);
            account.expiresAt = new Date(Date.now() + Number(refreshed.data.expires_in || 7200) * 1000);
            await account.save();
          }
          if (text.length > 280) throw new Error('The tracked fight link is too long for an X post.');
          const result = await http.post('https://api.x.com/2/tweets', { text }, { headers: { Authorization: `Bearer ${token}` } });
          remoteId = result.data.data?.id;
        } else if (provider === 'facebook') {
          const result = await http.post(`${graph}/${account.accountId}/feed`, new URLSearchParams({ message: text, link: fightLink, access_token: token }));
          remoteId = result.data.id;
        } else {
          const poster = String(fight.promotionBackground || '');
          if (!/^https:\/\//i.test(poster)) throw new Error('This fight needs a public HTTPS poster image for Instagram.');
          const media = await http.post(`${graph}/${account.accountId}/media`, new URLSearchParams({ image_url: poster, caption: text, access_token: token }));
          if (!media.data.id) throw new Error('Instagram did not accept the image.');
          const result = await http.post(`${graph}/${account.accountId}/media_publish`, new URLSearchParams({ creation_id: media.data.id, access_token: token }));
          remoteId = result.data.id;
        }
        if (!remoteId) throw new Error('The platform did not confirm publication. Check the account before retrying.');
        await Delivery.updateOne({ _id: claim._id }, { $set: { status: 'published', remoteId } });
        return res.json({ ok: true, status: 'published', remoteId });
      } catch (error) {
        // A timeout might have posted remotely; require manual review before retry.
        const uncertain = !error.response && !String(error.message).startsWith('This fight needs') && !String(error.message).startsWith('Reconnect');
        await Delivery.updateOne({ _id: claim._id }, { $set: { status: uncertain ? 'review' : 'failed', error: String(error.message).slice(0, 300) } });
        console.error('Social publish failed:', provider, error.response?.status || error.message);
        return res.status(502).json({ message: uncertain
          ? 'The platform response was unclear. Check your social account before trying again.'
          : (error.response?.status === 401 || error.response?.status === 403 ? 'Reconnect your account and check its posting permissions.' : String(error.message).slice(0, 160)) });
      }
    } catch (error) {
      if (error.code === 11000) return res.status(409).json({ message: 'This fight was already published or is publishing to this account.' });
      console.error('Social publish setup failed:', error.message);
      return res.status(500).json({ message: 'Could not prepare this post.' });
    }
  });
}

module.exports = { registerAffiliateSocialRoutes };
