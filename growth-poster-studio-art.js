'use strict';
// Artwork rights helpers shared by the poster studio and the fighter-artwork library.
const crypto = require('crypto');
let sharpLib = null;
const sharp = () => (sharpLib ||= require('sharp'));
const ART_TYPES = /^image\/(jpeg|png|webp)$/i;
const MAX_ART_BYTES = 12 * 1024 * 1024;
const MIN_ART_SIDE = 300;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const clean = (s, n = 200) => String(s ?? '').replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// ---- artwork rights ------------------------------------------------------------------
// FANTASY MMADNESS asset hosts. Cloudinary is where the owner's admin uploads fight art;
// GROWTH_ART_CLOUDINARY_CLOUDS (comma list) can narrow it to the FMM cloud name(s).
function artPolicy(env = {}) {
  const clouds = String(env.GROWTH_ART_CLOUDINARY_CLOUDS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const extraHosts = String(env.GROWTH_ART_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h));
  return { clouds, hosts: ['www.fantasymmadness.com', 'fantasymmadness.com', ...extraHosts] };
}
function checkArtSource(contest, policy, block = null) {
  const url = contest?.posterUrl;
  if (!url) return { ok: false, reason: 'no_official_artwork_on_this_contest' };
  if (block) return { ok: false, reason: 'artwork_blocked_by_owner', note: block.note || null };
  let u; try { u = new URL(url); } catch { return { ok: false, reason: 'artwork_address_invalid' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'artwork_not_https' };
  const host = u.hostname.toLowerCase();
  if (host === 'res.cloudinary.com') {
    const m = u.pathname.match(/^\/([^/]+)\/image\/upload\//);
    if (!m) return { ok: false, reason: 'artwork_not_an_uploaded_image' };
    if (policy.clouds.length && !policy.clouds.includes(m[1].toLowerCase())) return { ok: false, reason: 'artwork_not_on_the_fantasy_mmadness_cloud' };
  } else if (!policy.hosts.includes(host)) return { ok: false, reason: 'artwork_host_not_a_fantasy_mmadness_asset_host' };
  return { ok: true, url, host, basis: `Official artwork published by FANTASY MMADNESS on this contest (${contest.posterField || 'contest poster'})` };
}

async function fetchImage(fetchImpl, url, { maxBytes = MAX_ART_BYTES } = {}) {
  let r; try { r = await fetchImpl(url, { headers: { Accept: 'image/jpeg,image/png,image/webp' }, redirect: 'error' }); } catch (e) { return { ok: false, reason: `artwork_unreachable: ${clean(e.message, 120)}` }; }
  if (!r || !r.ok) return { ok: false, reason: `artwork_http_${r ? r.status : 'none'}` };
  const type = String(r.headers.get('content-type') || '').split(';')[0].trim();
  if (!ART_TYPES.test(type)) return { ok: false, reason: `artwork_not_an_image (${type || 'unknown type'})` };
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length || buf.length > maxBytes) return { ok: false, reason: 'artwork_size_out_of_range' };
  let meta; try { meta = await sharp()(buf).metadata(); } catch { return { ok: false, reason: 'artwork_could_not_be_decoded' }; }
  if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < MIN_ART_SIDE) return { ok: false, reason: 'artwork_too_small' };
  return { ok: true, buffer: buf, type, width: meta.width, height: meta.height, sha256: sha(buf) };
}

module.exports = { artPolicy, checkArtSource, fetchImage, MIN_ART_SIDE };
