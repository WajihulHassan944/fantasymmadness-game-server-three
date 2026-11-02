'use strict';
// Loopback stand-in for Meta's sign-in dialog and Graph API (tests only). It behaves like
// the real endpoints the Growth Engine uses and records every call, so tests can prove
// what was (and was not) sent to Meta. Never reachable outside 127.0.0.1.
const express = require('express');

function createFakeMeta(opts = {}) {
  const st = {
    appId: opts.appId || '1234567890123', appSecret: opts.appSecret || 'a'.repeat(32), appName: 'FMM Growth Engine (test)',
    granted: opts.granted || ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish', 'business_management'],
    userTokenValid: true, expiresIn: opts.expiresIn || 60 * 86400, dataAccessExpiresIn: opts.dataAccessExpiresIn || 90 * 86400,
    pages: opts.pages || [
      { id: '111000111000111', name: 'FANTASY MMADNESS', tasks: ['MANAGE', 'CREATE_CONTENT'], ig: { id: '178400000000001', username: 'fantasymmadness', name: 'FANTASY MMADNESS' } },
      { id: '222000222000222', name: 'Kelly Davis (personal fan page)', tasks: ['CREATE_CONTENT'], ig: null },
      { id: '333000333000333', name: 'Old Promotions Page', tasks: ['ANALYZE'], ig: { id: '178400000000003', username: 'oldpromo', name: 'Old' } },
    ],
    failPublish: null, // e.g. { status: 400, message: '...' }
    denyNext: false,
    calls: [], posts: [], codes: new Map(), tokenSeq: 0,
  };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  const log = (req) => st.calls.push({ method: req.method, path: req.path, query: { ...req.query }, body: { ...(req.body || {}) } });
  const userTokens = new Set(); const pageTokens = new Map(); // token -> pageId
  const tok = (p) => `${p}${Date.now().toString(36)}${(++st.tokenSeq).toString(36)}FAKE${'x'.repeat(20)}`;
  const err = (res, status, message, code = 190) => res.status(status).json({ error: { message, type: 'OAuthException', code } });
  const appTokenOk = (t) => t === `${st.appId}|${st.appSecret}`;
  const userOk = (t) => userTokens.has(t) && st.userTokenValid;

  // Sign-in dialog: shows a page with a Continue button (browser tests) or, with ?auto=1, redirects at once.
  app.get('/:v/dialog/oauth', (req, res) => {
    log(req);
    const { client_id: cid, redirect_uri: ru, state, scope } = req.query;
    if (cid !== st.appId) return res.status(400).send('Invalid App ID');
    const code = `code_${(++st.tokenSeq).toString(36)}`; st.codes.set(code, { ru, scope });
    const target = st.denyNext ? `${ru}?error=access_denied&error_reason=user_denied&state=${encodeURIComponent(state)}` : `${ru}?code=${code}&state=${encodeURIComponent(state)}`;
    st.denyNext = false;
    if (req.query.auto === '1') return res.redirect(302, target);
    res.set('Content-Type', 'text/html').send(`<!doctype html><title>Meta (test)</title><h1>Continue as Kelly?</h1><p>Scopes: ${String(scope).replace(/[<>&]/g, '')}</p><a id="continue" href="${target.replace(/"/g, '&quot;')}">Continue</a>`);
  });
  app.get('/:v/oauth/access_token', (req, res) => {
    log(req);
    const q = req.query;
    if (q.client_id !== st.appId || q.client_secret !== st.appSecret) return err(res, 400, 'Error validating client secret.', 1);
    if (q.grant_type === 'fb_exchange_token') {
      if (!userTokens.has(q.fb_exchange_token)) return err(res, 400, 'Invalid OAuth access token.');
      const t = tok('EAAL'); userTokens.add(t); return res.json({ access_token: t, token_type: 'bearer', expires_in: st.expiresIn });
    }
    const c = st.codes.get(q.code);
    if (!c || c.ru !== q.redirect_uri) return err(res, 400, 'Invalid verification code format.', 100);
    st.codes.delete(q.code);
    const t = tok('EAAS'); userTokens.add(t); return res.json({ access_token: t, token_type: 'bearer', expires_in: 3600 });
  });
  app.get('/:v/debug_token', (req, res) => {
    log(req);
    if (!appTokenOk(req.query.access_token)) return err(res, 400, 'Invalid app token');
    const now = Math.floor(Date.now() / 1000);
    res.json({ data: { app_id: st.appId, is_valid: userOk(req.query.input_token), expires_at: now + st.expiresIn, data_access_expires_at: now + st.dataAccessExpiresIn, scopes: st.granted, user_id: '999' } });
  });
  app.get('/:v/me', (req, res) => { log(req); if (!userOk(req.query.access_token)) return err(res, 401, 'Error validating access token'); res.json({ id: '999', name: 'Kelly Davis' }); });
  app.get('/:v/me/permissions', (req, res) => { log(req); if (!userOk(req.query.access_token)) return err(res, 401, 'Error validating access token'); res.json({ data: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish', 'business_management'].map((p) => ({ permission: p, status: st.granted.includes(p) ? 'granted' : 'declined' })) }); });
  app.delete('/:v/me/permissions', (req, res) => { log(req); userTokens.delete(req.query.access_token); res.json({ success: true }); });
  app.get('/:v/me/accounts', (req, res) => {
    log(req);
    if (!userOk(req.query.access_token)) return err(res, 401, 'Error validating access token');
    res.json({ data: st.pages.map((p) => { const t = tok('EAAP'); pageTokens.set(t, p.id); return { id: p.id, name: p.name, tasks: p.tasks, access_token: t, ...(p.ig ? { instagram_business_account: p.ig } : {}) }; }) });
  });
  const pageOf = (t) => pageTokens.get(t);
  app.get('/:v/:id', (req, res) => {
    log(req);
    const id = req.params.id;
    if (id === st.appId) return appTokenOk(req.query.access_token) ? res.json({ id, name: st.appName }) : err(res, 400, 'Invalid app access token');
    const p = st.pages.find((x) => x.id === id);
    if (p) return pageOf(req.query.access_token) === id ? res.json({ id: p.id, name: p.name, ...(p.ig ? { instagram_business_account: { id: p.ig.id, username: p.ig.username } } : {}) }) : err(res, 400, 'Invalid page token');
    const post = st.posts.find((x) => x.id === id);
    if (post) return res.json({ id, permalink: `https://www.instagram.com/p/${id}/` });
    return err(res, 404, 'Unsupported get request', 100);
  });
  const publishGuard = (req, res, pageId) => {
    if (pageOf(req.body.access_token) !== pageId) { err(res, 400, 'Invalid page access token'); return false; }
    if (st.failPublish) { err(res, st.failPublish.status, st.failPublish.message, 2); return false; }
    return true;
  };
  app.post('/:v/:id/photos', (req, res) => { log(req); if (!publishGuard(req, res, req.params.id)) return; const id = `${req.params.id}_${(++st.tokenSeq)}`; st.posts.push({ id, kind: 'fb_photo', pageId: req.params.id, caption: req.body.caption, url: req.body.url }); res.json({ id: `p${st.tokenSeq}`, post_id: id }); });
  app.post('/:v/:id/feed', (req, res) => { log(req); if (!publishGuard(req, res, req.params.id)) return; const id = `${req.params.id}_${(++st.tokenSeq)}`; st.posts.push({ id, kind: 'fb_feed', pageId: req.params.id, message: req.body.message }); res.json({ id }); });
  const igPage = (igId) => st.pages.find((p) => p.ig?.id === igId)?.id;
  app.post('/:v/:id/media', (req, res) => { log(req); if (!publishGuard(req, res, igPage(req.params.id))) return; const id = `c${++st.tokenSeq}`; st.codes.set(id, { ig: req.params.id, caption: req.body.caption, image: req.body.image_url }); res.json({ id }); });
  app.post('/:v/:id/media_publish', (req, res) => { log(req); if (!publishGuard(req, res, igPage(req.params.id))) return; const c = st.codes.get(req.body.creation_id); if (!c) return err(res, 400, 'Invalid creation id', 100); const id = `1790${++st.tokenSeq}`; st.posts.push({ id, kind: 'ig', igId: req.params.id, caption: c.caption, image: c.image }); res.json({ id }); });

  let server = null;
  return {
    state: st, userTokens, pageTokens,
    listen: () => new Promise((r) => { server = app.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)); }),
    close: () => new Promise((r) => (server ? server.close(() => r()) : r())),
    publishCalls: () => st.calls.filter((c) => c.method === 'POST' && /\/(photos|feed|media|media_publish)$/.test(c.path)),
    allTokens: () => [...userTokens, ...pageTokens.keys()],
  };
}

module.exports = { createFakeMeta };
