'use strict';
// Test fixture: stand-in for the public sources used by PR/affiliate research — Apple
// Podcasts search + lookup, each show's RSS feed, and DNS-over-HTTPS MX lookups. Used only by
// tests; production reads the real public sources. Per search term it returns three shows:
//   show 1: publishes a business email (itunes:owner) and discussed an upcoming fixture fight
//   show 2: only a hosting-platform address (must be rejected, no email drafted)
//   show 3: no published contact at all (owner can add one manually)
const FIGHTER = { boxing: 'Inoue', 'mma-ufc': 'Dvalishvili', kickboxing: 'Superbon', 'bare-knuckle': 'Perry', 'pro-wrestling': 'Omega' };
const TERM_SPORT = { 'boxing podcast': 'boxing', 'MMA UFC podcast': 'mma-ufc', 'kickboxing podcast': 'kickboxing', 'bare knuckle boxing podcast': 'bare-knuckle', 'professional wrestling podcast': 'pro-wrestling' };
const SPORT_WORD = { boxing: 'boxing', 'mma-ufc': 'UFC', kickboxing: 'kickboxing', 'bare-knuckle': 'bare knuckle', 'pro-wrestling': 'wrestling' };
const json = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) });
const xml = (body) => ({ ok: true, status: 200, headers: { get: () => 'application/rss+xml' }, text: async () => body, json: async () => ({}) });
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function researchWeb({ now = () => Date.now(), searchSize = 3 } = {}) {
  const shows = new Map(); // id -> { sport, n, slug, term }
  const idFor = (term, n) => 900000 + (Object.keys(TERM_SPORT).indexOf(term) + 1) * 10 + n;
  return async function fetchFixture(url) {
    let u; try { u = new URL(String(url)); } catch { return null; }
    if (u.hostname === 'itunes.apple.com' && u.pathname === '/search') {
      const term = u.searchParams.get('term'); const sport = TERM_SPORT[term];
      if (!sport) return json({ results: [] });
      const slug = term.replace(/[^a-z]+/gi, '-').toLowerCase();
      return json({ results: Array.from({ length: searchSize }, (_, i) => i + 1).map((n) => { const id = idFor(term, n); shows.set(String(id), { sport, n, slug, term }); return { collectionId: id, collectionName: `${term} show ${n}`, collectionViewUrl: `https://podcasts.apple.com/us/podcast/${slug}-${n}/id${id}` }; }) });
    }
    if (u.hostname === 'itunes.apple.com' && u.pathname === '/lookup') {
      const id = u.searchParams.get('id'); const s = shows.get(id);
      if (!s) return json({ results: [] });
      return json({ results: [{ collectionId: Number(id), artistName: s.n === 1 ? 'Dana Rivers' : 'Studio Team', trackCount: 140, genres: s.sport === 'mma-ufc' ? ['Sports News'] : ['Sports'], feedUrl: `https://feeds.fixture-shows.test/${id}.xml` }] });
    }
    if (u.hostname === 'feeds.fixture-shows.test') {
      const id = u.pathname.replace(/^\/|\.xml$/g, ''); const s = shows.get(id);
      if (!s) return { ok: false, status: 404, text: async () => '' };
      const day = (d) => new Date(now() - d * 86400000).toUTCString();
      const owner = s.n === 1 ? `<itunes:owner><itunes:name>Dana Rivers</itunes:name><itunes:email>bookings@${s.slug}-${s.n}.example</itunes:email></itunes:owner>`
        : s.n === 2 ? '<itunes:owner><itunes:name>Host</itunes:name><itunes:email>podcasts1@anchor.fm</itunes:email></itunes:owner>' : '';
      const ep1 = s.n === 1 ? `${FIGHTER[s.sport]} preview and ${SPORT_WORD[s.sport]} picks` : `Weekly ${SPORT_WORD[s.sport]} roundup`;
      return xml(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>${esc(s.term)} show ${s.n}</title><link>https://${s.slug}-${s.n}.example</link><itunes:author>${s.n === 1 ? 'Dana Rivers' : 'Studio Team'}</itunes:author>${owner}`
        + `<item><title>${esc(ep1)}</title><pubDate>${day(3)}</pubDate></item><item><title>${esc(SPORT_WORD[s.sport])} news and results</title><pubDate>${day(10)}</pubDate></item><item><title>Mailbag</title><pubDate>${day(17)}</pubDate></item></channel></rss>`);
    }
    if (u.hostname === 'cloudflare-dns.com' && u.searchParams.get('type') === 'MX') {
      const name = u.searchParams.get('name') || '';
      return json(/\.example$/.test(name) ? { Answer: [{ name, type: 15, data: `10 mx.${name}` }] } : { Status: 3 });
    }
    return null;
  };
}

module.exports = { researchWeb, FIGHTER };
