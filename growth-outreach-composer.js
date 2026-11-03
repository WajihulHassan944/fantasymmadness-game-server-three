'use strict';
// Personalized PR pitches and affiliate partnership proposals, built only from researched,
// verifiable facts (growth-prospect-research.js) and verified FANTASY MMADNESS contests.
// Rules: no invented commission, prizes, money, audience numbers or claims; every angle cites
// its evidence; nothing is sent (drafts need the owner's approval).
const { renderPersonalEmail } = require('./growth-business-email-templates');
const { onboardingLink, codeFor } = require('./growth-affiliate-program');
const { MONEY_WORDS } = require('./growth-contest-campaigns');

const SPORT = { boxing: 'boxing', 'mma-ufc': 'MMA', kickboxing: 'kickboxing', 'bare-knuckle': 'bare-knuckle', 'pro-wrestling': 'pro wrestling' };
const fmtDate = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }) : null; };
const firstName = (n) => { const w = String(n || '').trim().split(/\s+/)[0]; return /^[A-Z][a-z'’-]{1,20}$/.test(w) ? w : null; };
const nextContest = (contests, sport, preferId) => contests.find((c) => c.id === preferId) || contests.filter((c) => c.sport === sport).sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey)))[0] || null;

// Which department a show belongs to, from what the show actually is: news/interview shows
// -> PR (coverage); fan, picks and reaction shows -> affiliate (their own fan league).
// Discovery lists overlap (the same show is found by both), so the list is only a tie-breaker.
function assignTrack({ focuses = [], research }) {
  const genres = (research?.show?.genres || []).join(' ').toLowerCase();
  const titles = (research?.recentEpisodes || []).map((e) => e.title).join(' | ');
  const news = (titles.match(/\b(news|interview|report|breaking|press|exclusive|journal|analysis)\b/gi) || []).length + (/news|journalism/.test(genres) ? 3 : 0);
  const fan = (titles.match(/\b(picks?|predictions?|fans?|reaction|watch ?along|live|q&a|mailbag|rank(ings)?|preview)\b/gi) || []).length;
  if (news !== fan) return news > fan ? 'pr' : 'affiliate';
  if (focuses.length === 1) return focuses[0] === 'partners' ? 'pr' : 'affiliate';
  return 'affiliate';
}

function angleFor(research, contests, sport) {
  const fightEv = research.evidence.find((e) => e.kind === 'fight');
  const c = nextContest(contests, sport, fightEv?.contestId);
  const ep = research.recentEpisodes[0];
  if (fightEv && c) return { kind: 'fight_mentioned', contest: c, why: fightEv.text, short: `${c.fighterA} vs ${c.fighterB}` };
  const sportEv = research.evidence.find((e) => e.kind === 'sport');
  if (sportEv && c) return { kind: 'sport_coverage', contest: c, why: `${sportEv.text}, e.g. “${sportEv.examples[0]}”`, short: `${c.fighterA} vs ${c.fighterB}` };
  if (sportEv && ep) return { kind: 'sport_only', contest: null, why: `${sportEv.text}, e.g. “${sportEv.examples[0]}”`, short: `${SPORT[sport]} fans` };
  return null;
}

// Returns { ok:false, reason } when the research is not strong enough to personalize honestly.
function compose({ prospect, research, contests = [], track }) {
  if (!research?.ok) return { ok: false, reason: 'research_failed' };
  if (!research.contact) return { ok: false, reason: 'no_verified_contact_route' };
  const sport = prospect.genre;
  const angle = angleFor(research, contests, sport);
  if (!angle) return { ok: false, reason: 'no_evidence_based_angle' };
  const show = research.show.title;
  const who = firstName(research.contact.name) || firstName(research.show.author);
  const greeting = who ? `Hi ${who},` : `Hello ${show} team,`;
  const ep = research.recentEpisodes[0];
  const epLine = ep?.title ? `I listened to your recent episode “${ep.title}”${fmtDate(ep.date) ? ` (${fmtDate(ep.date)})` : ''}.` : `I have been following ${show}.`;
  const c = angle.contest;
  const fight = c ? `${c.fighterA} vs ${c.fighterB}${fmtDate(`${c.dateKey}T12:00:00Z`) ? ` on ${fmtDate(`${c.dateKey}T12:00:00Z`)}` : ''}` : null;
  const paragraphs = []; let subject; let cta = null; let eyebrow;
  if (track === 'pr') {
    eyebrow = 'MEDIA & PR';
    subject = c ? `${show}: a round-by-round angle on ${angle.short}` : `${show}: a story idea for ${SPORT[sport]} fans`;
    paragraphs.push(`${epLine} ${angle.kind === 'fight_mentioned' ? `${angle.why}, so I thought this might fit.` : 'Your coverage is exactly the audience we built this for.'}`);
    paragraphs.push(`FANTASY MMADNESS lets fans call a fight round by round, across boxing, MMA, kickboxing, bare-knuckle and pro wrestling, then compare their card with everyone else's.${fight ? ` Our contest for ${fight} is open now.` : ''}`);
    paragraphs.push(`Story ideas for ${show}: how fans scored ${c ? angle.short : 'a recent fight'} round by round compared with the judges, or a short conversation about building a fan-scoring platform for combat sports. Happy to share the round-by-round data after the fight.`);
    paragraphs.push('Would a short call or an email interview work for you?');
  } else {
    eyebrow = 'PARTNERSHIP PROPOSAL';
    subject = c ? `${show} fan league for ${angle.short}` : `A fan league for ${show}`;
    paragraphs.push(`${epLine} ${angle.kind === 'fight_mentioned' ? `${angle.why}.` : `Your listeners clearly follow ${SPORT[sport]} closely.`}`);
    paragraphs.push(`We would like to set up a ${show} fan league on FANTASY MMADNESS: your own league page and tracked link, a QR code and a ready-to-share fight kit, so your audience can call fights round by round and see where they rank against each other.${fight ? ` ${fight} would be a natural first fight for the league.` : ''}`);
    paragraphs.push('The affiliate program terms are shown on the sign-up page before you join, so you can review everything first. There is nothing to pay to set up the league.');
    paragraphs.push('Would you like me to set it up, or walk you through it on a quick call?');
    cta = { label: 'See the affiliate program', url: onboardingLink({ code: codeFor(prospect.id, prospect.name) }) }; // same code the program assigns on approval
  }
  const email = renderPersonalEmail({ eyebrow, subject, greeting, paragraphs, cta });
  // Final safeguard: nothing about money/prizes/commission, and the show + evidence are in the text.
  const body = `${email.subject}\n${email.text}`;
  const problems = [];
  if (MONEY_WORDS.test(body.replace(/nothing to pay/gi, ''))) problems.push('mentions_money_or_prizes');
  if (!email.text.includes(show)) problems.push('missing_show_name');
  if (/\b\d{2,}\s*%|\$\s?\d/.test(body)) problems.push('mentions_numbers_that_look_like_terms');
  if (problems.length) return { ok: false, reason: 'composer_safeguard', problems };
  return { ok: true, ...email, angle: { kind: angle.kind, why: angle.why, contestId: c?.id || null }, evidence: research.evidence, recentEpisode: ep || null };
}

module.exports = { compose, assignTrack };
