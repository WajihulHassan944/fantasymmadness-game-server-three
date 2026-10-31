'use strict';
// Pure, offline controller model. Does not connect to production, send messages or schedule itself.
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 60_000;
const ALLOWED = new Set(['discover', 'prepare_campaign', 'prepare_pr', 'prepare_followup', 'aggregate_report']);
function makeJob({ id, type, dueAt, payload = {} }) {
  if (!id || !ALLOWED.has(type) || !Number.isFinite(Date.parse(dueAt))) throw new Error('Invalid job');
  return { id: String(id), type, dueAt: new Date(dueAt).toISOString(), payload, attempts: 0, state: 'pending', lastError: null };
}
function claimDue(jobs, now = Date.now()) {
  const seen = new Set();
  return jobs.filter(j => {
    if (!['pending', 'retry'].includes(j.state) || Date.parse(j.dueAt) > now || seen.has(j.id)) return false;
    seen.add(j.id); return true;
  }).map(j => ({ ...j, state: 'running', attempts: j.attempts + 1 }));
}
function settle(job, { success, error = '', now = Date.now() }) {
  if (job.state !== 'running') throw new Error('Job must be claimed');
  if (success) return { ...job, state: 'completed', completedAt: new Date(now).toISOString() };
  const exhausted = job.attempts >= MAX_ATTEMPTS;
  return { ...job, state: exhausted ? 'failed' : 'retry', lastError: String(error).slice(0, 200),
    dueAt: exhausted ? job.dueAt : new Date(now + BASE_DELAY_MS * 2 ** (job.attempts - 1)).toISOString() };
}
function followupAllowed(contact) {
  return contact?.consent === true && contact?.status === 'contacted' &&
    contact?.replied !== true && contact?.optedOut !== true && contact?.declined !== true;
}
function safeReport(events) {
  const verified = events.filter(e => e.verified === true && ['visit','signup','paid_entry'].includes(e.type));
  return { visits: verified.filter(e => e.type === 'visit').length, signups: verified.filter(e => e.type === 'signup').length,
    paidEntries: verified.filter(e => e.type === 'paid_entry').length, unverifiedExcluded: events.length - verified.length };
}
module.exports = { makeJob, claimDue, settle, followupAllowed, safeReport };
