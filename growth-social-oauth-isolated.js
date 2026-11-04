'use strict';
// Preview-only OAuth: provider proof -> encrypted verified candidate -> owner confirmation.
const crypto = require('crypto');
const { promisify } = require('util');
const { signConsoleToken, verifyConsoleToken, consolePasswordVersion } = require('./growth-social-oauth-token');
const scrypt = promisify(crypto.scrypt);
const PROVIDERS = {
  tiktok: { authorize: 'https://www.tiktok.com/v2/auth/authorize/', token: 'https://open.tiktokapis.com/v2/oauth/token/', me: 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name', scopes: 'user.info.basic' },
  x: { authorize: 'https://x.com/i/oauth2/authorize', token: 'https://api.x.com/2/oauth2/token', me: 'https://api.x.com/2/users/me?user.fields=id,name,username', scopes: 'tweet.read users.read offline.access' },
};
const hash = s => crypto.createHash('sha256').update(String(s)).digest('base64url');
const random = () => crypto.randomBytes(32).toString('base64url');
const validIdentity = s => typeof s === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(s);
function encrypt(value, key) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
function decrypt(value, key) {
  const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
  cipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.ciphertext, 'base64')), cipher.final()]).toString());
}
function resolveOAuthConfig(env) {
  if (env.VERCEL && (env.VERCEL_ENV !== 'preview' || env.VERCEL_PROJECT_ID !== require('./growth-runtime-config').ISOLATED_PROJECT_ID)) throw Error('Social OAuth is restricted to the isolated Vercel Preview');
  if (env.GROWTH_SOCIAL_PROVIDER === 'live' || env.GROWTH_OUTBOUND_ENABLED === 'true') throw Error('OAuth Preview must keep publishing and outbound delivery disabled');
  const origin = new URL(env.GROWTH_SOCIAL_PUBLIC_ORIGIN || '');
  const stagingHost = /^fantasymmadness-growth-[a-z0-9-]+\.vercel\.app$/i.test(origin.hostname);
  const testHost = !env.VERCEL && origin.hostname === 'growth-preview.example.test';
  if (origin.protocol !== 'https:' || (!stagingHost && !testHost) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw Error('Exact isolated HTTPS Preview origin required');
  const key = Buffer.from(env.GROWTH_SOCIAL_TOKEN_KEY || '', 'base64');
  if (key.length !== 32) throw Error('GROWTH_SOCIAL_TOKEN_KEY must be 32 random bytes (base64)');
  const configs = {
    tiktok: { clientId: env.GROWTH_TIKTOK_CLIENT_KEY, secret: env.GROWTH_TIKTOK_CLIENT_SECRET, expected: env.GROWTH_TIKTOK_EXPECTED_OPEN_ID },
    x: { clientId: env.GROWTH_X_CLIENT_ID, secret: env.GROWTH_X_CLIENT_SECRET, expected: env.GROWTH_X_EXPECTED_USER_ID, username: 'FMmadness2024' },
  };
  const callback = p => new URL('/api/growth/social/' + p + '/callback', origin).toString();
  const errors = p => [!configs[p].clientId && 'client_key_missing', !configs[p].secret && 'client_secret_missing', configs[p].expected && !validIdentity(configs[p].expected) && 'configured_identity_invalid', p === 'tiktok' && env.GROWTH_TIKTOK_REDIRECT_URI && env.GROWTH_TIKTOK_REDIRECT_URI !== callback(p) && 'redirect_uri_mismatch'].filter(Boolean);
  return { origin: origin.origin, key, configs, callback, errors };
}
function installGrowthSocialOAuth({ router, env, db, fetchImpl = globalThis.fetch, adminSecret, clock = () => new Date() }) {
  if (!router || !db || !adminSecret) throw Error('Isolated router, DB and admin secret required');
  if (db.databaseName !== 'fmgrowthtest') throw Error('Only isolated fmgrowthtest database permitted');
  const config = resolveOAuthConfig(env), { key, configs, callback } = config;
  const pending = db.collection('growth_social_oauth_pending');
  const candidates = db.collection('growth_social_oauth_candidates');
  const accounts = db.collection('growth_social_accounts');
  const revoked = db.collection('growth_social_oauth_revoked');
  const { resolveSsoConfig, createAdminSso } = require('./growth-social-admin-sso');
  const ssoConfig = resolveSsoConfig({ ...env, GROWTH_SSO_SITE_PUBLIC_KEY: env.GROWTH_SOCIAL_SSO_PUBLIC_KEY, GROWTH_SSO_SITE_ORIGINS: env.GROWTH_SOCIAL_ADMIN_SITE_ORIGIN });
  const sso = createAdminSso({ config: ssoConfig, collections: {
    nonces: db.collection('growth_social_sso_nonces'), revocations: db.collection('growth_social_sso_revocations'), audit: db.collection('growth_social_sso_audit'),
  }, now: clock, signSession: ({ ttl, ...claims }) => signConsoleToken(adminSecret, { ...claims, method: 'website_admin', pwv: consolePasswordVersion(env.GROWTH_ADMIN_PASSWORD_HASH) }, { expiresIn: Math.min(ttl, 1200) }) });
  const serverOnly = (req, res, next) => {
    if (req.headers.origin || req.headers['sec-fetch-site']) return res.status(403).json({ ok: false, reason: 'server_to_server_required' });
    next();
  };
  const hits = new Map();
  function limited(key, max) { const now = clock().getTime(); const rows = (hits.get(key) || []).filter(t => t > now - 600000); rows.push(now); if (hits.size > 2000) hits.clear(); hits.set(key, rows); return rows.length > max; }
  const cookieName = p => '__Host-growth_' + p + '_oauth';
  const candidateCookie = p => '__Host-growth_' + p + '_candidate';
  const readCookie = (req, name) => String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(name + '='))?.slice(name.length + 1);
  const seal = value => { const c = encrypt(value, key); return Buffer.concat([Buffer.from(c.iv, 'base64'), Buffer.from(c.tag, 'base64'), Buffer.from(c.ciphertext, 'base64')]).toString('base64url'); };
  const unseal = value => { const b = Buffer.from(value, 'base64url'); return decrypt({iv:b.subarray(0,12).toString('base64'),tag:b.subarray(12,28).toString('base64'),ciphertext:b.subarray(28).toString('base64')},key); };
  const clearCandidate = (res, p) => res.append('Set-Cookie', candidateCookie(p) + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  const clearCookie = (res, p) => res.append('Set-Cookie', cookieName(p) + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  const sameOrigin = (req, res, next) => {
    if ((req.headers.origin && req.headers.origin !== config.origin) || req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ ok: false, error: 'cross_origin_refused' });
    next();
  };
  const wrap = fn => async (req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); try { return await fn(req, res, next); } catch { return res.status(503).json({ ok: false, error: 'oauth_temporarily_unavailable' }); } };
  const auth = wrap(async (req, res, next) => {
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
      if (!match || match[1].length > 4096) throw Error('no session');
      const claims = verifyConsoleToken(adminSecret, match[1]);
      if (claims.scope !== 'growth' || claims.pwv !== consolePasswordVersion(env.GROWTH_ADMIN_PASSWORD_HASH) || !Number.isInteger(claims.exp) || claims.exp * 1000 <= clock().getTime()) throw Error('invalid session');
      if (await sso.revokedReason(claims)) throw Error('website session ended');
      req.socialSession = hash(match[1]); req.socialAdmin = claims;
      if (await revoked.findOne({ _id: req.socialSession, expiresAt: { $gt: clock() } })) throw Error('signed out');
      return next();
    } catch { return res.status(401).json({ ok: false, error: 'admin_required' }); }
  });
  const selected = (req, res) => { const p = req.params.provider; if (!PROVIDERS[p]) { res.status(404).json({ ok: false, error: 'unknown_provider' }); return null; } const errors = config.errors(p); if (errors.length) { res.status(503).json({ ok: false, error: 'provider_not_configured', blockers: errors }); return null; } return p; };
  let indexed;
  const indexes = () => indexed ||= Promise.all([pending, candidates, revoked].map(c => c.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }))).catch(e => { indexed = null; throw e; });
  const remote = (url, opts) => fetchImpl(url, { ...opts, redirect: 'error', signal: AbortSignal.timeout(10000) });
  router.post('/admin/sso/assertion', serverOnly, wrap(async (req, res) => {
    const out = await sso.exchange(req.body?.assertion, { ip: req.ip });
    res.status(out.status || 200).json(out.ok ? { ...out, expiresAt: out.expiresAtMs } : out);
  }));
  router.post('/admin/sso/revoke', serverOnly, wrap(async (req, res) => {
    const out = await sso.revokeAdmin(req.body?.assertion, { ip: req.ip }); res.status(out.status || 200).json(out);
  }));
  router.get('/social/admin/sign-in', (req, res) => {
    let url = null;
    try { const u = new URL(env.GROWTH_SOCIAL_ADMIN_SITE_ORIGIN); if (u.protocol === 'https:' && ssoConfig.siteOrigins.includes(u.origin) && u.href === u.origin + '/') url = u.origin + '/administration/growth-connections'; } catch {}
    res.set('Cache-Control', 'no-store').json({ ok: true, method: 'website_admin', configured: Boolean(url && ssoConfig.enabled), keyId: ssoConfig.keyId, url: ssoConfig.enabled ? url : null });
  });
  router.post('/social/admin/login', sameOrigin, wrap(async (req, res) => {
    if (env.GROWTH_SOCIAL_PASSWORD_LOGIN !== 'true') return res.status(403).json({ ok: false, error: 'use_website_administrator_sign_in' });
    if (limited('login:' + (req.ip || 'unknown'), 10)) return res.status(429).json({ ok: false, error: 'too_many_attempts' });
    const m = /^scrypt\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(env.GROWTH_ADMIN_PASSWORD_HASH || '');
    if (!m) return res.status(503).json({ ok: false, error: 'administrator_login_not_configured' });
    const password = req.body?.password;
    if (typeof password !== 'string' || !password || password.length > 1024) return res.status(401).json({ ok: false, error: 'invalid_login' });
    const expected = Buffer.from(m[2], 'base64');
    if (expected.length !== 64) return res.status(503).json({ ok: false, error: 'administrator_login_not_configured' });
    const actual = await scrypt(password, Buffer.from(m[1], 'base64'), 64);
    if (!crypto.timingSafeEqual(expected, actual)) return res.status(401).json({ ok: false, error: 'invalid_login' });
    const token = signConsoleToken(adminSecret, { pwv: consolePasswordVersion(env.GROWTH_ADMIN_PASSWORD_HASH), sid: random() }, { expiresIn: '20m' });
    res.json({ ok: true, token });
  }));
  router.post('/social/admin/logout', sameOrigin, auth, wrap(async (req, res) => {
    await indexes(); await revoked.updateOne({ _id: req.socialSession }, { $set: { expiresAt: new Date(req.socialAdmin.exp * 1000) } }, { upsert: true });
    await pending.deleteMany({ session: req.socialSession }); await candidates.deleteMany({ session: req.socialSession });
    for (const p of Object.keys(PROVIDERS)) { clearCookie(res, p); clearCandidate(res, p); }
    res.json({ ok: true });
  }));
  router.post('/social/:provider/connect', sameOrigin, auth, wrap(async (req, res) => {
    const p = selected(req, res); if (!p) return;
    if (limited('connect:' + req.socialSession, 10)) return res.status(429).json({ ok: false, error: 'too_many_attempts' });
    await indexes();
    await accounts.updateOne({_id:p},{$setOnInsert:{provider:p,generation:0,status:'disconnected',publishingEnabled:false}},{upsert:true});
    const account = await accounts.findOne({_id:p});
    const generation = account.generation || 0;
    const state = random(), verifier = random(), binding = random();
    await pending.insertOne({ _id: hash(state), provider: p, generation, session: req.socialSession, admin: req.socialAdmin.email, binding: hash(binding), verifier: encrypt(verifier, key), expiresAt: new Date(Math.min(clock().getTime() + 600000, req.socialAdmin.exp * 1000)) });
    res.append('Set-Cookie', cookieName(p) + '=' + binding + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600');
    const url = new URL(PROVIDERS[p].authorize);
    url.searchParams.set(p === 'tiktok' ? 'client_key' : 'client_id', configs[p].clientId);
    if (p === 'x') { url.searchParams.set('code_challenge', hash(verifier)); url.searchParams.set('code_challenge_method', 'S256'); }
    url.searchParams.set('response_type', 'code'); url.searchParams.set('scope', PROVIDERS[p].scopes); url.searchParams.set('redirect_uri', callback(p)); url.searchParams.set('state', state);
    res.json({ ok: true, authorizationUrl: url.toString(), callbackUrl: callback(p), publishingEnabled: false });
  }));
  router.get('/social/:provider/callback', wrap(async (req, res) => {
    const p = selected(req, res); if (!p) return;
    if (typeof req.query.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(req.query.state)) return res.status(400).send('Invalid authorization state');
    const binding = readCookie(req, cookieName(p));
    if (!binding || !/^[A-Za-z0-9_-]{43}$/.test(binding)) return res.status(400).send('Authorization browser does not match');
    const claim = await pending.findOneAndDelete({ _id: hash(req.query.state), provider: p, binding: hash(binding), expiresAt: { $gt: clock() } });
    if (!claim) return res.status(400).send('Authorization expired or already used');
    clearCookie(res, p);
    if (await revoked.findOne({ _id: claim.session, expiresAt: { $gt: clock() } })) return res.status(401).send('Administrator signed out');
    if (req.query.error) return res.status(400).send('Provider authorization was declined');
    if (typeof req.query.code !== 'string' || !req.query.code || req.query.code.length > 4096) return res.status(400).send('Invalid authorization code');
    const body = new URLSearchParams({ client_secret: configs[p].secret, code: req.query.code, grant_type: 'authorization_code', redirect_uri: callback(p) });
    body.set(p === 'tiktok' ? 'client_key' : 'client_id', configs[p].clientId);
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (p === 'x') { body.set('code_verifier', decrypt(claim.verifier, key)); headers.Authorization = 'Basic ' + Buffer.from(encodeURIComponent(configs[p].clientId) + ':' + encodeURIComponent(configs[p].secret)).toString('base64'); body.delete('client_secret'); }
    let tokens, profile;
    try {
      const response = await remote(PROVIDERS[p].token, { method: 'POST', headers, body: body.toString() });
      if (!response.ok) throw Error('exchange failed'); tokens = await response.json();
      if (tokens.error || typeof tokens.access_token !== 'string' || !/^[^\s]{8,4096}$/.test(tokens.access_token) || String(tokens.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 || tokens.expires_in > 2678400 || (tokens.refresh_token !== undefined && (typeof tokens.refresh_token !== 'string' || !/^[^\s]{8,4096}$/.test(tokens.refresh_token))) || !String(tokens.scope || '').split(/[ ,]+/).includes(p === 'tiktok' ? 'user.info.basic' : 'users.read')) throw Error('invalid token response');
      const me = await remote(PROVIDERS[p].me, { headers: { Authorization: 'Bearer ' + tokens.access_token, Accept: 'application/json' } });
      if (!me.ok) throw Error('profile failed'); profile = await me.json();
    } catch { return res.status(400).send('Authorization exchange or account verification failed'); }
    const identity = p === 'tiktok' ? profile.data?.user?.open_id : profile.data?.id;
    if (!validIdentity(identity) || (p === 'x' && !/^\d{8,32}$/.test(identity)) || (p === 'tiktok' && (profile.error?.code && profile.error.code !== 'ok' || !validIdentity(tokens.open_id) || tokens.open_id !== identity))) return res.status(403).send('Provider identity could not be verified');
    const username = p === 'x' ? profile.data?.username : null;
    if (p === 'x' && (typeof username !== 'string' || username.toLowerCase() !== configs.x.username.toLowerCase())) return res.status(403).send('X account must be @FMmadness2024');
    const existing = await accounts.findOne({ _id: p });
    if ((existing?.generation || 0) !== claim.generation) return res.status(409).send('Authorization was cancelled');
    const expected = configs[p].expected || (existing?.confirmed === true ? existing.identity : null);
    if (expected && expected !== identity) return res.status(403).send('Account does not match the approved identity');
    // No credentials are persisted in MongoDB until explicit administrator confirmation.
    // The verified credentials travel only in a short-lived authenticated-encrypted HttpOnly cookie.
    const expiresAt = new Date(Math.min(clock().getTime() + 300000, claim.expiresAt.getTime()));
    const sealed = seal({ provider: p, session: claim.session, identity, tokens, expiresAt: expiresAt.getTime() });
    if (sealed.length > 3800) return res.status(400).send('Provider response exceeds secure confirmation transport');
    await indexes(); await candidates.insertOne({ _id: hash(req.query.state), provider: p, generation:claim.generation, session: claim.session, identity, username, displayName: String(profile.data?.user?.display_name || profile.data?.name || '').slice(0, 100), sealedHash: hash(sealed), verifiedAt: clock(), expiresAt, tokenExpiresAt: new Date(clock().getTime() + tokens.expires_in * 1000) });
    res.append('Set-Cookie', candidateCookie(p) + '=' + sealed + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300');
    res.type('text/plain').send(p.toUpperCase() + ' account verified. Return to the Growth Engine Connections tab and confirm the displayed account. Publishing remains disabled.');
  }));
  router.post('/social/:provider/confirm', sameOrigin, auth, wrap(async (req, res) => {
    const p = selected(req, res); if (!p) return;
    const sealed = readCookie(req, candidateCookie(p));
    if (!sealed || sealed.length > 3800) return res.status(409).json({ok:false,error:'confirmation_browser_mismatch'});
    let proof; try { proof = unseal(sealed); } catch { return res.status(409).json({ok:false,error:'confirmation_invalid'}); }
    if (proof.provider !== p || proof.session !== req.socialSession || proof.identity !== req.body?.identity || proof.expiresAt <= clock().getTime()) return res.status(409).json({ok:false,error:'confirmation_expired_or_invalid'});
    const c = await candidates.findOneAndDelete({ sealedHash: hash(sealed), _id: String(req.body?.candidateId || ''), provider: p, session: req.socialSession, identity: String(req.body?.identity || ''), expiresAt: { $gt: clock() } });
    clearCandidate(res, p);
    if (!c) return res.status(409).json({ ok: false, error: 'confirmation_expired_or_invalid' });
    if (configs[p].expected && configs[p].expected !== c.identity) return res.status(403).json({ ok: false, error: 'account_mismatch' });
    try {
      const saved = await accounts.updateOne({ _id: p, generation:c.generation, $or:[{identity:c.identity},{confirmed:{$ne:true}}] }, { $set: { provider: p, identity: c.identity, username: c.username, displayName: c.displayName, credentials: encrypt(proof.tokens, key), refreshAvailable: Boolean(proof.tokens.refresh_token), revision: random(), verifiedAt: c.verifiedAt, tokenExpiresAt: c.tokenExpiresAt, confirmedBy: req.socialAdmin.email, connectedAt: clock(), status: 'connected', confirmed:true, publishingEnabled: false } });
      if (!saved.modifiedCount) return res.status(409).json({ok:false,error:'approved_account_changed_or_disconnected'});
    } catch (e) { if (e.code === 11000) return res.status(409).json({ ok: false, error: 'approved_account_changed' }); throw e; }
    res.json({ ok: true, identity: c.identity, publishingEnabled: false });
  }));
  // Administrator-triggered refresh only; tokens are never used to publish.
  router.post('/social/:provider/refresh', sameOrigin, auth, wrap(async (req, res) => {
    const p = selected(req, res); if (!p) return;
    const lock = random();
    const account = await accounts.findOneAndUpdate({ _id: p, confirmed:true, status: 'connected', credentials: { $exists: true }, $or: [{ refreshLockUntil: { $exists: false } }, { refreshLockUntil: { $lte: clock() } }] }, { $set: { refreshLock: lock, refreshLockUntil: new Date(clock().getTime() + 60000) } }, { returnDocument: 'after' });
    if (!account) return res.status(409).json({ok:false,error:'not_connected_or_refresh_in_progress'});
    try {
      const previous = decrypt(account.credentials, key);
      if (!previous.refresh_token) return res.status(409).json({ok:false,error:'reauthorization_required'});
      const body = new URLSearchParams({ grant_type:'refresh_token',refresh_token:previous.refresh_token });
      const headers = {'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'};
      body.set(p==='tiktok'?'client_key':'client_id',configs[p].clientId);
      if(p==='x')headers.Authorization='Basic '+Buffer.from(encodeURIComponent(configs[p].clientId)+':'+encodeURIComponent(configs[p].secret)).toString('base64');else body.set('client_secret',configs[p].secret);
      let tokens,profile;
      try {
        const r=await remote(PROVIDERS[p].token,{method:'POST',headers,body:body.toString()});if(!r.ok)throw Error();tokens=await r.json();
        if(tokens.error||typeof tokens.access_token!=='string'||!/^[^\s]{8,4096}$/.test(tokens.access_token)||String(tokens.token_type).toLowerCase()!=='bearer'||!Number.isFinite(tokens.expires_in)||tokens.expires_in<=0||tokens.expires_in>2678400||(tokens.refresh_token!==undefined&&(typeof tokens.refresh_token!=='string'||!/^[^\s]{8,4096}$/.test(tokens.refresh_token)))||!String(tokens.scope||'').split(/[ ,]+/).includes(p==='tiktok'?'user.info.basic':'users.read'))throw Error();
        const m=await remote(PROVIDERS[p].me,{headers:{Authorization:'Bearer '+tokens.access_token,Accept:'application/json'}});if(!m.ok)throw Error();profile=await m.json();
      }catch{return res.status(400).json({ok:false,error:'refresh_or_identity_verification_failed'});}
      const identity=p==='tiktok'?profile.data?.user?.open_id:profile.data?.id;
      if(identity!==account.identity || (p==='tiktok' && (tokens.open_id!==identity || profile.error?.code && profile.error.code!=='ok')) || (p==='x' && String(profile.data?.username||'').toLowerCase()!=='fmmadness2024'))return res.status(403).json({ok:false,error:'refresh_identity_mismatch'});
      if(!tokens.refresh_token)tokens.refresh_token=previous.refresh_token;
      const r=await accounts.updateOne({_id:p,status:'connected',revision:account.revision,refreshLock:lock},{$set:{credentials:encrypt(tokens,key),refreshAvailable:true,tokenExpiresAt:new Date(clock().getTime()+tokens.expires_in*1000),refreshedAt:clock(),revision:random(),publishingEnabled:false}});
      if(!r.modifiedCount)return res.status(409).json({ok:false,error:'account_changed_during_refresh'});
      res.json({ok:true,publishingEnabled:false});
    } finally { await accounts.updateOne({_id:p,refreshLock:lock},{$unset:{refreshLock:'',refreshLockUntil:''}}); }
  }));
  router.post('/social/:provider/disconnect', sameOrigin, auth, wrap(async (req, res) => {
    const p = selected(req, res); if (!p) return;
    await accounts.updateOne({ _id: p }, { $inc:{generation:1}, $unset: { credentials: '' }, $set: { provider:p, status: 'disconnected', refreshAvailable: false, revision: random(), publishingEnabled: false, disconnectedAt: clock() } }, {upsert:true});
    clearCandidate(res, p); clearCookie(res, p);
    await candidates.deleteMany({ provider: p }); await pending.deleteMany({ provider: p });
    res.json({ ok: true, publishingEnabled: false });
  }));
  router.get('/social/connections', auth, wrap(async (req, res) => {
    const docs = await accounts.find({}).toArray();
    const list = await candidates.find({ session: req.socialSession, expiresAt: { $gt: clock() } }).toArray();
    res.json({ ok: true, database: 'fmgrowthtest', publishingEnabled: false, providers: Object.keys(PROVIDERS).map(provider => ({ provider, configured: !config.errors(provider).length, blockers: config.errors(provider), callbackUrl: callback(provider) })), connections: docs.filter(d=>d.confirmed===true && d.identity).map(d => ({ provider: d.provider, identity: d.identity, displayName: d.displayName, username: d.username, refreshAvailable: d.refreshAvailable === true, status: d.status === 'connected' && d.tokenExpiresAt > clock() ? 'connected' : d.status === 'connected' ? 'expired' : 'disconnected', publishingEnabled: false })), pending: list.map(d => ({ candidateId: d._id, provider: d.provider, identity: d.identity, username: d.username, displayName: d.displayName, expiresAt: d.expiresAt })) });
  }));
  const ui = require('./growth-social-oauth-console');
  router.get('/console', (req, res) => {
    if (env.VERCEL && req.headers.host !== new URL(config.origin).host) return res.redirect(302, config.origin + '/api/growth/console');
    res.set({ 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }).type('html').send(ui.html);
  });
  router.get('/social/console.js', (req, res) => res.set('Cache-Control', 'no-store').type('application/javascript').send(ui.script));
  return { callback, config: { origin: config.origin, publishingEnabled: false } };
}
module.exports = { installGrowthSocialOAuth, resolveOAuthConfig, encrypt, decrypt };
