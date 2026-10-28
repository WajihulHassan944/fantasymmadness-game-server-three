'use strict';

// FAN ACQUISITION — fight-specific campaign drafts (Phase 1: drafts only).
//
// Pure functions: no database, network, email or social calls live here. The
// route layer (fan-acquisition-discovery.js) reads the Fight Registry
// read-only, passes plain records in, and stores the returned drafts.
//
// Rules this module enforces:
// - Only real, upcoming, publicly visible fights that are open for entry.
// - Fighter names, date, time and venue come only from the fight record.
//   Nothing is invented: no records, no venue, no prize claims.
// - Affiliate links come from the SAME builders the approved QR posters use,
//   so a link in a post always opens the same page as the poster's QR code.
// - Every draft starts unapproved. Publishing states exist for Phase 2 but
//   cannot be reached here.

const crypto = require('crypto');

const SITE_URL = 'https://www.fantasymmadness.com';
const SITE_HOST = 'www.fantasymmadness.com';
const OBJECT_ID = /^[a-f\d]{24}$/i;

const STATES = ['draft', 'needs_review', 'approved', 'queued', 'published', 'failed'];
// Phase 2 states. Nothing in Phase 1 may move a campaign into them.
const DISTRIBUTION_STATES = ['queued', 'published', 'failed'];
const CHANNELS = ['instagram', 'facebook', 'x', 'affiliate_email'];
const CHANNEL_LABELS = { instagram: 'Instagram', facebook: 'Facebook', x: 'X', affiliate_email: 'Affiliate outreach email' };
// Human checks the owner must confirm for every channel before approval.
const REVIEW_CHECKS = ['image_fit', 'fighter_identity', 'qr_destination', 'referral_attribution'];
const REVIEW_CHECK_LABELS = {
  image_fit: 'Poster fits this channel (nothing cropped or stretched)',
  fighter_identity: 'Fighter names and photos are the correct people',
  qr_destination: 'Scanned the QR / opened the link: it opens this exact fight',
  referral_attribution: 'Link credits the right account (affiliate or owner campaign tag)',
};

const X_LIMIT = 280;
const X_URL_WEIGHT = 23; // X counts every link as 23 characters (t.co).

const PLACEHOLDER_NAME = /^(?:tba|tbd|t\.b\.a\.?|t\.b\.d\.?|to be (?:announced|determined|confirmed)|opponent(?: tba| tbd)?|unknown|n\/a|na|none|null|undefined|fighter\s*[ab12]?|competitor\s*[ab12]?|vs\.?|\?+|-+)$/i;
const PLACEHOLDER_WORD = /\b(?:tba|tbd)\b/i;

// ---------------------------------------------------------------- text ----

// Plain text only: strips control characters (including CR/LF injection),
// collapses whitespace and limits length. Visible characters are kept as-is;
// HTML output escapes them separately.
function cleanText(value, max = 160) {
  return String(value == null ? '' : value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function isPlaceholderName(name) {
  const text = cleanText(name, 120);
  return !text || PLACEHOLDER_NAME.test(text) || PLACEHOLDER_WORD.test(text);
}

// "Jon Jones" -> "#JonJones"; returns '' when nothing usable remains.
function hashtag(value) {
  const tag = cleanText(value, 60).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/gi, '');
  return tag && !/^\d+$/.test(tag) ? `#${tag}` : '';
}

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

// --------------------------------------------------------------- sport ----

function sportFor(fight = {}, source = 'match') {
  if (source === 'pro_wrestling' || fight.gameMode === 'PRO_WRESTLING') return { id: 'wrestling', label: 'Pro Wrestling', tags: ['#ProWrestling'] };
  const text = [fight.matchCategoryTwo, fight.matchCategory, fight.matchName, fight.division].map((v) => String(v || '').toLowerCase()).join(' ');
  if (/bare|bkfc/.test(text)) return { id: 'bare-knuckle', label: 'Bare Knuckle', tags: ['#BKFC', '#BareKnuckle'] };
  if (/muay|kickbox|one championship|glory/.test(text)) return { id: 'kickboxing', label: 'Kickboxing / Muay Thai', tags: ['#MuayThai', '#Kickboxing'] };
  if (/box/.test(text)) return { id: 'boxing', label: 'Boxing', tags: ['#Boxing'] };
  if (/mma|ufc|pfl|bellator/.test(text)) return { id: 'mma', label: 'MMA / UFC', tags: /ufc/.test(text) ? ['#UFC', '#MMA'] : ['#MMA'] };
  return { id: 'combat', label: 'Combat Sports', tags: ['#FightNight'] };
}

// ------------------------------------------------------------ schedule ----

function dateKeyFor(fight = {}) {
  const raw = fight.matchDateKey || fight.eventDate || fight.matchDate;
  const text = String(raw instanceof Date ? raw.toISOString() : raw || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

// Uses the platform's own entry-lock rule (fight-entry-time.js) for the
// start instant, so the date in a post always matches the fight page.
function describeSchedule(fight = {}, { getLockTime, now = Date.now() } = {}) {
  const reasons = [];
  const key = dateKeyFor(fight);
  if (!key) {
    reasons.push('Fight date is missing or invalid in the Fight Registry.');
    return { ok: false, reasons };
  }
  const [year, month, day] = key.split('-').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day, 12));
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    reasons.push('Fight date is not a real calendar date.');
    return { ok: false, reasons };
  }
  const zone = cleanText(fight.eventTimeZone, 64) || 'America/New_York';
  const dateText = calendar.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const shortDate = calendar.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });

  const lock = typeof getLockTime === 'function' ? Number(getLockTime(fight)) : NaN;
  const hasTime = !fight.timeTba && /^\d{1,2}:\d{2}/.test(String(fight.matchTime || '').trim());
  let timeText = 'Time TBA';
  if (hasTime && Number.isFinite(lock)) {
    try {
      timeText = new Date(lock).toLocaleTimeString('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    } catch {
      timeText = 'Time TBA';
      reasons.push('Event time zone is not valid; time shown as TBA.');
    }
  } else if (hasTime) {
    reasons.push('Fight time could not be verified; time shown as TBA.');
  }

  // Past check: an explicit start instant when available, otherwise the end of
  // the event day (never invent a deadline for a TBA time).
  const endOfDay = Date.UTC(year, month - 1, day, 23, 59, 59) + 14 * 3600 * 1000;
  const startsAt = Number.isFinite(lock) ? lock : endOfDay;
  if (startsAt <= now) reasons.push('Fight date has already passed.');
  return {
    ok: !reasons.some((r) => /passed|missing|not a real/.test(r)),
    reasons, dateKey: key, dateText, shortDate, timeText, timeTba: timeText === 'Time TBA',
    timeZone: zone, startsAt: Number.isFinite(lock) ? new Date(lock).toISOString() : null,
  };
}

// ---------------------------------------------------------------- links ----

function fightPath(source) {
  return source === 'pro_wrestling' ? '/pro-wrestling/matches/' : '/fight/';
}

// Owner (non-affiliate) campaign link: the public fight page, with the
// fan-acquisition tags the website already captures for signup attribution
// (fan-acquisition-attribution.js accepts exactly this source/medium/campaign).
function ownerFightLink({ fightId, source, sportId, channel, campaignRef }) {
  const url = new URL(`${SITE_URL}${fightPath(source)}${encodeURIComponent(String(fightId))}`);
  url.searchParams.set('play', '1');
  url.searchParams.set('utm_source', 'fan_acquisition');
  url.searchParams.set('utm_medium', 'partner_outreach');
  url.searchParams.set('utm_campaign', `combat_fans_${String(sportId || 'all').replace(/[^a-z0-9_-]/gi, '_')}`);
  url.searchParams.set('utm_content', `${String(channel).replace(/[^a-z0-9]/gi, '').slice(0, 10)}-${String(campaignRef || '').replace(/[^a-z0-9]/gi, '').slice(0, 12)}`.slice(0, 32));
  return url.toString();
}

// Strict destination check used before anything is saved as a draft.
function validateCampaignUrl(link, { fightId, affiliateId = '' } = {}) {
  let url;
  try { url = new URL(String(link || '')); } catch { return 'Link is not a valid web address.'; }
  if (url.protocol !== 'https:') return 'Link must use https.';
  if (url.hostname !== SITE_HOST || url.port || url.username || url.password) return 'Link must open www.fantasymmadness.com.';
  const id = String(fightId || '');
  const inPath = url.pathname.split('/').map(decodeURIComponent).includes(id);
  if (!OBJECT_ID.test(id) || !(inPath || url.searchParams.get('fightId') === id)) return 'Link does not open this fight.';
  if (affiliateId) {
    const credited = [url.searchParams.get('ref'), url.searchParams.get('affiliateId'), ...url.pathname.split('/').map(decodeURIComponent)];
    if (!credited.includes(String(affiliateId))) return 'Affiliate link does not credit this affiliate.';
    if (url.searchParams.get('utm_source')) return 'Affiliate link must match the poster QR exactly (no extra campaign tags).';
  } else if (url.searchParams.get('utm_source') !== 'fan_acquisition') {
    return 'Owner campaign link is missing its fan-acquisition tracking tag.';
  }
  return '';
}

// X weighs every URL as 23 characters.
function xLength(text) {
  return String(text).replace(/https?:\/\/\S+/g, 'x'.repeat(X_URL_WEIGHT)).length;
}

// ------------------------------------------------------------ eligibility ----

// Same visibility rule the public site applies (server.js
// isPublicHomeActiveFightRecord + isDraftFightRecord), restated here because
// server.js does not export it. Dates/locks are checked separately.
function isPublicFight(fight = {}, source = 'match') {
  const n = (v) => String(v || '').trim().toLowerCase();
  if (source === 'pro_wrestling' || fight.gameMode === 'PRO_WRESTLING') {
    return fight.publicVisible !== false && n(fight.status || fight.matchStatus) !== 'draft';
  }
  if (n(fight.matchStatus) === 'draft' || n(fight.status) === 'draft' || n(fight.matchShadowStatus) === 'draft' || fight.draft === true || fight.isDraft === true) return false;
  // Auto-discovered calendar candidates stay hidden until the owner promotes one.
  if (fight.autoDiscovered === true && !fight.homepagePromoted && !fight.featuredThisWeek && !fight.featuredFight) return false;
  return true;
}

// Decides whether a fight may be promoted at all. Returns blocking reasons;
// an empty list means eligible. `isOpen` and `isPublic` are the platform's
// own rules, passed in by the route layer.
function fightEligibility(fight, { source = 'match', isOpen, isPublic, affiliateId = '' } = {}) {
  const reasons = [];
  if (!fight || !OBJECT_ID.test(String(fight._id || ''))) return ['Fight record not found.'];
  const status = String(fight.matchStatus || fight.status || '').toLowerCase();
  if (['draft'].includes(status) || fight.isDraft === true || fight.draft === true) reasons.push('Fight is still a draft.');
  if (['cancelled', 'canceled', 'no_contest', 'deleted'].includes(status)) reasons.push('Fight is cancelled.');
  if (['finished', 'finalized', 'completed', 'closed'].includes(status)) reasons.push('Fight is finished or closed.');
  if (typeof isPublic === 'function' && !isPublic(fight)) reasons.push('Fight is not publicly visible on the website.');
  if (typeof isOpen === 'function' && !isOpen(fight)) reasons.push('Fight is locked or no longer open for entry.');
  if (fight.voidedAt) reasons.push('Fight was voided.');
  const a = cleanText(fight.matchFighterA, 80);
  const b = cleanText(fight.matchFighterB, 80);
  if (!a || !b) reasons.push('Both fighter names are required.');
  else if (isPlaceholderName(a) || isPlaceholderName(b)) reasons.push('A fighter is still TBA. Campaigns wait until both fighters are confirmed.');
  else if (a.toLowerCase() === b.toLowerCase()) reasons.push('Fighter A and Fighter B have the same name.');
  // Affiliate isolation: an affiliate's own league fight is promoted only by
  // that affiliate, never by the owner or by another affiliate.
  const owner = String(fight.affiliateId || '').trim();
  const createdByAffiliate = owner && (fight.matchBy === 'affiliate' || source === 'shadow');
  if (createdByAffiliate && owner !== String(affiliateId || '')) reasons.push('This fight belongs to another affiliate\'s league and cannot be promoted from this campaign.');
  return [...new Set(reasons)];
}

// --------------------------------------------------------------- poster ----

function safePosterUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.protocol === 'https:' && parsed.hostname === 'res.cloudinary.com' && !parsed.port && !parsed.username ? parsed.toString() : '';
  } catch { return ''; }
}

// Picks the approved artwork. Affiliate campaigns use the affiliate's approved
// personal QR poster (never another affiliate's). Owner campaigns use the
// poster the owner saved on the fight. Nothing is generated or altered here.
function choosePoster({ fight, fightId, affiliateId = '', affiliatePosters = [] }) {
  if (affiliateId) {
    const own = affiliatePosters
      .filter((p) => p && p.status === 'approved' && String(p.fightId) === String(fightId) && String(p.affiliateId) === String(affiliateId) && (p.audience || 'one') !== 'all')
      .sort((x, y) => (x.qrTarget === 'paid') - (y.qrTarget === 'paid') || new Date(y.approvedAt || 0) - new Date(x.approvedAt || 0))[0];
    if (own) {
      return {
        kind: 'affiliate_qr_poster', posterId: String(own._id || own.id || ''),
        url: safePosterUrl(own.imageUrl) || (own._id ? `/api/admin/affiliate-posters/${own._id}/image` : ''),
        qrLink: String(own.qrLink || ''), qrTarget: own.qrTarget === 'paid' ? 'paid' : 'league',
        width: Number(own.width) || null, height: Number(own.height) || null, hasQr: true,
      };
    }
  }
  const base = safePosterUrl(fight?.fightPosterImage);
  if (base) return { kind: 'fight_poster', posterId: '', url: base, qrLink: '', qrTarget: '', width: null, height: null, hasQr: false };
  return null;
}

// ---------------------------------------------------------------- copy ----

const DISCLOSURE = 'I’m a FANTASY MMADNESS affiliate and may earn from eligible entries through my link.';
const RULES_LINE = 'Entry details, eligibility and prize rules are on the fight page.';

function buildCopy({ a, b, eventName, schedule, venueLine, sport, link, affiliate }) {
  const matchup = `${a} vs ${b}`;
  const when = `${schedule.dateText}${schedule.timeTba ? ' · Time TBA' : ` · ${schedule.timeText}`}`;
  const eventLine = eventName ? `${eventName}\n` : '';
  const where = venueLine ? `\n📍 ${venueLine}` : '';
  const tags = [...new Set(['#FANTASYMMADNESS', hashtag(a), hashtag(b), ...sport.tags])].filter(Boolean).join(' ');
  const league = affiliate ? cleanText(affiliate.leagueName || affiliate.playerName || [affiliate.firstName, affiliate.lastName].filter(Boolean).join(' '), 60) || 'my league' : '';
  const invite = affiliate
    ? `Join ${league} on FANTASY MMADNESS and make your picks for ${matchup}.`
    : `Don’t just watch ${matchup} — predict it on FANTASY MMADNESS.`;
  const pitch = 'Call the rounds, the strikes and the finish, then see how your fight IQ stacks up against other fans.';

  const instagram = [
    `🥊 ${matchup}`,
    `${eventLine}📅 ${when}${where}`,
    '',
    `${invite} ${pitch}`,
    '',
    affiliate
      ? '👉 Scan the QR code on the poster or tap the link in my bio to open this fight.'
      : '👉 Tap the link in our bio, or go to FANTASYMMADNESS.COM, to make your picks.',
    `🔗 ${link}`,
    '',
    affiliate ? `${RULES_LINE} ${DISCLOSURE}` : RULES_LINE,
    '',
    tags,
  ].join('\n');

  const facebook = [
    `${matchup}${eventName ? ` — ${eventName}` : ''}`,
    `📅 ${when}${where}`,
    '',
    `${invite} ${pitch}`,
    '',
    `Make your picks at FANTASYMMADNESS.COM: ${link}`,
    '',
    affiliate ? `${RULES_LINE}\n${DISCLOSURE}` : RULES_LINE,
    '',
    tags,
  ].join('\n');

  // X: shrink gracefully, never cut a name or the link.
  const xTags = ['#FANTASYMMADNESS', ...sport.tags.slice(0, 1)].join(' ');
  const xSuffix = affiliate ? ' Affiliate link; I may earn from entries.' : '';
  const xOptions = [
    `${matchup} · ${schedule.shortDate}${schedule.timeTba ? '' : `, ${schedule.timeText}`}${eventName ? ` · ${eventName}` : ''}\nDon’t just watch it — predict it. Make your picks at FANTASYMMADNESS.COM 👇\n${link}${xSuffix}\n${xTags}`,
    `${matchup} · ${schedule.shortDate}\nDon’t just watch it — predict it at FANTASYMMADNESS.COM 👇\n${link}${xSuffix}\n#FANTASYMMADNESS`,
    `${matchup} · ${schedule.shortDate}. Predict it: ${link}${xSuffix}`,
  ];
  const x = xOptions.find((text) => xLength(text) <= X_LIMIT) || xOptions[xOptions.length - 1];

  let email = null;
  if (affiliate) {
    const first = cleanText(affiliate.firstName || affiliate.playerName || '', 40) || 'there';
    const subject = cleanText(`Your fight link is ready: ${matchup}`, 140);
    const lines = [
      `Hi ${first},`,
      '',
      `${matchup} is open for picks on FANTASY MMADNESS.`,
      `${eventName ? `${eventName}, ` : ''}${when}${venueLine ? `, ${venueLine}` : ''}.`,
      '',
      'Share your personal fight link with your followers. Anyone who joins through it is credited to your league:',
      link,
      '',
      'Your approved poster carries a QR code that opens the same link. Ready-to-post captions for Instagram, Facebook and X are below.',
      '',
      'When you post, please keep the affiliate disclosure in your caption. Entry details, eligibility and prize rules are on the fight page.',
      '',
      '— FANTASY MMADNESS',
    ];
    const text = lines.join('\n');
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#111">${lines.map((line) => {
      if (!line) return '<br>';
      if (line === link) return `<p><a href="${escapeHtml(link)}" style="color:#b7152a;font-weight:700">${escapeHtml(link)}</a></p>`;
      return `<p style="margin:0 0 6px">${escapeHtml(line)}</p>`;
    }).join('')}</div>`;
    email = { subject, text, html };
  }
  return { instagram, facebook, x, email };
}

// ------------------------------------------------------------- campaign ----

// Builds one draft campaign for one fight, for the owner (affiliate = null) or
// for one affiliate. Returns { skipped, reasons } when the fight may not be
// promoted, otherwise { campaign }.
function buildFightCampaign({
  fight, source = 'match', affiliate = null, affiliatePosters = [],
  isOpen, isPublic, getLockTime, affiliateLeagueFightLink, affiliatePaidFightLink, now = Date.now(),
}) {
  const fightId = String(fight?._id || '');
  const affiliateId = affiliate ? String(affiliate._id || affiliate.id || '') : '';
  if (affiliate && !OBJECT_ID.test(affiliateId)) return { skipped: true, fightId, reasons: ['Affiliate account not found.'] };
  if (affiliate && (affiliate.promoterSuspendedAt || affiliate.suspended === true || affiliate.status === 'suspended')) {
    return { skipped: true, fightId, reasons: ['This affiliate account is suspended.'] };
  }

  const blocking = fightEligibility(fight, { source, isOpen, isPublic, affiliateId });
  const schedule = describeSchedule(fight, { getLockTime, now });
  if (!schedule.ok) blocking.push(...schedule.reasons);
  if (blocking.length) return { skipped: true, fightId, reasons: [...new Set(blocking)] };

  const a = cleanText(fight.matchFighterA, 80);
  const b = cleanText(fight.matchFighterB, 80);
  const rawEvent = cleanText(fight.matchName, 120);
  const eventName = rawEvent && rawEvent.toLowerCase().replace(/\s+/g, ' ') !== `${a} vs ${b}`.toLowerCase() && rawEvent.toLowerCase() !== `${a} vs. ${b}`.toLowerCase() ? rawEvent : '';
  const venueLine = [cleanText(fight.venue, 100), cleanText(fight.eventCity, 80)].filter(Boolean).filter((v, i, all) => all.indexOf(v) === i).join(', ');
  const sport = sportFor(fight, source);
  const warnings = schedule.reasons.filter((r) => !/passed|missing|not a real/.test(r));

  const poster = choosePoster({ fight, fightId, affiliateId, affiliatePosters });
  const campaignRef = sha256(`${fightId}|${affiliateId}`).slice(0, 12);

  // Links: affiliate = the exact destination of the approved QR poster.
  let affiliateLink = '';
  if (affiliate) {
    const league = typeof affiliateLeagueFightLink === 'function' ? affiliateLeagueFightLink(affiliateId, fightId) : '';
    const paid = typeof affiliatePaidFightLink === 'function' ? affiliatePaidFightLink(affiliateId, fightId, source === 'pro_wrestling' ? 'pro_wrestling' : '') : '';
    affiliateLink = poster?.hasQr && poster.qrTarget === 'paid' ? paid : league;
  }
  const linkFor = (channel) => (affiliate ? affiliateLink : ownerFightLink({ fightId, source, sportId: sport.id, channel, campaignRef }));

  const channels = {};
  for (const channel of CHANNELS) {
    if (channel === 'affiliate_email' && !affiliate) {
      channels[channel] = { enabled: false, label: CHANNEL_LABELS[channel], blocking: ['Choose an affiliate to prepare an affiliate outreach email.'], warnings: [] };
      continue;
    }
    const link = linkFor(channel);
    const copy = buildCopy({ a, b, eventName, schedule, venueLine, sport, link, affiliate });
    const chBlocking = [];
    const chWarnings = [];
    const urlError = validateCampaignUrl(link, { fightId, affiliateId });
    if (urlError) chBlocking.push(urlError);
    if (!poster) {
      if (channel === 'instagram') chBlocking.push('Instagram needs an image. Upload the approved fight poster in the Fight Launch Desk first.');
      else chWarnings.push('No approved poster on this fight yet; this post would go out without artwork.');
    } else if (affiliate && !poster.hasQr) {
      chWarnings.push('No approved personal QR poster for this affiliate yet; preview shows the general fight poster without a QR code. Create one in the Fight Launch Desk.');
    }
    if (poster?.hasQr && poster.qrLink && poster.qrLink !== link) chBlocking.push('The poster QR code opens a different page than this link. Re-approve the poster before using it.');
    const body = channel === 'affiliate_email' ? copy.email.text : copy[channel];
    if (!body.includes(link)) chBlocking.push('Message is missing the fight link.');
    if (!body.includes(a) || !body.includes(b)) chBlocking.push('Message is missing a fighter name.');
    if (channel === 'x' && xLength(body) > X_LIMIT) chBlocking.push(`X post is longer than ${X_LIMIT} characters.`);
    if (channel === 'instagram' && body.length > 2200) chBlocking.push('Instagram caption is longer than 2,200 characters.');
    channels[channel] = {
      enabled: true, label: CHANNEL_LABELS[channel], link,
      text: channel === 'affiliate_email' ? copy.email.text : body,
      subject: channel === 'affiliate_email' ? copy.email.subject : undefined,
      html: channel === 'affiliate_email' ? copy.email.html : undefined,
      characterCount: channel === 'x' ? xLength(body) : body.length,
      image: poster ? { url: poster.url, kind: poster.kind, hasQr: poster.hasQr } : null,
      blocking: chBlocking, warnings: chWarnings,
      checks: Object.fromEntries(REVIEW_CHECKS.map((check) => [check, { status: 'pending' }])),
    };
  }

  // Fingerprint of every fact the copy depends on. If the Fight Registry or
  // the poster changes, the fingerprint changes and approval is refused.
  const facts = {
    fightId, source, affiliateId, a, b, eventName, venueLine, dateKey: schedule.dateKey,
    timeText: schedule.timeText, timeZone: schedule.timeZone, poster: poster ? `${poster.kind}:${poster.url}:${poster.qrLink}` : '',
    links: Object.values(channels).map((c) => c.link || '').join('|'),
  };
  const fingerprint = sha256(JSON.stringify(facts));
  const allBlocking = Object.values(channels).filter((c) => c.enabled).flatMap((c) => c.blocking);
  const allWarnings = [...warnings, ...Object.values(channels).filter((c) => c.enabled).flatMap((c) => c.warnings)];
  const state = allBlocking.length || allWarnings.length ? 'needs_review' : 'draft';

  return {
    campaign: {
      kind: 'fight_campaign',
      fightId, fightSource: source, affiliateId: affiliateId || null,
      affiliateName: affiliate ? cleanText(affiliate.leagueName || affiliate.playerName || [affiliate.firstName, affiliate.lastName].filter(Boolean).join(' '), 80) : null,
      sport: sport.id, sportName: sport.label,
      matchup: `${a} vs ${b}`, fighterA: a, fighterB: b, eventName, venue: venueLine || null,
      schedule: { dateKey: schedule.dateKey, dateText: schedule.dateText, timeText: schedule.timeText, timeZone: schedule.timeZone, startsAt: schedule.startsAt, timeTba: schedule.timeTba },
      poster, channels,
      state, validation: { blocking: [...new Set(allBlocking)], warnings: [...new Set(allWarnings)], checkedAt: new Date(now).toISOString() },
      fingerprint, dedupeKey: sha256(`${fightId}|${affiliateId}|${fingerprint}`),
      publishingEnabled: false, sent: false,
    },
  };
}

// -------------------------------------------------------- state machine ----

// Applies one owner review check. Returns { error } or { campaign } (a copy).
function applyReviewCheck(campaign, { channel, check, result, note = '', reviewer = 'admin', now = Date.now() }) {
  if (!campaign) return { error: 'Campaign not found.' };
  if (!['draft', 'needs_review'].includes(campaign.state)) return { error: 'Checks can only be changed before approval. Move the campaign back to review first.' };
  const ch = campaign.channels?.[channel];
  if (!ch || !ch.enabled) return { error: 'Unknown or unavailable channel.' };
  if (!REVIEW_CHECKS.includes(check)) return { error: 'Unknown review check.' };
  if (!['pass', 'fail', 'pending'].includes(result)) return { error: 'Result must be pass, fail or pending.' };
  const next = JSON.parse(JSON.stringify(campaign));
  next.channels[channel].checks[check] = { status: result, note: cleanText(note, 300), by: cleanText(reviewer, 120), at: new Date(now).toISOString() };
  const failed = Object.entries(next.channels).flatMap(([name, c]) => (c.enabled ? Object.entries(c.checks || {}).filter(([, v]) => v.status === 'fail').map(([k]) => `${CHANNEL_LABELS[name]}: ${REVIEW_CHECK_LABELS[k]} — marked as failed`) : []));
  next.validation = { ...next.validation, reviewFailures: failed };
  next.state = next.validation.blocking.length || next.validation.warnings.length || failed.length ? 'needs_review' : 'draft';
  return { campaign: next };
}

// Phase 1 transitions only. queued/published/failed are refused outright.
// `current` is a fresh rebuild from the live Fight Registry (or null when
// the fight can no longer be promoted).
function transition(campaign, { to, current = null, reviewer = 'admin', note = '', now = Date.now() }) {
  if (!campaign) return { error: 'Campaign not found.' };
  if (!STATES.includes(to)) return { error: 'Unknown status.' };
  if (DISTRIBUTION_STATES.includes(to)) return { error: 'Publishing is not enabled. Campaigns cannot be queued or published in Phase 1.' };
  if (DISTRIBUTION_STATES.includes(campaign.state)) return { error: 'This campaign is already in distribution and cannot be changed here.' };
  const next = JSON.parse(JSON.stringify(campaign));
  next.history = [...(next.history || []), { from: campaign.state, to, by: cleanText(reviewer, 120), note: cleanText(note, 300), at: new Date(now).toISOString() }].slice(-50);
  if (to === 'approved') {
    const problems = [];
    if (!current || current.skipped) problems.push(...(current?.reasons || ['This fight can no longer be promoted.']));
    else if (current.campaign.fingerprint !== campaign.fingerprint) problems.push('The fight record or poster changed after this draft was made. Generate a fresh draft and review it.');
    if (campaign.validation?.blocking?.length) problems.push(...campaign.validation.blocking);
    for (const [name, ch] of Object.entries(campaign.channels || {})) {
      if (!ch.enabled) continue;
      for (const check of REVIEW_CHECKS) {
        if (ch.checks?.[check]?.status !== 'pass') problems.push(`${CHANNEL_LABELS[name]}: “${REVIEW_CHECK_LABELS[check]}” has not been confirmed.`);
      }
    }
    if (problems.length) return { error: 'This campaign cannot be approved yet.', problems: [...new Set(problems)] };
    next.state = 'approved';
    next.approvedAt = new Date(now).toISOString();
    next.approvedBy = cleanText(reviewer, 120);
    return { campaign: next };
  }
  if (to === 'draft' && (campaign.validation?.blocking?.length || campaign.validation?.reviewFailures?.length)) {
    return { error: 'Resolve the listed problems before returning this campaign to draft.' };
  }
  next.state = to;
  if (campaign.state === 'approved') { next.approvedAt = null; next.approvedBy = null; }
  return { campaign: next };
}

module.exports = {
  STATES, DISTRIBUTION_STATES, CHANNELS, CHANNEL_LABELS, REVIEW_CHECKS, REVIEW_CHECK_LABELS, X_LIMIT,
  cleanText, escapeHtml, isPlaceholderName, sportFor, describeSchedule, ownerFightLink,
  validateCampaignUrl, xLength, isPublicFight, fightEligibility, choosePoster, buildFightCampaign,
  applyReviewCheck, transition,
};
