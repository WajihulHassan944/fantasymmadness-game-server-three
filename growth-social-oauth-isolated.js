'use strict';
// Isolated Growth Engine social OAuth. Never mount in the live game server.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const PROVIDERS = {
  tiktok: { authorize: 'https://www.tiktok.com/v2/auth/authorize/', token: 'https://open.tiktokapis.com/v2/oauth/token/', me: 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name', scopes: 'user.info.basic,video.upload,video.publish' },
  x: { authorize: 'https://twitter.com/i/oauth2/authorize', token: 'https://api.x.com/2/oauth2/token', me: 'https://api.x.com/2/users/me', scopes: 'tweet.read users.read tweet.write offline.access' }
};
const hash = s => crypto.createHash('sha256').update(s).digest('base64url');
const random = () => crypto.randomBytes(32).toString('base64url');
function encryptionKey(env) {
  const key = Buffer.from(env.GROWTH_SOCIAL_TOKEN_KEY || '', 'base64');
  if (key.length !== 32) throw Error('GROWTH_SOCIAL_TOKEN_KEY must be 32 random bytes (base64)');
  return key;
}
function encrypt(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
function installGrowthSocialOAuth({ router, env, db, fetchImpl = globalThis.fetch, adminSecret }) {
  if (!router || !db || !adminSecret) throw Error('Isolated router, DB and admin secret required');
  if (db.databaseName !== 'fmgrowthtest') throw Error('Only isolated fmgrowthtest database permitted');
  const key = encryptionKey(env);
  const pending = db.collection('growth_social_oauth_pending');
  const accounts = db.collection('growth_social_accounts');
  const origin = new URL(env.GROWTH_SOCIAL_PUBLIC_ORIGIN || '');
  if (origin.protocol !== 'https:' || !/growth|staging|preview|test/i.test(origin.hostname) || /^(www\\.)?fantasymmadness\\.com$/i.test(origin.hostname)) throw Error('Dedicated HTTPS staging origin required');
  const configs = {
    tiktok: { clientId: env.GROWTH_TIKTOK_CLIENT_KEY, secret: env.GROWTH_TIKTOK_CLIENT_SECRET, expected: env.GROWTH_TIKTOK_EXPECTED_OPEN_ID },
    x: { clientId: env.GROWTH_X_CLIENT_ID, secret: env.GROWTH_X_CLIENT_SECRET, expected: env.GROWTH_X_EXPECTED_USER_ID }
  };
  const callback = provider => new URL('/api/growth/social/' + provider + '/callback', origin).toString();
  const auth = (req, res, next) => {
    try { req.socialAdmin = jwt.verify(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), adminSecret); next(); }
    catch { res.status(401).json({ ok: false, error: 'admin_required' }); }
  };
  const selected = (req, res) => {
    const p = req.params.provider;
    if (!PROVIDERS[p]) { res.status(404).json({ ok: false, error: 'unknown_provider' }); return null; }
    if (!configs[p].clientId || !configs[p].secret) { res.status(503).json({ ok: false, error: 'provider_not_configured' }); return null; }
    return p;
  };
  router.post('/social/:provider/connect', auth, async (req, res) => {
    const p = selected(req, res); if (!p) return;
    try {
      const state = random(), verifier = random();
      await pending.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      await pending.insertOne({ _id: hash(state), provider: p, admin: String(req.socialAdmin.id || req.socialAdmin.email || ''), verifier: encrypt(verifier, key), expiresAt: new Date(Date.now() + 600000), used: false });
      const url = new URL(PROVIDERS[p].authorize);
      url.searchParams.set('client_key', configs[p].clientId);
      if (p === 'x') { url.searchParams.delete('client_key'); url.searchParams.set('client_id', configs[p].clientId); url.searchParams.set('code_challenge', hash(verifier)); url.searchParams.set('code_challenge_method', 'S256'); }
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', PROVIDERS[p].scopes);
      url.searchParams.set('redirect_uri', callback(p));
      url.searchParams.set('state', state);
      res.set('Cache-Control', 'no-store').json({ ok: true, authorizationUrl: url.toString(), callbackUrl: callback(p) });
    } catch { res.status(500).json({ ok: false, error: 'authorization_setup_failed' }); }
  });
  // Callback intentionally does not enable publishing.
  router.get('/social/:provider/callback', async (req, res) => {
    const p = selected(req, res); if (!p) return;
    res.set('Cache-Control', 'no-store');
    if (typeof req.query.state !== 'string' || typeof req.query.code !== 'string' || req.query.code.length > 4096) return res.status(400).send('Invalid authorization response');
    try {
      const stateId = hash(req.query.state);
      const claim = await pending.findOneAndDelete({ _id: stateId, provider: p, expiresAt: { $gt: new Date() } });
      if (!claim) return res.status(400).send('Authorization expired or already used');
      const body = new URLSearchParams({ client_id: configs[p].clientId, client_secret: configs[p].secret, code: req.query.code, grant_type: 'authorization_code', redirect_uri: callback(p) });
      if (p === 'tiktok') { body.delete('client_id'); body.set('client_key', configs[p].clientId); }
      if (p === 'x') {
        // PKCE verifier is encrypted at rest.
        const v = claim.verifier;
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(v.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(v.tag, 'base64'));
        const verifier = JSON.parse(Buffer.concat([decipher.update(Buffer.from(v.ciphertext, 'base64')), decipher.final()]).toString());
        body.set('code_verifier', verifier);
      }
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      if (p === 'x') { headers.Authorization = 'Basic ' + Buffer.from(configs[p].clientId + ':' + configs[p].secret).toString('base64'); body.delete('client_secret'); }
      const response = await fetchImpl(PROVIDERS[p].token, { method: 'POST', headers, body: body.toString() });
      if (!response.ok) return res.status(400).send('Authorization exchange failed');
      const tokens = await response.json();
      if (!tokens.access_token) return res.status(400).send('Missing access token');
      const me = await fetchImpl(PROVIDERS[p].me, { headers: { Authorization: 'Bearer ' + tokens.access_token } });
      if (!me.ok) return res.status(400).send('Account verification failed');
      const profile = await me.json();
      const identity = p === 'x' ? profile.data?.id : (profile.data?.user?.open_id || tokens.open_id);
      if (!identity || !configs[p].expected || identity !== configs[p].expected) return res.status(403).send('Account does not match approved sandbox identity');
      await accounts.updateOne({ provider: p }, { $set: { provider: p, identity, admin: claim.admin, credentials: encrypt(tokens, key), connectedAt: new Date(), publishingEnabled: false } }, { upsert: true });
      res.status(200).type('text/plain').send('FANTASY MMADNESS: ' + p.toUpperCase() + ' sandbox connected. Publishing remains disabled. Return to Growth Engine.');
    } catch { res.status(500).send('Authorization failed safely'); }
  });
  router.get('/social/connections', auth, async (req, res) => {
    const docs = await accounts.find({}, { projection: { credentials: 0 } }).toArray();
    res.json({ ok: true, connections: docs.map(({ _id, ...d }) => d) });
  });
  return { callback };
}
module.exports = { installGrowthSocialOAuth };
