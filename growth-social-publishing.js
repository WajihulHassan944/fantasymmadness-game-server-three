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
      for (const [k, re] of need[ch]) if (!re.test(String(env[k] || ''))) blockers.push(`${k} is missing or invalid`);
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

// Result: { ok:true, receipt:{ providerPostId, url, sandbox, pending? } } or
//         { ok:false, retryable, reason }
function createSocialPublisher({ social, fetchImpl = globalThis.fetch, sandboxCollection = null } = {}) {
  const s = social.secrets;
  const fail = (reason, retryable) => ({ ok: false, retryable, reason: clean(reason, 300) });
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
  const adapters = {
    async facebook(post) {
      const p = new URLSearchParams({ access_token: s.facebook.token });
      let url = `${GRAPH}/${encodeURIComponent(s.facebook.pageId)}/feed`;
      if (post.imageUrl) { url = `${GRAPH}/${encodeURIComponent(s.facebook.pageId)}/photos`; p.set('url', post.imageUrl); p.set('caption', post.text); }
      else p.set('message', post.text);
      const { body, error } = await call(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: p.toString() });
      if (error) return error;
      const id = String(body?.post_id || body?.id || '');
      return id ? { ok: true, receipt: { providerPostId: id, url: `https://www.facebook.com/${id}`, sandbox: false } } : fail('Facebook returned no post id', false);
    },
    async instagram(post) {
      if (!post.imageUrl) return fail('Instagram requires an image (the fight has no poster image)', false);
      const base = `${GRAPH}/${encodeURIComponent(s.instagram.userId)}`;
      const c = await call(`${base}/media`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ image_url: post.imageUrl, caption: post.text, access_token: s.instagram.token }).toString() });
      if (c.error) return c.error;
      if (!c.body?.id) return fail('Instagram returned no media container id', false);
      const p = await call(`${base}/media_publish`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ creation_id: c.body.id, access_token: s.instagram.token }).toString() });
      if (p.error) return p.error;
      return p.body?.id ? { ok: true, receipt: { providerPostId: String(p.body.id), url: null, sandbox: false } } : fail('Instagram returned no post id', false);
    },
    async x(post) {
      const { body, error } = await call('https://api.x.com/2/tweets', { method: 'POST', headers: { Authorization: `Bearer ${s.x.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: post.text }) });
      if (error) return error;
      const id = String(body?.data?.id || '');
      return id ? { ok: true, receipt: { providerPostId: id, url: `https://x.com/i/web/status/${id}`, sandbox: false } } : fail('X returned no post id', false);
    },
    async tiktok(post) {
      if (!post.imageUrl) return fail('TikTok requires an image or video (the fight has no poster image)', false);
      const mode = social.channels.tiktok.tiktokMode;
      const payload = {
        media_type: 'PHOTO', post_mode: mode,
        post_info: { title: clean(post.text, 90), description: clean(post.text, 2000), ...(mode === 'DIRECT_POST' ? { privacy_level: 'PUBLIC_TO_EVERYONE' } : {}) },
        source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: [post.imageUrl] },
      };
      const { body, error } = await call('https://open.tiktokapis.com/v2/post/publish/content/init/', { method: 'POST', headers: { Authorization: `Bearer ${s.tiktok.token}`, 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(payload) });
      if (error) return error;
      if (body?.error?.code && body.error.code !== 'ok') return fail(`TikTok: ${body.error.code}`, false);
      const id = String(body?.data?.publish_id || '');
      return id ? { ok: true, receipt: { providerPostId: id, url: null, sandbox: false, pending: mode === 'MEDIA_UPLOAD' ? 'in_tiktok_inbox_as_draft' : 'processing' } } : fail('TikTok returned no publish id', false);
    },
  };
  async function publish(post) {
    const ch = social.channels[post.channel];
    if (!ch || !ch.ready) return fail(`channel not authorized: ${(ch?.blockers || ['unknown channel']).join('; ')}`, false);
    if (social.paused) return fail('publishing is paused', true);
    if (ch.needsImage && !post.imageUrl) return fail(`${post.channel} requires an image (the fight has no poster image)`, false);
    if (ch.mode === 'sandbox') {
      const id = `sandbox-${post.channel}-${crypto.randomBytes(6).toString('hex')}`;
      if (sandboxCollection) await sandboxCollection.insertOne({ id, postId: post.id, channel: post.channel, text: post.text, imageUrl: post.imageUrl || null, at: new Date().toISOString() });
      return { ok: true, receipt: { providerPostId: id, url: null, sandbox: true } };
    }
    return adapters[post.channel](post);
  }
  return { publish };
}

module.exports = { CHANNELS, resolveSocialConfig, createSocialPublisher };
