'use strict';
// Social-media publishing for owner-approved fight campaigns: Facebook Page,
// Instagram (business account), X and TikTok. FAILS CLOSED.
//
//   provider "none"    (default) nothing is published; due posts are held.
//   provider "sandbox" simulated publishing recorded in fmgrowthtest only
//                      (receipts are marked sandbox and never count as real posts).
//   provider "live"    real posting, per channel, ONLY when the owner approval
//                      flag, the channel allowlist and that channel's credentials
//                      are all present.
// Tokens are never logged or returned.
const crypto = require('crypto');

const CHANNELS = Object.freeze(['facebook', 'instagram', 'x', 'tiktok']);
const META_CHANNELS = ['facebook', 'instagram'];
const META_BLOCKER = 'Connect Facebook & Instagram (Growth Engine → Connections)';
const GRAPH = 'https://graph.facebook.com/v21.0';
const clean = (s, n = 300) => String(s ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ').slice(0, n);

function resolveSocialConfig(env = {}) {
  const provider = String(env.GROWTH_SOCIAL_PROVIDER || 'none');
  const errors = [];
  if (!['none', 'sandbox', 'live'].includes(provider)) errors.push(`Unknown GROWTH_SOCIAL_PROVIDER "${provider}"`);
  const approved = env.GROWTH_SOCIAL_PUBLISHING_APPROVED === 'true';
  const allow = new Set(String(env.GROWTH_SOCIAL_CHANNELS_ENABLED || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  const need = {
    facebook: [['GROWTH_FB_PAGE_ID', /^\d{5,30}$/], ['GROWTH_FB_PAGE_ACCESS_TOKEN', /^.{20,}$/]],
    instagram: [['GROWTH_IG_USER_ID', /^\d{5,30}$/], ['GROWTH_IG_ACCESS_TOKEN', /^.{20,}$/]],
    x: [['GROWTH_X_USER_ACCESS_TOKEN', /^.{20,}$/]],
    tiktok: [['GROWTH_TIKTOK_ACCESS_TOKEN', /^.{20,}$/]],
  };
  const channels = {};
  for (const ch of CHANNELS) {
    const blockers = [];
    if (provider === 'none') blockers.push('Publishing provider is "none" (nothing is published)');
    if (provider === 'live') {
      if (!approved) blockers.push('GROWTH_SOCIAL_PUBLISHING_APPROVED (owner approval) must be "true"');
      if (!allow.has(ch)) blockers.push(`${ch} is not listed in GROWTH_SOCIAL_CHANNELS_ENABLED`);
      const envOk = need[ch].every(([k, re]) => re.test(String(env[k] || '')));
      // Facebook/Instagram: credentials come from the Meta connection (Connections screen)
      // unless they are set as environment variables.
      if (!envOk && META_CHANNELS.includes(ch)) blockers.push(META_BLOCKER);
      else for (const [k, re] of need[ch]) if (!re.test(String(env[k] || ''))) blockers.push(`${k} is missing or invalid`);
    }
    const tiktokMode = ch === 'tiktok' ? (env.GROWTH_TIKTOK_DIRECT_POST_APPROVED === 'true' ? 'DIRECT_POST' : 'MEDIA_UPLOAD') : null;
    channels[ch] = {
      ready: provider !== 'none' && blockers.length === 0, mode: provider === 'live' && blockers.length === 0 ? 'live' : provider === 'sandbox' ? 'sandbox' : 'off', blockers,
      needsImage: ch === 'instagram' || ch === 'tiktok',
      note: ch === 'tiktok' ? (tiktokMode === 'DIRECT_POST' ? 'Posts publicly (TikTok audit approved).' : 'Sends to your TikTok inbox as a draft; you finish posting in the TikTok app (until TikTok approves direct posting).') : null,
      tiktokMode,
    };
  }
  const secrets = {
    facebook: { pageId: String(env.GROWTH_FB_PAGE_ID || ''), token: String(env.GROWTH_FB_PAGE_ACCESS_TOKEN || '') },
    instagram: { userId: String(env.GROWTH_IG_USER_ID || ''), token: String(env.GROWTH_IG_ACCESS_TOKEN || '') },
    x: { token: String(env.GROWTH_X_USER_ACCESS_TOKEN || '') },
    tiktok: { token: String(env.GROWTH_TIKTOK_ACCESS_TOKEN || '') },
  };
  return { provider, approved, paused: env.GROWTH_SOCIAL_PAUSED === 'true', channels, errors, secrets };
}

// X counts every link as 23 characters and most emoji/CJK as 2.
function xWeightedLength(text) {
  let n = 0; const t = String(text || '').replace(/https?:\/\/\S+/g, (m) => { n += 23; return ''; });
  for (const ch of t) { const cp = ch.codePointAt(0); n += (cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037)) ? 1 : 2; }
  return n;
}

// What each platform can really do through this engine (kept truthful; shown to the owner).
const PLATFORM_CAPABILITIES = Object.freeze({
  facebook: { media: 'poster image (Page photo post)', posterFormat: 'portrait 1080x1350', clickableLinks: true, captionLimit: 63206, implemented: true,
    requires: ['Facebook Page connected (Connections)', 'pages_manage_posts permission', 'owner authorization for real posts'] },
  instagram: { media: 'poster image (JPEG, 4:5 to 1.91:1, max 8 MB)', posterFormat: 'portrait 1080x1350', clickableLinks: false, captionLimit: 2200, hashtagLimit: 30, implemented: true,
    requires: ['Instagram professional account linked to the Page', 'instagram_content_publish permission', 'image hosted at a public https address', 'owner authorization for real posts'], note: 'Links in captions are not clickable: the QR code on the poster carries the contest link.' },
  x: { media: 'text and link only (poster not attached)', posterFormat: null, clickableLinks: true, captionLimit: 280, implemented: true,
    requires: ['X user access token with tweet.write (GROWTH_X_USER_ACCESS_TOKEN)', 'owner authorization for real posts'], note: 'Attaching the poster needs X media upload (media.write); not enabled yet, so X posts are text + link.' },
  tiktok: { media: 'poster photo (PULL_FROM_URL)', posterFormat: 'story 1080x1920', clickableLinks: false, captionLimit: 4000, implemented: true,
    requires: ['TikTok Content Posting API app with video.publish / video.upload scope', 'the poster address domain verified in the TikTok developer portal (PULL_FROM_URL)', 'TikTok audit for public direct posting (until then: inbox drafts)', 'owner authorization for real posts'], note: 'Captions are not clickable: the QR code on the poster carries the contest link.' },
});

// Instagram accepts JPEG images only: ask Cloudinary for a JPEG rendition of the poster.
function instagramImageUrl(url) {
  const u = String(url || '');
  if (/^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\//.test(u) && !/\/upload\/[^/]*f_jpg/.test(u)) return u.replace('/image/upload/', '/image/upload/f_jpg,q_auto/');
  return u;
}

// Checks Meta would apply, run before any post (sandbox and live). Read-only.
async function preflight(post, { fetchImpl } = {}) {
  const problems = []; const notes = [];
  const text = String(post.text || '');
  if (!text.trim()) problems.push('caption is empty');
  if (post.channel === 'instagram') {
    if ([...text].length > 2200) problems.push('Instagram caption is longer than 2,200 characters');
    if ((text.match(/#[\p{L}\p{N}_]+/gu) || []).length > 30) problems.push('Instagram allows at most 30 hashtags');
    if ((text.match(/(^|\s)@[A-Za-z0-9_.]+/g) || []).length > 20) problems.push('Instagram allows at most 20 @mentions');
    if (!post.imageUrl) problems.push('Instagram requires an image (the fight has no poster image)');
  }
  if (post.channel === 'facebook' && [...text].length > 63206) problems.push('Facebook post is too long');
  if (post.channel === 'x') { const n = xWeightedLength(text); if (n > 280) problems.push(`X post is ${n} characters (limit 280; links count as 23)`); if (post.imageUrl) notes.push('X: text post with link; the poster is not attached (X media upload not enabled)'); }
  if (post.channel === 'tiktok') { if ([...text].length > 4000) problems.push('TikTok description is longer than 4,000 characters'); if (!post.imageUrl) problems.push('TikTok requires an image'); notes.push('TikTok: captions are not clickable; the poster QR code and "link in bio" carry the link'); }
  const img = post.channel === 'instagram' ? instagramImageUrl(post.imageUrl) : post.imageUrl;
  if (img) {
    if (!/^https:\/\//.test(img)) problems.push('image must be a public https address');
    else if (fetchImpl) {
      try {
        const r = await fetchImpl(img, { method: 'HEAD', signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
        const type = String(r.headers?.get?.('content-type') || ''); const size = Number(r.headers?.get?.('content-length') || 0);
        if (!r.ok) problems.push(`image could not be loaded (HTTP ${r.status})`);
        else {
          if (post.channel === 'instagram' && type && !/image\/jpe?g/i.test(type)) problems.push(`Instagram needs a JPEG image (got ${type})`);
          if (post.channel === 'instagram' && size > 8 * 1024 * 1024) problems.push('Instagram images must be 8 MB or smaller');
          if (!/^image\//i.test(type) && type) problems.push(`image address does not return an image (${type})`);
          const iw = Number(r.headers?.get?.('x-image-width') || 0); const ih = Number(r.headers?.get?.('x-image-height') || 0);
          if (post.channel === 'instagram' && iw && ih && (iw / ih < 0.8 - 1e-3 || iw / ih > 1.91 + 1e-3)) problems.push(`Instagram feed images must be between 4:5 and 1.91:1 (got ${iw}x${ih})`);
          notes.push(`image checked (${type || 'type unknown'}${size ? ', ' + Math.round(size / 1024) + ' KB' : ''})`);
        }
      } catch (e) { notes.push('image could not be checked right now (network)'); }
    }
  }
  return { ok: problems.length === 0, problems, notes, imageUrl: img || null };
}

// Result: { ok:true, receipt:{ providerPostId, url, sandbox, pending? } } or
//         { ok:false, retryable, reason }
// meta: Meta connection (growth-meta-connect) supplying Facebook/Instagram credentials.
function createSocialPublisher({ social, fetchImpl = globalThis.fetch, sandboxCollection = null, meta = null, graphUrl = GRAPH, checkImages = true } = {}) {
  const s = social.secrets || {};
  const fail = (reason, retryable) => ({ ok: false, retryable, reason: clean(reason, 300) });
  const envCreds = (ch) => (ch === 'facebook' && s.facebook?.pageId && s.facebook?.token ? { pageId: s.facebook.pageId, token: s.facebook.token }
    : ch === 'instagram' && s.instagram?.userId && s.instagram?.token ? { userId: s.instagram.userId, token: s.instagram.token } : null);
  async function credentials(ch) {
    if (ch === 'x') return s.x?.token ? { token: s.x.token } : null;
    if (ch === 'tiktok') return s.tiktok?.token ? { token: s.tiktok.token } : null;
    return envCreds(ch) || (meta ? meta.credentials(ch) : null);
  }
  // Channel readiness, including the live Meta connection (checked every time).
  async function channelState(chName) {
    const base = social.channels?.[chName];
    if (!base) return { ready: false, mode: 'off', blockers: ['unknown channel'] };
    if (!base.blockers.includes(META_BLOCKER)) return base;
    const blockers = base.blockers.filter((b) => b !== META_BLOCKER);
    if (!(await credentials(chName))) blockers.push(META_BLOCKER);
    return { ...base, blockers, ready: blockers.length === 0, mode: blockers.length === 0 ? 'live' : 'off' };
  }
  async function call(url, opts) {
    let r;
    try { r = await fetchImpl(url, opts); } catch (e) { return { error: fail(`network error: ${e.message}`, true) }; }
    let body = null; try { body = await r.json(); } catch { body = null; }
    if (!r.ok) {
      const msg = body?.error?.message || body?.detail || body?.title || body?.error?.code || `HTTP ${r.status}`;
      return { error: fail(`${r.status}: ${msg}`, r.status === 429 || r.status >= 500) };
    }
    return { body };
  }
  const form = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
  const adapters = {
    async facebook(post, c) {
      const base = `${graphUrl}/${encodeURIComponent(c.pageId)}`;
      const { body, error } = post.imageUrl
        ? await call(`${base}/photos`, form({ url: post.imageUrl, caption: post.text, access_token: c.token }))
        : await call(`${base}/feed`, form({ message: post.text, access_token: c.token }));
      if (error) return error;
      const id = String(body?.post_id || body?.id || '');
      return id ? { ok: true, receipt: { providerPostId: id, url: `https://www.facebook.com/${id}`, sandbox: false } } : fail('Facebook returned no post id', false);
    },
    async instagram(post, c) {
      if (!post.imageUrl) return fail('Instagram requires an image (the fight has no poster image)', false);
      const base = `${graphUrl}/${encodeURIComponent(c.userId)}`;
      const m = await call(`${base}/media`, form({ image_url: instagramImageUrl(post.imageUrl), caption: post.text, access_token: c.token }));
      if (m.error) return m.error;
      if (!m.body?.id) return fail('Instagram returned no media container id', false);
      const p = await call(`${base}/media_publish`, form({ creation_id: m.body.id, access_token: c.token }));
      if (p.error) return p.error;
      if (!p.body?.id) return fail('Instagram returned no post id', false);
      const link = await call(`${graphUrl}/${encodeURIComponent(p.body.id)}?${new URLSearchParams({ fields: 'permalink', access_token: c.token })}`, { method: 'GET' });
      return { ok: true, receipt: { providerPostId: String(p.body.id), url: link.body?.permalink || null, sandbox: false } };
    },
    async x(post, c) {
      const { body, error } = await call('https://api.x.com/2/tweets', { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: post.text }) });
      if (error) return error;
      const id = String(body?.data?.id || '');
      return id ? { ok: true, receipt: { providerPostId: id, url: `https://x.com/i/web/status/${id}`, sandbox: false } } : fail('X returned no post id', false);
    },
    async tiktok(post, c) {
      if (!post.imageUrl) return fail('TikTok requires an image or video (the fight has no poster image)', false);
      const mode = social.channels.tiktok.tiktokMode;
      const payload = {
        media_type: 'PHOTO', post_mode: mode,
        post_info: { title: clean(post.text, 90), description: clean(post.text, 2000), ...(mode === 'DIRECT_POST' ? { privacy_level: 'PUBLIC_TO_EVERYONE' } : {}) },
        source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: [post.imageUrl] },
      };
      const { body, error } = await call('https://open.tiktokapis.com/v2/post/publish/content/init/', { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(payload) });
      if (error) return error;
      if (body?.error?.code && body.error.code !== 'ok') return fail(`TikTok: ${body.error.code}`, false);
      const id = String(body?.data?.publish_id || '');
      return id ? { ok: true, receipt: { providerPostId: id, url: null, sandbox: false, pending: mode === 'MEDIA_UPLOAD' ? 'in_tiktok_inbox_as_draft' : 'processing' } } : fail('TikTok returned no publish id', false);
    },
  };
  async function realPost(post) {
    const c = await credentials(post.channel);
    if (!c) return fail(post.channel === 'facebook' || post.channel === 'instagram' ? 'Facebook & Instagram are not connected (Growth Engine → Connections)' : `${post.channel} credentials are missing`, false);
    const pf = META_CHANNELS.includes(post.channel) ? await preflight(post, { fetchImpl: checkImages ? fetchImpl : null }) : { ok: true };
    if (!pf.ok) return fail(`not posted: ${pf.problems.join('; ')}`, false);
    return adapters[post.channel](post, c);
  }
  async function publish(post) {
    const ch = await channelState(post.channel);
    if (!ch.ready) return fail(`channel not authorized: ${(ch.blockers || ['unknown channel']).join('; ')}`, false);
    if (social.paused) return fail('publishing is paused', true);
    if (ch.needsImage && !post.imageUrl) return fail(`${post.channel} requires an image (the fight has no poster image)`, false);
    if (ch.mode === 'sandbox') {
      // Simulated: nothing reaches Meta. The same checks Meta applies are run read-only.
      const pf = await preflight(post, { fetchImpl: checkImages && post.channel !== 'x' ? fetchImpl : null });
      if (!pf.ok) return fail(`sandbox check failed: ${pf.problems.join('; ')}`, false);
      const connected = META_CHANNELS.includes(post.channel) ? Boolean(await credentials(post.channel)) : null;
      const id = `sandbox-${post.channel}-${crypto.randomBytes(6).toString('hex')}`;
      if (sandboxCollection) await sandboxCollection.insertOne({ id, postId: post.id, channel: post.channel, text: post.text, imageUrl: pf.imageUrl || post.imageUrl || null, preflight: { problems: pf.problems, notes: pf.notes }, connectedAccount: connected, at: new Date().toISOString() });
      return { ok: true, receipt: { providerPostId: id, url: null, sandbox: true, preflight: pf.notes || [], connectedAccount: connected } };
    }
    return realPost(post);
  }
  // Controlled live test: real post through the connected account even while the
  // provider is "sandbox". Callers must enforce the owner's explicit authorization.
  async function publishLive(post) { if (social.paused) return fail('publishing is paused', false); return realPost(post); }
  return { publish, publishLive, channelState, credentials, preflight: (post) => preflight(post, { fetchImpl: checkImages ? fetchImpl : null }) };
}

module.exports = { CHANNELS, META_CHANNELS, META_BLOCKER, PLATFORM_CAPABILITIES, xWeightedLength, resolveSocialConfig, createSocialPublisher, instagramImageUrl, preflight };
