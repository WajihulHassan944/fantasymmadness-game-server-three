'use strict';
// Fight-marketing campaigns built ONLY from contests FANTASY MMADNESS has actually
// published. Source of truth: the public, read-only contest feeds of the main
// FANTASY MMADNESS backend (the same feeds the website shows players). Nothing
// here writes to that backend.
//
//   fetchVerifiedContests() -> contests that pass every verification rule, plus
//                              the rejected ones with reasons
//   buildCampaign()         -> event-specific posts per social channel
//   checkCampaign()         -> final safeguard: a campaign that fails it never
//                              enters the approval queue
//
// Hard rules: real fighter names, a future date inside the horizon, one of the
// five sports, an open contest; no invented prizes, fees, titles or venues;
// podcast / media / creator names are never treated as fights.
const crypto = require('crypto');

const SPORTS = Object.freeze(['boxing', 'mma-ufc', 'kickboxing', 'bare-knuckle', 'pro-wrestling']);
const SPORT_LABEL = { boxing: 'BOXING', 'mma-ufc': 'MMA/UFC', kickboxing: 'KICKBOXING', 'bare-knuckle': 'BARE-KNUCKLE', 'pro-wrestling': 'PRO WRESTLING' };
const DEFAULT_SOURCE = 'https://fantasymmadness-game-server-three-taupe.vercel.app';
const SITE = 'https://www.fantasymmadness.com';
const OPEN_MATCH_STATUSES = new Set(['scheduled', 'open', 'ongoing']);
const PLACEHOLDER = /^(tba|tbd|tbc|n\/?a|unknown|fighter\s*[ab12]?|opponent|red corner|blue corner|mystery.*|winner of .*|vs\.?|-+|\?+)$/i;
const MEDIA_WORDS = /(\w+cast\b|\b(podcast|podcasts|show|radio|episode|episodes|news|media|network|channel|youtube|tv|live stream|recap|preview show|the fight game|breakdown|talk)\b)/i;
const MONEY_WORDS = /(\$\s?\d|\bprize|\bjackpot|\bcash\b|\bwin money\b|\bpayout|\bguarantee|\bfree money|\bbet\b|\bbetting|\bodds\b|\bwager)/i;
const HYPE_CLAIMS = /\b(title fight|championship|main event|undisputed|world title|belt on the line|sold out)\b/i;

const clean = (s, n = 120) => String(s ?? '').replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const norm = (s) => clean(s, 200).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function sportOf(item) {
  if (item.__feed === 'pro-wrestling') return 'pro-wrestling';
  const raw = clean(item.matchCategoryTwo) || clean(item.matchCategory) || clean(item.effectiveCategory);
  const c = raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (['boxing', 'box'].includes(c)) return 'boxing';
  if (['mma', 'mixedmartialarts', 'ufc', 'mmaufc'].includes(c)) return 'mma-ufc';
  if (['kickboxing', 'k1', 'kone'].includes(c)) return 'kickboxing';
  if (['bareknuckle', 'bareknuckleboxing', 'bareknucklefighting', 'bkfc'].includes(c)) return 'bare-knuckle';
  if (['prowrestling', 'wrestling'].includes(c)) return 'pro-wrestling';
  return null;
}

function validTimeZone(tz) { try { if (!tz) return null; new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; } }
function dateKeyIn(date, tz) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const g = (t) => p.find((x) => x.type === t).value; return `${g('year')}-${g('month')}-${g('day')}`;
}

// ---- verification ------------------------------------------------------------
function verifyContest(item, { now = new Date(), horizonDays = 21, mediaNames = new Set() } = {}) {
  const reasons = [];
  const wrestling = item.__feed === 'pro-wrestling';
  const id = clean(wrestling ? item.id : (item._id || item.id), 64);
  if (!/^[a-zA-Z0-9_-]{6,64}$/.test(id)) reasons.push('missing_contest_id');
  const sport = sportOf(item);
  if (!sport) reasons.push('sport_not_one_of_five');
  const a = clean(wrestling ? (item.competitorA?.displayName || item.competitorA?.name) : (item.matchFighterA || item.fighterA?.name || item.fighterAId?.name), 60);
  const b = clean(wrestling ? (item.competitorB?.displayName || item.competitorB?.name) : (item.matchFighterB || item.fighterB?.name || item.fighterBId?.name), 60);
  for (const [n, label] of [[a, 'a'], [b, 'b']]) {
    if (!n || n.length < 2 || PLACEHOLDER.test(n) || !/[a-z]/i.test(n)) reasons.push(`fighter_${label}_name_missing_or_placeholder`);
    else if (MEDIA_WORDS.test(n) || mediaNames.has(norm(n))) reasons.push(`fighter_${label}_looks_like_media_not_a_fighter`);
    else if (!wrestling && /\s(and|&|\+)\s/i.test(n)) reasons.push(`fighter_${label}_names_two_people_or_a_show`);
  }
  if (a && b && norm(a) === norm(b)) reasons.push('same_fighter_twice');
  const title = clean(wrestling ? (item.eventName || item.title) : item.matchName, 120);
  if (title && (mediaNames.has(norm(title)) || /\bpodcast\b/i.test(title))) reasons.push('event_title_is_a_media_name');
  // Shadow / mystery records are replays, not upcoming events.
  if (!wrestling && (item.sourceType === 'shadow' || item.isShadow || item.shadowIdentityHidden || String(item.matchType || '').toLowerCase() === 'shadow')) reasons.push('shadow_or_mystery_fight_not_a_real_event');
  // Auto-discovered candidates are not published contests until the owner promotes them.
  if (item.autoDiscovered === true && !item.homepagePromoted && !item.featuredThisWeek && !item.featuredFight) reasons.push('unpublished_auto_discovered_candidate');
  if (item.draft === true || item.isDraft === true || item.voidedAt) reasons.push('draft_or_voided');
  const status = clean(wrestling ? item.status : item.matchStatus, 20).toLowerCase();
  if (wrestling ? status !== 'open' : !OPEN_MATCH_STATUSES.has(status || 'ongoing')) reasons.push(`contest_not_open (${status || 'none'})`);
  if (!wrestling && String(item.matchShadowOpenStatus || '').toLowerCase() === 'closed') reasons.push('contest_entries_closed');
  if (wrestling && item.publicVisible === false) reasons.push('not_public');
  // Date: must be a real future date inside the horizon.
  const tz = validTimeZone(item.eventTimeZone);
  const date = item.matchDate ? new Date(item.matchDate) : null;
  const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(String(item.matchDateKey || '')) ? item.matchDateKey : (date && Number.isFinite(date.getTime()) ? dateKeyIn(date, tz || 'UTC') : null);
  if (!dateKey) reasons.push('event_date_missing');
  else {
    const today = dateKeyIn(now, tz || 'America/New_York');
    const horizon = dateKeyIn(new Date(now.getTime() + horizonDays * 86400000), tz || 'America/New_York');
    if (dateKey < today) reasons.push('event_date_in_past');
    if (dateKey > horizon) reasons.push('event_date_beyond_horizon');
  }
  for (const f of ['lockAt', 'entryClosedAt']) {
    if (item[f]) { const t = new Date(item[f]).getTime(); if (Number.isFinite(t) && t <= now.getTime()) reasons.push(f === 'lockAt' ? 'predictions_already_locked' : 'entries_already_closed'); }
  }
  if (reasons.length) return { ok: false, id: id || null, sport, reasons, label: a && b ? `${a} vs ${b}` : (title || id || 'unknown') };
  const timeTba = item.timeTba === true || !/^\d{1,2}:\d{2}$/.test(String(item.matchTime || ''));
  const contest = {
    id, sport, fighterA: a, fighterB: b, eventName: title && norm(title) !== norm(`${a} vs ${b}`) ? title : null,
    dateKey, timeTba, matchTime: timeTba ? null : item.matchTime, timeZone: tz,
    venue: clean(item.venue, 80) || null, city: clean(item.eventCity, 60) || null,
    weightClass: clean(item.weightClass || item.division, 40) || null, maxRounds: Number.isInteger(item.maxRounds) && item.maxRounds > 0 && item.maxRounds <= 15 ? item.maxRounds : null,
    promotion: wrestling ? (clean(item.promotionName, 40) || null) : null,
    ufc: !wrestling && (Number.isInteger(item.ufcEventNumber) || /\bufc\b/i.test(title || '')),
    contestUrl: wrestling ? `${SITE}/pro-wrestling/play/${encodeURIComponent(id)}` : `${SITE}/fight/${encodeURIComponent(id)}?play=1`,
    source: wrestling ? 'fmm-public-pro-wrestling-feed' : 'fmm-public-prediction-feed',
    status: status || 'ongoing',
    posterUrl: [item.fightPosterImage, item.featuredFightBackgroundImage, item.promotionBackground, item.bannerImage].map((u) => clean(u, 500)).find((u) => /^https:\/\/[^\s"'<>]+$/i.test(u)) || null,
  };
  contest.fingerprint = hash([contest.id, contest.sport, contest.fighterA, contest.fighterB, contest.dateKey, contest.matchTime, contest.eventName].join('|')).slice(0, 10);
  return { ok: true, contest };
}

async function getJson(fetchImpl, url) {
  const r = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!r || !r.ok) throw Error(`contest feed ${new URL(url).pathname} returned ${r ? r.status : 'no response'}`);
  return r.json();
}

function sourceBase(env = {}) {
  const v = String(env.GROWTH_CONTEST_SOURCE_URL || DEFAULT_SOURCE).replace(/\/+$/, '');
  const u = new URL(v);
  if (u.protocol !== 'https:' || !(/^fantasymmadness-game-server-three[a-z0-9-]*\.vercel\.app$/.test(u.hostname) || /(^|\.)fantasymmadness\.com$/.test(u.hostname))) throw Error('GROWTH_CONTEST_SOURCE_URL must be the FANTASY MMADNESS backend (https)');
  return `${u.origin}`;
}

async function fetchVerifiedContests({ fetchImpl = globalThis.fetch, baseUrl = DEFAULT_SOURCE, now = new Date(), horizonDays = 21, mediaNames = new Set() } = {}) {
  const errors = []; const raw = [];
  try { const j = await getJson(fetchImpl, `${baseUrl}/api/public/prediction-fights?limit=100`); for (const it of (j.items || [])) raw.push({ ...it, __feed: 'prediction' }); }
  catch (e) { errors.push(clean(e.message, 200)); }
  try { const j = await getJson(fetchImpl, `${baseUrl}/api/public/pro-wrestling/matches?status=OPEN&limit=50`); for (const it of (j.items || [])) raw.push({ ...it, __feed: 'pro-wrestling' }); }
  catch (e) { errors.push(clean(e.message, 200)); }
  const contests = []; const rejected = []; const seen = new Set();
  for (const it of raw) {
    const v = verifyContest(it, { now, horizonDays, mediaNames });
    if (!v.ok) { rejected.push({ id: v.id, sport: v.sport, label: v.label, reasons: v.reasons }); continue; }
    if (seen.has(v.contest.id)) continue; seen.add(v.contest.id); contests.push(v.contest);
  }
  contests.sort((x, y) => x.dateKey.localeCompare(y.dateKey));
  return { contests, rejected, errors, checked: raw.length, sourceReachable: errors.length < 2 };
}

// ---- copy ----------------------------------------------------------------------
const EMOJI = { boxing: '🥊', 'mma-ufc': '🔥', kickboxing: '🦵', 'bare-knuckle': '👊', 'pro-wrestling': '🤼' };
function tags(c) {
  const t = { boxing: ['#Boxing'], 'mma-ufc': c.ufc ? ['#MMA', '#UFC'] : ['#MMA'], kickboxing: ['#Kickboxing'], 'bare-knuckle': ['#BareKnuckle'], 'pro-wrestling': ['#ProWrestling'] }[c.sport].slice();
  if (c.promotion && /^[A-Za-z0-9]{2,20}$/.test(c.promotion.replace(/\s+/g, ''))) t.push('#' + c.promotion.replace(/\s+/g, ''));
  t.push('#FANTASYMMADNESS'); return t.join(' ');
}
function whenText(c) {
  const [y, m, d] = c.dateKey.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  if (c.timeTba || !c.timeZone) return day;
  const [hh, mm] = c.matchTime.split(':').map(Number);
  const h12 = ((hh + 11) % 12) + 1; const ampm = hh >= 12 ? 'PM' : 'AM';
  const abbr = new Intl.DateTimeFormat('en-US', { timeZone: c.timeZone, timeZoneName: 'short' }).formatToParts(new Date(Date.UTC(y, m - 1, d, 12))).find((p) => p.type === 'timeZoneName')?.value || '';
  return `${day}, ${h12}:${String(mm).padStart(2, '0')} ${ampm}${abbr ? ' ' + abbr : ''}`;
}
function link(c, channel) {
  const sep = c.contestUrl.includes('?') ? '&' : '?';
  // fan_acquisition / partner_outreach / combat_fans_* is what the live site already
  // records on registration, so sign-ups from these posts become measurable without
  // any production change. "gs" = Growth Engine social; utm_content = channel.
  return `${c.contestUrl}${sep}utm_source=fan_acquisition&utm_medium=partner_outreach&utm_campaign=combat_fans_gs_${c.sport.replace(/[^a-z0-9]+/g, '_')}&utm_content=${channel}`;
}
// How you play, by sport (matches what each contest page offers; no prizes or fees).
const PLAY = {
  boxing: ['Call it round by round: punches, round winners and the finish.', 'Score this one round by round and see whose card comes closest.', 'Think you can read every round? Fill out your round-by-round card.'],
  'mma-ufc': ['Call it round by round: strikes, takedowns, round winners and the finish.', 'Fill out your round-by-round card before the cage door closes.', 'Score every round and see whose card comes closest.'],
  kickboxing: ['Call it round by round: punches, kicks, knees and round winners.', 'Score every exchange, round by round.', 'Think you can read every round? Fill out your round-by-round card.'],
  'bare-knuckle': ['Call it round by round: punches, knockdowns and round winners.', 'No gloves. Score every round and call the finish.', 'Think you can read every round? Fill out your round-by-round card.'],
  'pro-wrestling': ['Make your picks for this match.', 'Who walks out the winner? Lock in your picks.', 'Call it before the bell. Make your picks.'],
};
function buildCampaign(c) {
  const pick = parseInt(hash(c.id).slice(0, 8), 16) % 3;
  const vs = `${c.fighterA} vs ${c.fighterB}`;
  const e = EMOJI[c.sport];
  const when = whenText(c);
  const where = [c.venue, c.city].filter(Boolean).join(', ');
  const details = [c.eventName, c.weightClass, c.maxRounds ? `${c.maxRounds} rounds` : null, c.promotion].filter(Boolean).join(' · ');
  const play = PLAY[c.sport][pick];
  const headline = `${SPORT_LABEL[c.sport]}: ${vs} — ${when}`;
  const long = (ch) => [
    `${e} ${vs}`, `📅 ${when}${where ? `\n📍 ${where}` : ''}`, details || null,
    `${play} Your FANTASY MMADNESS contest for this ${c.sport === 'pro-wrestling' ? 'match' : 'fight'} is open now.`,
    `Make your picks 👉 ${link(c, ch)}`, tags(c),
  ].filter(Boolean).join('\n\n');
  const x = [`${e} ${vs} | ${when}`, `${play}`, `Picks open on FANTASY MMADNESS 👇`, link(c, 'x'), tags(c)].join('\n');
  const tiktok = `${e} ${vs} — ${when}. ${play} Link in bio → FANTASY MMADNESS contest is open. ${tags(c)}`;
  return {
    headline: clean(headline, 180),
    posts: { instagram: long('instagram'), facebook: long('facebook'), x, tiktok },
    text: long('instagram'),
    link: link(c, 'instagram'),
  };
}

// ---- final safeguard -----------------------------------------------------------
function checkCampaign(draft, contest, { now = new Date(), mediaNames = new Set() } = {}) {
  const reasons = [];
  if (!contest || !contest.id) return ['no_verified_contest'];
  if (draft.kind !== 'marketing') reasons.push('not_a_marketing_campaign');
  if (draft.contestId !== contest.id) reasons.push('contest_id_mismatch');
  if (!SPORTS.includes(draft.genre) || draft.genre !== contest.sport) reasons.push('sport_mismatch');
  const texts = { text: draft.text, ...(draft.posts || {}) };
  for (const [ch, t] of Object.entries(texts)) {
    const s = String(t || '');
    if (!s.trim()) { reasons.push(`${ch}_empty`); continue; }
    if (!s.includes(contest.fighterA) || !s.includes(contest.fighterB)) reasons.push(`${ch}_missing_fighter_names`);
    if (ch !== 'tiktok' && !s.includes(contest.contestUrl.split('?')[0])) reasons.push(`${ch}_missing_contest_link`);
    if (MONEY_WORDS.test(s)) reasons.push(`${ch}_mentions_money_or_prizes`);
    if (HYPE_CLAIMS.test(s) && !(contest.eventName && HYPE_CLAIMS.test(contest.eventName))) reasons.push(`${ch}_claims_title_or_main_event_not_in_contest`);
    if (/\bpodcast\b/i.test(s)) reasons.push(`${ch}_mentions_podcast`);
    for (const m of mediaNames) if (m.length > 5 && norm(s).includes(m) && !norm(`${contest.fighterA} ${contest.fighterB} ${contest.eventName || ''}`).includes(m)) { reasons.push(`${ch}_contains_media_name`); break; }
  }
  if ((draft.posts?.x || '').replace(/https?:\/\/\S+/g, 'x'.repeat(23)).length > 280) reasons.push('x_post_too_long');
  const today = dateKeyIn(now, contest.timeZone || 'America/New_York');
  if (contest.dateKey < today) reasons.push('event_date_in_past');
  return reasons;
}

module.exports = { SPORTS, SPORT_LABEL, DEFAULT_SOURCE, sourceBase, sportOf, verifyContest, fetchVerifiedContests, buildCampaign, checkCampaign, norm, MONEY_WORDS };
