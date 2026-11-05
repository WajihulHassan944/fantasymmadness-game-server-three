'use strict';
// Fighter-name fight URLs for Growth Engine campaigns, taken FROM THE WEBSITE ITSELF.
//
// The Growth Engine does not invent its own URL format. For each verified contest it asks
// the website what the fight's address is:
//   1. the ID address (/fight/<id> or /pro-wrestling/play/<id>) redirects to a clean
//      address  -> use it ("redirect")
//   2. the ID page declares <link rel="canonical" href="..."> with a clean address
//      -> use it ("canonical")
//   3. the public contest feed carries canonicalUrl / canonicalPath -> use it ("feed")
// A clean address is used only after it loads (200) on the website, with ?play=1 for
// fights. Otherwise the existing ID address stays (it keeps working as the fallback).
// Query parameters (play=1, affiliate ref=, utm_* campaign tags) are always preserved;
// only the path changes. Results are cached and re-checked every few hours.
const SITE = 'https://www.fantasymmadness.com';
const TTL_MS = 6 * 3600000;
const MAX_PER_RUN = 40;
const NOT_A_FIGHT_PAGE = /^\/(league|affiliate|affiliates|login|signin|administration|api|createaccount|404|500)(\/|$)/i;

const idBaseFor = (c) => (c.sport === 'pro-wrestling' ? `${SITE}/pro-wrestling/play/${encodeURIComponent(c.id)}` : `${SITE}/fight/${encodeURIComponent(c.id)}`);
const playQuery = (c) => (c.sport === 'pro-wrestling' ? '' : '?play=1');
const timeout = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

// A clean address must be on the FANTASY MMADNESS site, a real page path, and not the ID address.
function normalizeCandidate(raw, c) {
  if (!raw) return null;
  let u; try { u = new URL(String(raw).trim(), SITE); } catch { return null; }
  if (u.protocol !== 'https:' || !/^(www\.)?fantasymmadness\.com$/i.test(u.hostname)) return null;
  const path = u.pathname.replace(/\/+$/, '');
  if (!path || path.length > 200 || !/^\/[A-Za-z0-9\-/_.~%]+$/.test(path) || NOT_A_FIGHT_PAGE.test(path)) return null;
  const clean = `${SITE}${path}`;
  if (clean.toLowerCase() === idBaseFor(c).toLowerCase()) return null; // that is the ID address itself
  return clean;
}

async function discover(c, fetchImpl) {
  const idBase = idBaseFor(c);
  const candidates = [];
  if (c.canonicalFromFeed) candidates.push({ url: c.canonicalFromFeed, source: 'feed' });
  let r = null;
  try { r = await fetchImpl(idBase, { method: 'GET', redirect: 'manual', headers: { Accept: 'text/html' }, signal: timeout(8000) }); } catch { r = null; }
  if (r && [301, 302, 303, 307, 308].includes(r.status)) candidates.push({ url: r.headers?.get?.('location'), source: 'redirect' });
  else if (r && r.ok && typeof r.text === 'function') {
    let html = ''; try { html = String(await r.text()).slice(0, 500000); } catch { html = ''; }
    const tag = html.match(/<link\b[^>]*\brel=["']?canonical["']?[^>]*>/i)?.[0] || '';
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (href) candidates.push({ url: href.replace(/&amp;/g, '&'), source: 'canonical' });
  }
  for (const cand of candidates) {
    const clean = normalizeCandidate(cand.url, c);
    if (!clean) continue;
    let ok = false;
    try { const v = await fetchImpl(`${clean}${playQuery(c)}`, { method: 'GET', redirect: 'manual', headers: { Accept: 'text/html' }, signal: timeout(8000) }); ok = v && v.status === 200; } catch { ok = false; }
    if (ok) return { cleanUrl: clean, source: cand.source, reachable: true };
  }
  return { cleanUrl: null, source: 'id', reachable: Boolean(r) };
}

// Swap one fight address for another inside a caption, keeping every query parameter.
function relink(text, fromBase, toBase) {
  if (!text || !fromBase || !toBase || fromBase === toBase) return text;
  const esc = fromBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text).replace(new RegExp(`${esc}(?=[?#\\s]|$)`, 'g'), toBase);
}
// TikTok captions have no clickable link: show the readable fighter-name address instead.
const READABLE = /\s*🔗 fantasymmadness\.com\/\S+/g;
function tiktokLine(text, c) {
  const base = String(text || '').replace(READABLE, '');
  return c.cleanUrl ? `${base} 🔗 ${c.cleanUrl.replace(/^https:\/\/www\./, '')}` : base;
}

// Apply the contest's current address to a campaign's texts (all channels).
function relinkCampaign(draft, c) {
  const from = [draft.contest?.cleanUrl, draft.contest?.idBase || idBaseFor(c)].filter(Boolean);
  const to = c.cleanUrl || c.idBase || idBaseFor(c);
  const swap = (t) => from.reduce((acc, f) => relink(acc, f, to), t);
  const posts = {};
  for (const [ch, t] of Object.entries(draft.posts || {})) posts[ch] = draft.copyVersion===2?(['facebook','x'].includes(ch)?swap(t):t):ch === 'tiktok' ? tiktokLine(t, c) : swap(t);
  return { text: swap(draft.text), posts, link: swap(draft.link) };
}

function createFightUrlResolver({ col, fetchImpl, enabled = true, ttlMs = TTL_MS } = {}) {
  async function init() { if (col) await col.createIndex({ contestId: 1 }, { unique: true }); }
  // Adds idBase, idUrl, cleanUrl, urlSource and the resulting contestUrl to each contest.
  async function enrich(contests, now = new Date()) {
    let budget = MAX_PER_RUN;
    const out = [];
    for (const c0 of contests) {
      const c = { ...c0, idBase: idBaseFor(c0), idUrl: `${idBaseFor(c0)}${playQuery(c0)}` };
      let found = { cleanUrl: null, source: 'id' };
      if (enabled) {
        const cached = col ? await col.findOne({ contestId: c.id }) : null;
        const fresh = cached && cached.idBase === c.idBase && now.getTime() - Date.parse(cached.checkedAt) < ttlMs;
        if (fresh) found = { cleanUrl: cached.cleanUrl, source: cached.source };
        else if (budget > 0) {
          budget--;
          found = await discover(c, fetchImpl);
          if (col && found.reachable !== false) await col.updateOne({ contestId: c.id }, { $set: { contestId: c.id, idBase: c.idBase, cleanUrl: found.cleanUrl, source: found.source, checkedAt: now.toISOString() } }, { upsert: true });
          else if (cached) found = { cleanUrl: cached.cleanUrl, source: cached.source }; // site unreachable: keep the last known answer
        } else if (cached) found = { cleanUrl: cached.cleanUrl, source: cached.source };
      }
      c.cleanUrl = found.cleanUrl || null;
      c.urlSource = found.cleanUrl ? found.source : 'id';
      c.contestUrl = c.cleanUrl ? `${c.cleanUrl}${playQuery(c)}` : c.idUrl;
      delete c.canonicalFromFeed;
      out.push(c);
    }
    return out;
  }
  return { init, enrich };
}

module.exports = { createFightUrlResolver, idBaseFor, relink, relinkCampaign, tiktokLine, normalizeCandidate, SITE };
