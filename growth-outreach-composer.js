'use strict';
// Personalized PR pitches and affiliate partnership proposals, built only from researched,
// verifiable facts (growth-prospect-research.js) and verified FANTASY MMADNESS contests.
// Rules: no invented commission, prizes, money, audience numbers or claims; every angle cites
// its evidence; nothing is sent (drafts need the owner's approval).
const {readable,greetingFor}=require('./growth-text-quality');
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
  return research?.affiliateSuitability?.verified===true && (research.affiliateSuitability.evidence||[]).some(e=>/^https:\/\//.test(e.sourceUrl||'')) ? 'affiliate' : 'pr';
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
  research={...research,show:{...research.show,title:readable(research.show.title),author:readable(research.show.author)},recentEpisodes:(research.recentEpisodes||[]).map(e=>({...e,title:readable(e.title)})),evidence:(research.evidence||[]).map(e=>({...e,text:readable(e.text)}))};
  const sport = prospect.genre;
  const angle = angleFor(research, contests, sport);
  if (!angle) return { ok: false, reason: 'no_evidence_based_angle' };
  const show = research.show.title;
  const greeting = greetingFor(research.contact,research.show);
  const ep = research.recentEpisodes[0];
  const epLine = ep?.title ? `I came across your recent episode “${ep.title}”${fmtDate(ep.date) ? ` (${fmtDate(ep.date)})` : ''}.` : `I came across ${show} while researching combat-sports coverage.`;
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
    paragraphs.push(`${epLine} ${angle.kind === 'fight_mentioned' ? `${angle.why}.` : `Your published coverage focuses on ${SPORT[sport]} closely.`}`);
    paragraphs.push(`We would like to set up a ${show} fan league on FANTASY MMADNESS: your own league page and tracked link, a QR code and a ready-to-share fight kit, so your audience can call fights round by round and see where they rank against each other.${fight ? ` ${fight} would be a natural first fight for the league.` : ''}`);
    paragraphs.push('Potential commissions from qualifying referred paying players depend on the approved affiliate terms and eligibility. We can review those terms together; no rates or earnings are promised. Your tracked link and QR code, promotional posters and fight kit can help you invite your community, with performance and attribution reporting where available.');
    paragraphs.push('Would you be open to reviewing how a fan league could work for your audience?');
    cta = { label:'Join the FANTASY MMADNESS Affiliate Program', url: onboardingLink({ code: codeFor(prospect.id, prospect.name) }) }; // same code the program assigns on approval
  }
  const email = renderPersonalEmail({ eyebrow, subject, greeting, paragraphs, cta });
  // Final safeguard: nothing about money/prizes/commission, and the show + evidence are in the text.
  const body = `${email.subject}\n${email.text}`;
  const problems = [];
  if (MONEY_WORDS.test(body.replace(/nothing to pay|Potential commissions from qualifying referred paying players depend on the approved affiliate terms and eligibility/gi, ''))) problems.push('mentions_money_or_prizes');
  if (!email.text.includes(show)) problems.push('missing_show_name');
  if (/\b\d{2,}\s*%|\$\s?\d/.test(body)) problems.push('mentions_numbers_that_look_like_terms');
  if (problems.length) return { ok: false, reason: 'composer_safeguard', problems };
  return { ok: true, ...email, greeting, composerVersion:2, angle: { kind: angle.kind, why: angle.why, contestId: c?.id || null }, evidence: research.evidence, recentEpisode: ep || null };
}

module.exports = { compose, assignTrack };
