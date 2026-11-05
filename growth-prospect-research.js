'use strict';
// Prospect research for PR and affiliate recruitment (read-only, public sources only).
//
// For each discovered show (Apple Podcasts listing):
//   1. Apple Podcasts lookup API -> the show's own public RSS feed address.
//   2. The show's RSS feed -> title, author, website, recent episode titles/dates and the
//      business contact the show PUBLISHES for itself (<itunes:owner><itunes:email>, or
//      <managingEditor>). Nothing is guessed: if the feed publishes no usable address,
//      the prospect has no contact route and no email is drafted.
//   3. Contact eligibility: valid syntax, not a hosting-platform/no-reply address, not
//      suppressed (opt-out), and the domain accepts mail (public DNS MX lookup).
//   4. Evidence: recent episodes, sport relevance, fighters/events in verified upcoming
//      FANTASY MMADNESS contests mentioned by the show.
// The result feeds personalized drafts that still need the owner's approval; nothing here
// sends anything.
const Parser = require('rss-parser');

const parser = new Parser({ customFields: { feed: [['itunes:owner', 'itunesOwner'], ['managingEditor', 'managingEditor'], ['itunes:author', 'itunesAuthor']] } });
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}$/;
// Addresses that belong to a hosting platform or are not monitored — never the show itself.
const PLATFORM_DOMAINS = /(^|\.)(anchor\.fm|spotify\.com|podcasters\.spotify\.com|libsyn\.com|buzzsprout\.com|podbean\.com|megaphone\.fm|simplecast\.com|iheart\.com|iheartmedia\.com|audioboom\.com|spreaker\.com|soundcloud\.com|transistor\.fm|captivate\.fm|redcircle\.com|acast\.com|omny\.fm|art19\.com|podomatic\.com|blubrry\.com|castos\.com|riverside\.fm|example\.com|example\.org|invalid|localhost)$/i;
const UNMONITORED = /^(no-?reply|do-?not-?reply|bounce|mailer-daemon|postmaster|abuse|privacy|dmca|legal|unsubscribe)([+.\-_]|@)/i;
const SPORT_WORDS = {
  boxing: /\b(boxing|boxer|bout|heavyweight|welterweight|middleweight|canelo|undercard|ring)\b/i,
  'mma-ufc': /\b(mma|ufc|octagon|bellator|pfl|one championship|cage|submission)\b/i,
  kickboxing: /\b(kickboxing|muay thai|glory|k-?1|one championship)\b/i,
  'bare-knuckle': /\b(bare[- ]knuckle|bkfc|bkb)\b/i,
  'pro-wrestling': /\b(wrestling|wwe|aew|njpw|raw|smackdown|dynamite|wrestlemania|tna|roh)\b/i,
};
const clean = (s, n = 300) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const appleId = (url) => String(url || '').match(/\/id(\d{4,15})(?:[/?#]|$)/)?.[1] || null;

function extractContact(feed) {
  const owner = feed.itunesOwner || {};
  const pick = (v) => (Array.isArray(v) ? v[0] : v);
  const ownerEmail = clean(pick(owner['itunes:email']) || pick(owner.email), 254).toLowerCase();
  const ownerName = clean(pick(owner['itunes:name']) || pick(owner.name), 120);
  if (ownerEmail) return { email: ownerEmail, name: ownerName || null, field: 'itunes:owner / itunes:email' };
  const me = clean(feed.managingEditor, 254);
  const m = me.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/);
  if (m) return { email: m[0].toLowerCase(), name: clean(me.replace(m[0], '').replace(/[()]/g, ''), 120) || null, field: 'managingEditor' };
  return null;
}

function contactProblems(email) {
  if (!email) return ['the show publishes no business email in its feed'];
  const out = [];
  if (!EMAIL.test(email)) out.push('address is not valid');
  const domain = email.split('@')[1] || '';
  if (PLATFORM_DOMAINS.test(domain)) out.push(`address belongs to the hosting platform (${domain}), not the show`);
  if (UNMONITORED.test(email)) out.push('address is a no-reply/unmonitored mailbox');
  return out;
}

function createProspectResearch({ fetchImpl = globalThis.fetch, isSuppressed = async () => false, timeoutMs = 10000, maxFeedBytes = 2_000_000 } = {}) {
  const t = () => (AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined);
  async function getJson(url) { const r = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'FANTASYMMADNESS-Research/1.0' }, signal: t() }); if (!r || !r.ok) throw Error(`HTTP ${r ? r.status : 'none'}`); return r.json(); }
  async function getText(url) {
    const r = await fetchImpl(url, { headers: { Accept: 'application/rss+xml, application/xml, text/xml', 'User-Agent': 'FANTASYMMADNESS-Research/1.0' }, signal: t() });
    if (!r || !r.ok) throw Error(`HTTP ${r ? r.status : 'none'}`);
    const text = String(await r.text());
    if (text.length > maxFeedBytes) return text.slice(0, maxFeedBytes).replace(/<item>(?![\s\S]*<\/item>)[\s\S]*$/, '') + '</channel></rss>';
    return text;
  }
  async function mxOk(domain) {
    try {
      const j = await getJson(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`);
      return Array.isArray(j.Answer) && j.Answer.some((a) => a.type === 15);
    } catch { return null; } // unknown
  }

  // contests: verified upcoming contests (for fighter/event relevance)
  async function research(prospect, { contests = [], now = new Date() } = {}) {
    const out = { researchedAt: now.toISOString(), source: { listing: prospect.sourceUrl }, show: null, recentEpisodes: [], evidence: [], contact: null, contactProblems: [], active: false, relevance: 0, score: 0, ok: false, error: null };
    try {
      const id = appleId(prospect.sourceUrl);
      if (!id) throw Error('listing has no Apple Podcasts id');
      const look = await getJson(`https://itunes.apple.com/lookup?id=${id}&entity=podcast`);
      const item = (look.results || []).find((x) => String(x.collectionId) === id) || (look.results || [])[0];
      if (!item?.feedUrl || !/^https?:\/\//.test(item.feedUrl)) throw Error('the show has no public feed address');
      out.source.feed = String(item.feedUrl);
      const feed = await parser.parseString(await getText(item.feedUrl));
      const items = (feed.items || []).slice(0, 25);
      out.show = {
        title: clean(feed.title || prospect.name, 200), author: clean(feed.itunesAuthor || item.artistName, 120) || null,
        website: /^https:\/\//.test(String(feed.link || '')) ? String(feed.link).slice(0, 300) : null,
        episodeCount: Number(item.trackCount) || items.length, genres: (item.genres || []).slice(0, 4).map((g) => clean(g, 40)),
      };
      out.recentEpisodes = items.slice(0, 5).map((e) => ({ title: clean(e.title, 160), date: e.isoDate || (e.pubDate ? new Date(e.pubDate).toISOString() : null) }));
      const latest = Date.parse(out.recentEpisodes[0]?.date || '');
      out.active = Number.isFinite(latest) && now.getTime() - latest < 120 * 86400000;
      // relevance evidence
      const words = SPORT_WORDS[prospect.genre];
      const hits = items.filter((e) => words && words.test(`${e.title} ${e.contentSnippet || ''}`)).slice(0, 3);
      if (hits.length) out.evidence.push({ kind: 'sport', text: `Recent episodes cover ${prospect.genre.replace('-', ' ')}`, examples: hits.map((e) => clean(e.title, 120)) });
      for (const c of contests.filter((x) => x.sport === prospect.genre)) {
        for (const name of [c.fighterA, c.fighterB, c.eventName].filter(Boolean)) {
          const last = String(name).split(' ').slice(-1)[0];
          if (last.length < 4) continue;
          const re = new RegExp(`\\b${last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
          const ep = items.find((e) => re.test(`${e.title} ${e.contentSnippet || ''}`));
          if (ep) { out.evidence.push({ kind: 'fight', contestId: c.id, text: `Mentioned ${name} in “${clean(ep.title, 100)}”`, fight: `${c.fighterA} vs ${c.fighterB}`, dateKey: c.dateKey }); break; }
        }
      }
      out.relevance = Math.min(1, hits.length / 3 + (out.evidence.some((e) => e.kind === 'fight') ? 0.5 : 0));
      // published business contact
      const contact = extractContact(feed);
      out.contactProblems = contactProblems(contact?.email);
      if (contact && !out.contactProblems.length) {
        if (await isSuppressed(contact.email)) out.contactProblems.push('this address opted out');
        else {
          const mx = await mxOk(contact.email.split('@')[1]);
          if (mx === false) out.contactProblems.push('the email domain does not accept mail');
          out.contact = { ...contact, source: out.source.feed, mailDomainChecked: mx === true, verifiedAt: now.toISOString(), basis: `Business contact published by the show in its public podcast feed (${contact.field}), retrieved ${now.toISOString().slice(0, 10)}` };
          if (mx === false) out.contact = null;
        }
      }
      out.score = Math.round(100 * (0.45 * out.relevance + 0.25 * (out.active ? 1 : 0) + 0.15 * Math.min(1, (out.show.episodeCount || 0) / 150) + 0.15 * (out.contact ? 1 : 0)));
      out.ok = true;
    } catch (e) { out.error = clean(e.message, 200); }
    return out;
  }
  return { research };
}

module.exports = { createProspectResearch, extractContact, contactProblems, appleId };
