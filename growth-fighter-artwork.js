'use strict';
// Approved fighter artwork: discovery, selection and provenance for posters.
//
// Only ORIGINAL, APPROVED images of the EXACT named fighters are ever used:
//   1. contest_upload       - the photo FANTASY MMADNESS attached to this contest for this fighter
//                             (public contest feed: fighterAImage/fighterBImage, wrestling competitor image)
//   2. owner_library        - a photo the owner approved in the Growth Engine for this exact fighter name
//   3. fmm_fighter_library  - the primary photo of the FMM fighter-library record LINKED to this contest,
//                             only when that record's name is exactly the contest fighter's name
// Every image must be on a FANTASY MMADNESS asset host, decode as a real image, be big enough, not be
// blocked by the owner, and the two fighters must not share an image. No web search, no lookalikes,
// no AI faces. If either fighter has no approved photo, the poster falls back to the contest's
// official artwork (if any) or to a text poster flagged NEEDS ARTWORK.
const crypto = require('crypto');
const { checkArtSource, artPolicy, fetchImage } = require('./growth-poster-studio-art');

const clean = (s, n = 200) => String(s ?? '').replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const norm = (s) => clean(s, 200).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const httpsUrl = (u) => (/^https:\/\/[^\s"'<>]+$/i.test(clean(u, 500)) ? clean(u, 500) : null);
const badHealth = (h) => Boolean(h && (h.ok === false || /broken|missing|error/i.test(String(h.status || ''))));

// Candidates published on the contest itself (called from verifyContest; no network).
function contestPhotoCandidates(item, a, b, wrestling) {
  const side = (letter, name) => {
    const out = [];
    if (wrestling) {
      const comp = item[`competitor${letter}`] || {};
      const u = httpsUrl(comp.image || comp.imageUrl);
      if (u) out.push({ url: u, source: 'contest_upload', field: `competitor${letter}.image` });
      return out;
    }
    const lib = item[`fighter${letter}`];
    const own = httpsUrl(item[`fighter${letter}Image`]);
    const libUrl = lib && typeof lib === 'object' ? httpsUrl(lib.primaryImage) : null;
    // The feed fills fighterXImage from the library when the fight has no upload of its own:
    // only call it a contest upload when it is NOT simply the library photo.
    if (own && (item[`fighter${letter}ImageOverride`] || own !== libUrl)) out.push({ url: own, source: 'contest_upload', field: `fighter${letter}Image` });
    if (libUrl && (lib.status || 'active') !== 'inactive' && !badHealth(lib.imageHealth) && norm(lib.displayName) === norm(name)) {
      out.push({ url: libUrl, source: 'fmm_fighter_library', field: `fighter${letter}.primaryImage`, libraryId: clean(lib.id || lib._id, 40) || null, libraryName: clean(lib.displayName, 80) });
    }
    return out;
  };
  return { a: side('A', a), b: side('B', b) };
}

function createArtworkLibrary({ col, fetchImpl = globalThis.fetch, env = {} }) {
  const policy = artPolicy(env);
  async function init() {
    await col.fighterAssets.createIndex({ id: 1 }, { unique: true });
    await col.fighterAssets.createIndex({ fighterKey: 1, status: 1 });
  }
  // Owner approves a photo for one exact fighter name.
  async function approve({ fighterName, imageUrl, rightsNote, admin, now = new Date() }) {
    const name = clean(fighterName, 80); const key = norm(name);
    if (!key || key.length < 3 || !/[a-z]/.test(key)) return { ok: false, reason: 'fighter_name_required' };
    if (!clean(rightsNote)) return { ok: false, reason: 'rights_note_required' };
    const src = checkArtSource({ posterUrl: clean(imageUrl, 500) }, policy);
    if (!src.ok) return { ok: false, reason: src.reason };
    const img = await fetchImage(fetchImpl, src.url);
    if (!img.ok) return { ok: false, reason: img.reason };
    const id = `fa-${crypto.createHash('sha256').update(`${key}|${img.sha256}`).digest('hex').slice(0, 16)}`;
    const other = await col.fighterAssets.findOne({ sha256: img.sha256, fighterKey: { $ne: key }, status: 'approved' });
    if (other) return { ok: false, reason: 'this_image_is_already_approved_for_another_fighter', fighter: other.fighterName };
    const doc = { id, kind: 'approved', fighterKey: key, fighterName: name, url: src.url, sha256: img.sha256, width: img.width, height: img.height, rightsNote: clean(rightsNote, 300), approvedBy: clean(admin, 120), approvedAt: now.toISOString(), status: 'approved' };
    await col.fighterAssets.updateOne({ id }, { $set: doc }, { upsert: true });
    return { ok: true, asset: doc };
  }
  // Owner blocks a specific photo (by address) from ever being used, for any source.
  async function block({ url, note, admin, now = new Date() }) {
    const u = httpsUrl(url); if (!u) return { ok: false, reason: 'image_address_invalid' };
    if (!clean(note)) return { ok: false, reason: 'reason_required' };
    const id = `fb-${crypto.createHash('sha256').update(u).digest('hex').slice(0, 16)}`;
    await col.fighterAssets.updateOne({ id }, { $set: { id, kind: 'block', url: u, note: clean(note, 300), by: clean(admin, 120), at: now.toISOString(), status: 'blocked' } }, { upsert: true });
    return { ok: true };
  }
  async function revoke(id, { admin, now = new Date() } = {}) {
    const r = await col.fighterAssets.updateOne({ id: clean(id, 40), status: { $in: ['approved', 'blocked'] } }, { $set: { status: 'revoked', revokedBy: clean(admin, 120), revokedAt: now.toISOString() } });
    return { ok: r.modifiedCount === 1 };
  }
  async function list() { return (await col.fighterAssets.find({ status: { $in: ['approved', 'blocked'] } }).sort({ fighterName: 1, at: -1 }).limit(500).toArray()).map(({ _id, ...x }) => x); }

  // Choose the artwork for one verified contest. Returns provenance; never throws for bad images.
  async function select(contest, { contestBlocked = null } = {}) {
    const problems = [];
    if (contestBlocked) return { mode: 'text', needsArtwork: true, missing: [contest.fighterA, contest.fighterB], problems: [`artwork_blocked_by_owner: ${contestBlocked.note || ''}`.trim()], fighters: [], contestArt: null };
    const blocked = new Set((await col.fighterAssets.find({ status: 'blocked' }, { projection: { url: 1 } }).toArray()).map((b) => b.url));
    const pick = async (side, name) => {
      const cands = [...(contest.fighterPhotos?.[side] || []).filter((c) => c.source === 'contest_upload')];
      const owned = await col.fighterAssets.find({ fighterKey: norm(name), status: 'approved' }).sort({ approvedAt: -1 }).limit(3).toArray();
      for (const o of owned) cands.push({ url: o.url, source: 'owner_library', assetId: o.id, approvedBy: o.approvedBy, approvedAt: o.approvedAt, rightsNote: o.rightsNote, expectSha: o.sha256 });
      cands.push(...(contest.fighterPhotos?.[side] || []).filter((c) => c.source === 'fmm_fighter_library'));
      for (const c of cands) {
        if (blocked.has(c.url)) { problems.push(`${name}: photo blocked by owner`); continue; }
        const src = checkArtSource({ posterUrl: c.url, posterField: c.field }, policy);
        if (!src.ok) { problems.push(`${name}: ${c.source} ${src.reason}`); continue; }
        const img = await fetchImage(fetchImpl, c.url);
        if (!img.ok) { problems.push(`${name}: ${c.source} ${img.reason}`); continue; }
        if (c.expectSha && c.expectSha !== img.sha256) { problems.push(`${name}: approved photo changed since approval (sha mismatch)`); continue; }
        return { side, name, source: c.source, url: c.url, field: c.field || null, libraryId: c.libraryId || null, libraryName: c.libraryName || null, assetId: c.assetId || null,
          approvedBy: c.approvedBy || null, approvedAt: c.approvedAt || null, rightsNote: c.rightsNote || null,
          basis: c.source === 'contest_upload' ? 'Photo FANTASY MMADNESS attached to this contest for this fighter'
            : c.source === 'owner_library' ? `Approved by the owner for ${name}` : `FANTASY MMADNESS fighter-library photo linked to this contest (${c.libraryName})`,
          sha256: img.sha256, width: img.width, height: img.height, buffer: img.buffer };
      }
      return null;
    };
    const A = await pick('a', contest.fighterA); const B = await pick('b', contest.fighterB);
    if (A && B && A.sha256 === B.sha256) { problems.push('the same image was offered for both fighters: not used'); }
    else if (A && B) return { mode: 'fighter_photos', needsArtwork: false, missing: [], problems, fighters: [A, B], contestArt: null };
    const missing = [[A, contest.fighterA], [B, contest.fighterB]].filter(([x]) => !x || (A && B)).map(([, n]) => n);
    // Fall back to the contest's official artwork (one approved image of the matchup).
    const src = checkArtSource(contest, policy);
    if (src.ok && !blocked.has(src.url)) {
      const img = await fetchImage(fetchImpl, src.url);
      if (img.ok) return { mode: 'contest_artwork', needsArtwork: false, missing, problems, fighters: [], contestArt: { url: src.url, basis: src.basis, sha256: img.sha256, width: img.width, height: img.height, buffer: img.buffer } };
      problems.push(`contest artwork: ${img.reason}`);
    } else problems.push(`contest artwork: ${src.ok ? 'blocked by owner' : src.reason}`);
    return { mode: 'text', needsArtwork: true, missing, problems, fighters: [], contestArt: null };
  }
  return { init, approve, block, revoke, list, select, policy };
}

module.exports = { contestPhotoCandidates, createArtworkLibrary, norm };
