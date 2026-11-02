'use strict';
// Meta (Facebook Page + Instagram professional account) connection for the isolated
// Growth Engine. The owner authorizes through Meta's own sign-in screen (OAuth); no
// password or token is ever typed into the Growth Engine or a chat.
//
//   1. Owner enters the Meta app's App ID + App Secret once (Connections screen; stored
//      encrypted) or they come from GROWTH_META_APP_ID / GROWTH_META_APP_SECRET.
//   2. "Connect Facebook & Instagram" -> Meta sign-in (single-use, 10-minute state).
//   3. Callback: code -> short-lived -> long-lived user token; permissions checked;
//      the owner's Pages and their linked Instagram professional accounts are listed.
//   4. Owner picks + confirms the Page; the Instagram link is re-verified live with Meta.
//   5. Health check (hourly and on demand): token validity, permissions, Page access,
//      Instagram link; Page tokens are renewed from the user token while it is valid.
// Every token is encrypted (growth-token-vault) and is never logged or returned.
const crypto = require('crypto');

const GRAPH_VERSION = 'v21.0';
const SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish', 'business_management'];
const REQUIRED = { facebook: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'], instagram: ['instagram_basic', 'instagram_content_publish'] };
const STATE_TTL_MS = 10 * 60000;
const RENEW_USER_TOKEN_DAYS = 20;
const WARN_REAUTH_DAYS = 14;
const HEALTH_EVERY_MS = 60 * 60000;
const DEFAULT_ORIGIN = 'https://fantasymmadness-growth-isolated-tes.vercel.app';

const clean = (s, n = 300) => String(s ?? '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, n);
// Never let a token, secret or code leak through an error message.
const scrub = (s) => clean(String(s || '').replace(/(access_token|client_secret|fb_exchange_token|input_token|code)=[^&\s"']+/gi, '$1=[hidden]').replace(/EAA[A-Za-z0-9]{10,}/g, '[hidden]'), 300);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const okBase = (u, kind) => {
  const s = String(u || '').replace(/\/+$/, '');
  if (!s) return null;
  if (kind === 'graph' && s === 'https://graph.facebook.com') return s;
  if (kind === 'dialog' && s === 'https://www.facebook.com') return s;
  if (/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(s)) return s; // loopback test double only
  return null;
};

function resolveMetaConfig(env = {}) {
  const origin = String(env.GROWTH_PUBLIC_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, '');
  return {
    graphBase: okBase(env.GROWTH_META_GRAPH_BASE, 'graph') || 'https://graph.facebook.com',
    dialogBase: okBase(env.GROWTH_META_DIALOG_BASE, 'dialog') || 'https://www.facebook.com',
    version: /^v\d{2}\.\d$/.test(String(env.GROWTH_META_GRAPH_VERSION || '')) ? env.GROWTH_META_GRAPH_VERSION : GRAPH_VERSION,
    redirectUri: `${origin}/api/growth/meta/callback`,
    envApp: { appId: String(env.GROWTH_META_APP_ID || '').trim(), appSecret: String(env.GROWTH_META_APP_SECRET || '').trim(), loginConfigId: /^\d{6,25}$/.test(String(env.GROWTH_META_LOGIN_CONFIG_ID || '').trim()) ? String(env.GROWTH_META_LOGIN_CONFIG_ID).trim() : null },
    expected: { pageId: String(env.GROWTH_META_EXPECTED_PAGE_ID || '').trim() || null, igUsername: String(env.GROWTH_META_EXPECTED_IG_USERNAME || '').trim().replace(/^@/, '').toLowerCase() || null },
    liveTestApproved: env.GROWTH_SOCIAL_LIVE_TEST_APPROVED === 'true',
  };
}

function createMetaConnect({ col, config, vault, fetchImpl = globalThis.fetch, alert = async () => {}, audit = async () => {} }) {
  const KEY = 'meta';
  const graph = (path, q = {}) => { const u = new URL(`${config.graphBase}/${config.version}${path}`); for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v); return u; };
  async function call(url, opts = {}) {
    let r;
    try { r = await fetchImpl(url.toString(), { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) }, signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined }); }
    catch (e) { return { error: scrub(`network error: ${e.message}`), network: true }; }
    let body = null; try { body = await r.json(); } catch { body = null; }
    if (!r.ok || body?.error) return { error: scrub(body?.error?.message || `HTTP ${r.status}`), status: r.status, code: body?.error?.code, subcode: body?.error?.error_subcode };
    return { body };
  }
  const load = () => col.connections.findOne({ key: KEY });
  const save = (set, unset) => col.connections.updateOne({ key: KEY }, { $set: { key: KEY, ...set, updatedAt: new Date().toISOString() }, ...(unset ? { $unset: unset } : {}) }, { upsert: true });
  async function init() {
    await col.connections.createIndex({ key: 1 }, { unique: true });
    await col.oauthStates.createIndex({ stateHash: 1 }, { unique: true });
    await col.oauthStates.createIndex({ expiresAtDate: 1 }, { expireAfterSeconds: 0 });
  }

  // ---- app credentials ----
  async function app(doc) {
    if (config.envApp.appId && config.envApp.appSecret) return { appId: config.envApp.appId, appSecret: config.envApp.appSecret, loginConfigId: config.envApp.loginConfigId, source: 'environment' };
    const d = doc || await load();
    if (!d?.app?.appId || !d.app.appSecretSealed || !vault.configured) return null;
    try { return { appId: d.app.appId, appSecret: vault.open(d.app.appSecretSealed, 'meta:app_secret'), loginConfigId: d.app.loginConfigId || null, source: 'connections screen' }; } catch { return null; }
  }
  async function setApp({ appId, appSecret, loginConfigId, admin, now = new Date() }) {
    if (!vault.configured) return { ok: false, reason: 'encryption_key_not_configured' };
    const id = String(appId || '').trim(); const secret = String(appSecret || '').trim();
    if (!/^\d{6,25}$/.test(id)) return { ok: false, reason: 'app_id_must_be_digits' };
    if (!/^[a-f0-9]{32}$/i.test(secret)) return { ok: false, reason: 'app_secret_must_be_32_characters' };
    const cfg = String(loginConfigId || '').trim();
    if (cfg && !/^\d{6,25}$/.test(cfg)) return { ok: false, reason: 'login_configuration_id_must_be_digits' };
    const r = await call(graph(`/${id}`, { fields: 'id,name', access_token: `${id}|${secret}` }));
    if (r.error) return { ok: false, reason: r.network ? 'meta_unreachable_try_again' : 'meta_rejected_app_id_or_secret', detail: r.error };
    await save({ app: { appId: id, loginConfigId: cfg || null, appSecretSealed: vault.seal(secret, 'meta:app_secret'), name: clean(r.body?.name, 120) || null, validatedAt: now.toISOString(), savedBy: clean(admin, 120) } });
    await audit('meta_app_saved', { admin: clean(admin, 120), appId: id });
    return { ok: true, appName: clean(r.body?.name, 120) || null };
  }

  // ---- authorization ----
  async function startAuthorization({ admin, now = new Date() }) {
    const a = await app();
    if (!vault.configured) return { ok: false, reason: 'encryption_key_not_configured' };
    if (!a) return { ok: false, reason: 'meta_app_not_set_up' };
    const state = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(now.getTime() + STATE_TTL_MS);
    await col.oauthStates.insertOne({ stateHash: sha(state), admin: clean(admin, 120), createdAt: now.toISOString(), expiresAt: expires.toISOString(), expiresAtDate: expires, used: false });
    const u = new URL(`${config.dialogBase}/${config.version}/dialog/oauth`);
    u.searchParams.set('client_id', a.appId); u.searchParams.set('redirect_uri', config.redirectUri); u.searchParams.set('state', state);
    u.searchParams.set('response_type', 'code'); u.searchParams.set('auth_type', 'rerequest');
    // Facebook Login for Business with a saved login configuration uses config_id
    // (its permissions are chosen in the configuration); otherwise the permission list.
    if (a.loginConfigId) u.searchParams.set('config_id', a.loginConfigId); else u.searchParams.set('scope', SCOPES.join(','));
    await audit('meta_authorization_started', { admin: clean(admin, 120) });
    return { ok: true, authorizeUrl: u.toString(), redirectUri: config.redirectUri, expiresAt: expires.toISOString() };
  }

  async function exchange(a, code) {
    const s = await call(graph('/oauth/access_token', { client_id: a.appId, client_secret: a.appSecret, redirect_uri: config.redirectUri, code }));
    if (s.error) return { error: s.error };
    const l = await call(graph('/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: a.appId, client_secret: a.appSecret, fb_exchange_token: s.body.access_token }));
    if (l.error) return { error: l.error };
    return { token: l.body.access_token, expiresIn: Number(l.body.expires_in) || null };
  }
  async function readAccount(userToken) {
    const me = await call(graph('/me', { fields: 'id,name', access_token: userToken }));
    if (me.error) return { error: me.error };
    const perms = await call(graph('/me/permissions', { access_token: userToken }));
    if (perms.error) return { error: perms.error };
    const granted = (perms.body?.data || []).filter((p) => p.status === 'granted').map((p) => p.permission);
    const pages = [];
    let url = graph('/me/accounts', { fields: 'id,name,access_token,tasks,instagram_business_account{id,username,name}', limit: '100', access_token: userToken });
    for (let i = 0; url && i < 5; i++) {
      const r = await call(url);
      if (r.error) return { error: r.error };
      for (const p of r.body?.data || []) pages.push(p);
      url = r.body?.paging?.next && String(r.body.paging.next).startsWith(config.graphBase) ? r.body.paging.next : null;
    }
    return { me: me.body, granted, pages };
  }
  const missing = (granted) => [...REQUIRED.facebook, ...REQUIRED.instagram].filter((p) => !granted.includes(p));
  const pageRow = (p) => ({
    id: clean(p.id, 40), name: clean(p.name, 120), tasks: (p.tasks || []).map((t) => clean(t, 40)),
    canPost: (p.tasks || []).some((t) => ['CREATE_CONTENT', 'MANAGE'].includes(t)),
    ig: p.instagram_business_account?.id ? { id: clean(p.instagram_business_account.id, 40), username: clean(p.instagram_business_account.username, 60) || null, name: clean(p.instagram_business_account.name, 120) || null } : null,
    tokenSealed: p.access_token ? vault.seal(p.access_token, `meta:page:${p.id}`) : null,
  });

  async function handleCallback({ code, state, error, errorReason, now = new Date() }) {
    if (!state) return { ok: false, reason: 'missing_state' };
    const st = await col.oauthStates.findOneAndUpdate({ stateHash: sha(state), used: false, expiresAt: { $gt: now.toISOString() } }, { $set: { used: true, usedAt: now.toISOString() } }, { returnDocument: 'after' });
    if (!st) return { ok: false, reason: 'link_expired_or_already_used_start_again' };
    if (error) { await save({ lastError: { at: now.toISOString(), reason: clean(errorReason || error, 80) } }); return { ok: false, reason: errorReason === 'user_denied' ? 'you_cancelled_on_meta' : 'meta_returned_an_error' }; }
    if (!code) return { ok: false, reason: 'missing_code' };
    const a = await app();
    if (!a) return { ok: false, reason: 'meta_app_not_set_up' };
    const t = await exchange(a, code);
    if (t.error) { await save({ lastError: { at: now.toISOString(), reason: t.error } }); return { ok: false, reason: 'meta_token_exchange_failed' }; }
    const acc = await readAccount(t.token);
    if (acc.error) { await save({ lastError: { at: now.toISOString(), reason: acc.error } }); return { ok: false, reason: 'could_not_read_your_pages' }; }
    const pages = acc.pages.map(pageRow);
    const prev = await load();
    const keep = prev?.selected && pages.find((p) => p.id === prev.selected.pageId && p.ig?.id === prev.selected.igUserId);
    await save({
      authorizedAt: now.toISOString(), authorizedBy: st.admin, user: { id: clean(acc.me.id, 40), name: clean(acc.me.name, 120) },
      userTokenSealed: vault.seal(t.token, 'meta:user'), userTokenExpiresAt: t.expiresIn ? new Date(now.getTime() + t.expiresIn * 1000).toISOString() : null,
      granted: acc.granted, missingPermissions: missing(acc.granted), pages, lastError: null,
      ...(keep ? {} : { selected: null }),
    });
    await audit('meta_authorized', { admin: st.admin, pages: pages.length, missing: missing(acc.granted) });
    if (keep) await healthCheck({ now, force: true });
    return { ok: true, pages: pages.length, missingPermissions: missing(acc.granted), needsSelection: !keep };
  }

  async function selectPage({ pageId, confirm, admin, now = new Date() }) {
    if (confirm !== true) return { ok: false, reason: 'confirm_this_is_the_business_page' };
    const d = await load();
    if (!d?.userTokenSealed) return { ok: false, reason: 'authorize_with_meta_first' };
    const p = (d.pages || []).find((x) => x.id === String(pageId));
    if (!p) return { ok: false, reason: 'page_not_in_your_authorized_list' };
    if (!p.canPost) return { ok: false, reason: 'you_cannot_post_on_this_page' };
    if (!p.ig) return { ok: false, reason: 'no_instagram_professional_account_is_linked_to_this_page' };
    if (config.expected.pageId && p.id !== config.expected.pageId) return { ok: false, reason: 'not_the_expected_business_page' };
    if (config.expected.igUsername && String(p.ig.username || '').toLowerCase() !== config.expected.igUsername) return { ok: false, reason: 'not_the_expected_instagram_account' };
    // Re-verify the Page <-> Instagram link directly with Meta using the Page token.
    let pageToken; try { pageToken = vault.open(p.tokenSealed, `meta:page:${p.id}`); } catch { return { ok: false, reason: 'reconnect_required' }; }
    const v = await call(graph(`/${p.id}`, { fields: 'id,name,instagram_business_account{id,username}', access_token: pageToken }));
    if (v.error) return { ok: false, reason: 'meta_could_not_confirm_the_page', detail: v.error };
    if (v.body?.instagram_business_account?.id !== p.ig.id) return { ok: false, reason: 'instagram_link_changed_reconnect' };
    await save({ selected: { pageId: p.id, pageName: clean(v.body.name, 120), igUserId: p.ig.id, igUsername: clean(v.body.instagram_business_account.username, 60) || p.ig.username, confirmedBy: clean(admin, 120), confirmedAt: now.toISOString() } });
    await audit('meta_page_selected', { admin: clean(admin, 120), pageId: p.id, igUserId: p.ig.id });
    await healthCheck({ now, force: true });
    return { ok: true };
  }

  async function disconnect({ admin, now = new Date() }) {
    const d = await load();
    if (d?.userTokenSealed) {
      try { await call(graph('/me/permissions', { access_token: vault.open(d.userTokenSealed, 'meta:user') }), { method: 'DELETE' }); } catch { /* best effort */ }
    }
    await col.connections.updateOne({ key: KEY }, { $set: { disconnectedAt: now.toISOString(), disconnectedBy: clean(admin, 120) }, $unset: { userTokenSealed: '', userTokenExpiresAt: '', pages: '', selected: '', granted: '', missingPermissions: '', health: '', user: '', authorizedAt: '' } });
    await audit('meta_disconnected', { admin: clean(admin, 120) });
    return { ok: true };
  }

  // ---- health + renewal ----
  async function healthCheck({ now = new Date(), force = false } = {}) {
    const d = await load();
    if (!d?.userTokenSealed) return { ok: false, skipped: 'not_authorized' };
    if (!force && d.health?.checkedAt && now.getTime() - Date.parse(d.health.checkedAt) < HEALTH_EVERY_MS) return { ok: true, skipped: 'recent' };
    const a = await app(d);
    const problems = []; const warnings = []; const set = {};
    let userToken; try { userToken = vault.open(d.userTokenSealed, 'meta:user'); } catch { userToken = null; problems.push('Stored sign-in cannot be read (encryption key changed). Connect again.'); }
    let tokenInfo = null;
    if (userToken && a) {
      const dbg = await call(graph('/debug_token', { input_token: userToken, access_token: `${a.appId}|${a.appSecret}` }));
      if (dbg.error) { if (dbg.network) warnings.push('Meta could not be reached for the check; will try again.'); else problems.push(`Meta rejected the check: ${dbg.error}`); }
      else {
        tokenInfo = dbg.body?.data || {};
        if (!tokenInfo.is_valid) problems.push('Meta sign-in is no longer valid (password changed, access removed or expired). Connect again.');
        if (tokenInfo.expires_at) set.userTokenExpiresAt = new Date(tokenInfo.expires_at * 1000).toISOString();
        if (tokenInfo.data_access_expires_at) set.dataAccessExpiresAt = new Date(tokenInfo.data_access_expires_at * 1000).toISOString();
      }
    }
    if (userToken && !problems.length) {
      const acc = await readAccount(userToken);
      if (acc.error) { if (/network/.test(acc.error)) warnings.push('Meta could not be reached for the check; will try again.'); else problems.push(`Meta: ${acc.error}`); }
      else {
        set.granted = acc.granted; set.missingPermissions = missing(acc.granted);
        if (set.missingPermissions.length) problems.push(`Permissions not granted: ${set.missingPermissions.join(', ')}. Connect again and allow them.`);
        const pages = acc.pages.map(pageRow); set.pages = pages; set.pageTokensRenewedAt = now.toISOString(); // renewal: fresh Page tokens
        if (d.selected) {
          const p = pages.find((x) => x.id === d.selected.pageId);
          if (!p) problems.push(`The Page "${d.selected.pageName}" is no longer in your authorized Pages.`);
          else if (!p.canPost) problems.push(`You can no longer post on "${d.selected.pageName}".`);
          else if (!p.ig || p.ig.id !== d.selected.igUserId) problems.push(`The Instagram account linked to "${d.selected.pageName}" changed. Choose the Page again.`);
        }
      }
    }
    // Long-lived user tokens: exchange again before they run out (Meta may extend them).
    const expMs = Date.parse(set.userTokenExpiresAt || d.userTokenExpiresAt || '');
    if (userToken && a && !problems.length && Number.isFinite(expMs) && expMs - now.getTime() < RENEW_USER_TOKEN_DAYS * 86400000) {
      const l = await call(graph('/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: a.appId, client_secret: a.appSecret, fb_exchange_token: userToken }));
      if (!l.error && l.body?.access_token) { set.userTokenSealed = vault.seal(l.body.access_token, 'meta:user'); if (l.body.expires_in) set.userTokenExpiresAt = new Date(now.getTime() + Number(l.body.expires_in) * 1000).toISOString(); set.userTokenRenewedAt = now.toISOString(); }
    }
    const reauthMs = Math.min(...[set.dataAccessExpiresAt || d.dataAccessExpiresAt, set.userTokenExpiresAt || d.userTokenExpiresAt].map((x) => Date.parse(x || '')).filter(Number.isFinite));
    if (Number.isFinite(reauthMs) && reauthMs - now.getTime() < WARN_REAUTH_DAYS * 86400000) warnings.push(`Meta will ask you to sign in again by ${new Date(reauthMs).toISOString().slice(0, 10)}. Use "Connect Facebook & Instagram" before then.`);
    set.health = { checkedAt: now.toISOString(), ok: problems.length === 0, problems, warnings };
    await save(set);
    if (problems.length) await alert('meta:connection', 'connection', 'meta', problems[0], now);
    else if (warnings.some((w) => /sign in again/.test(w))) await alert('meta:reauthorize-soon', 'connection', 'meta', warnings.find((w) => /sign in again/.test(w)), now);
    return { ok: problems.length === 0, problems, warnings };
  }

  // ---- status (no secrets) + credentials for the publisher ----
  async function status() {
    const d = await load();
    const a = await app(d);
    const setup = [
      { done: vault.configured, text: 'Encryption for stored sign-ins is set up' },
      { done: Boolean(a), text: a ? `Meta app connected (${a.source}${d?.app?.name ? ': ' + d.app.name : ''})` : 'Meta app App ID and App Secret entered' },
    ];
    let state = 'not_set_up';
    if (vault.configured && a) state = !d?.userTokenSealed ? 'authorization_needed' : (d.missingPermissions || []).length ? 'authorization_needed' : !d.selected ? 'selection_needed' : d.health && !d.health.ok ? 'authorization_needed' : 'connected';
    return {
      state, setup, redirectUri: config.redirectUri, scopes: SCOPES, appId: a?.appId || null, appSource: a?.source || null, loginConfigId: a?.loginConfigId || null,
      user: d?.user || null, authorizedAt: d?.authorizedAt || null, granted: d?.granted || [], missingPermissions: d?.missingPermissions || [],
      pages: (d?.pages || []).map(({ tokenSealed, ...p }) => p), selected: d?.selected || null,
      userTokenExpiresAt: d?.userTokenExpiresAt || null, dataAccessExpiresAt: d?.dataAccessExpiresAt || null, pageTokensRenewedAt: d?.pageTokensRenewedAt || null,
      health: d?.health || null, lastError: d?.lastError || null, expected: config.expected,
    };
  }
  async function credentials(channel) {
    const d = await load();
    if (!d?.selected || !d.userTokenSealed || (d.missingPermissions || []).length || (d.health && !d.health.ok)) return null;
    const p = (d.pages || []).find((x) => x.id === d.selected.pageId);
    if (!p?.tokenSealed || p.ig?.id !== d.selected.igUserId) return null;
    let token; try { token = vault.open(p.tokenSealed, `meta:page:${p.id}`); } catch { return null; }
    if (channel === 'facebook') return { pageId: p.id, token };
    if (channel === 'instagram') return { userId: d.selected.igUserId, token };
    return null;
  }
  return { init, setApp, startAuthorization, handleCallback, selectPage, disconnect, healthCheck, status, credentials, graphUrl: `${config.graphBase}/${config.version}`, liveTestApproved: config.liveTestApproved };
}

module.exports = { createMetaConnect, resolveMetaConfig, SCOPES, REQUIRED };
