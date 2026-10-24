const test = require('node:test');
const assert = require('node:assert/strict');
const { getFightEntryLockTime, isFightOpenForEntry } = require('./fight-entry-time');

test('a later main event remains open past midnight on its fight date', () => {
  const lock = getFightEntryLockTime({ matchDate: '2026-09-23T00:00:00.000Z', matchTime: '22:00', eventTimeZone: 'America/New_York' });
  assert.equal(new Date(lock).toISOString(), '2026-09-24T02:00:00.000Z');
});

test('a manual per-fight cutoff overrides the estimated start', () => {
  const lock = getFightEntryLockTime({ matchDate: '2026-09-23T00:00:00.000Z', matchTime: '22:00', eventTimeZone: 'America/New_York', lockAt: '2026-09-24T01:30:00.000Z' });
  assert.equal(lock, Date.parse('2026-09-24T01:30:00.000Z'));
});

test('event time zone accounts for daylight saving time', () => {
  assert.equal(new Date(getFightEntryLockTime({ matchDateKey: '2026-01-15', matchTime: '20:00', eventTimeZone: 'America/New_York' })).toISOString(), '2026-01-16T01:00:00.000Z');
  assert.equal(new Date(getFightEntryLockTime({ matchDateKey: '2026-07-15', matchTime: '20:00', eventTimeZone: 'America/New_York' })).toISOString(), '2026-07-16T00:00:00.000Z');
});

test('legacy fights without a time zone use the existing Eastern-time form convention', () => {
  assert.equal(new Date(getFightEntryLockTime({ matchDateKey: '2026-09-23', matchTime: '22:00' })).toISOString(), '2026-09-24T02:00:00.000Z');
});

test('invalid scheduled times do not open entry indefinitely', () => {
  assert.ok(Number.isNaN(getFightEntryLockTime({ matchDateKey: '2026-09-23', matchTime: '26:00' })));
});

test('scheduled and manual locks both stop new entries for only that bout', () => {
  const bout = { matchDateKey: '2026-09-23', matchTime: '22:00', eventTimeZone: 'America/New_York', matchStatus: 'Ongoing' };
  assert.equal(isFightOpenForEntry(bout, Date.parse('2026-09-23T20:00:00Z')), true);
  assert.equal(isFightOpenForEntry(bout, Date.parse('2026-09-24T02:00:00Z')), false);
  assert.equal(isFightOpenForEntry({ ...bout, entryClosedAt: new Date('2026-09-23T20:00:00Z') }, Date.parse('2026-09-23T20:00:01Z')), false);
  assert.equal(isFightOpenForEntry({ ...bout, lockAt: '2026-09-23T21:00:00Z' }, Date.parse('2026-09-23T21:00:00Z')), false);
});

test('published live fights ignore inherited shadow closure but retain entry locks', () => {
  const bout = { matchType: 'LIVE', matchStatus: 'Ongoing', matchDate: '2026-10-17T00:00:00.000Z', matchTime: '23:00', matchShadowOpenStatus: 'closed', matchShadowStatus: 'inactive' };
  const now = Date.parse('2026-10-13T12:00:00Z');
  assert.equal(isFightOpenForEntry(bout, now), true);
  assert.equal(isFightOpenForEntry({ ...bout, entryClosedAt: new Date(now) }, now), false);
  assert.equal(isFightOpenForEntry({ ...bout, lockAt: new Date(now) }, now), false);
  assert.equal(isFightOpenForEntry({ ...bout, matchStatus: 'Finished' }, now), false);
  assert.equal(isFightOpenForEntry(bout, getFightEntryLockTime(bout)), false);
  assert.equal(isFightOpenForEntry({ ...bout, matchType: 'SHADOW' }, now), false);
});

const { closeEntriesForScoring } = require('./fight-entry-time');

test('first scoring action closes an open fight with an audit trail', () => {
  const bout = { matchDateKey: '2026-10-24', matchTime: '20:00', eventTimeZone: 'America/New_York', matchStatus: 'Ongoing', matchType: 'LIVE' };
  const before = Date.parse('2026-10-24T23:00:00Z'); // 7 PM ET, before the 8 PM cutoff
  assert.equal(isFightOpenForEntry(bout, before), true);
  const at = new Date('2026-10-24T23:05:00Z');
  assert.equal(closeEntriesForScoring(bout, { actor: 'scorer:judge@example.com', now: at }), true);
  assert.equal(isFightOpenForEntry(bout, before), false);
  assert.equal(bout.entryClosedReason, 'scoring_started');
  assert.equal(bout.entryClosedBy, 'scorer:judge@example.com');
  assert.equal(bout.entryClosedAt, at);
});

test('later scoring rounds keep the original closure time, reason and actor', () => {
  const first = new Date('2026-10-24T23:05:00Z');
  const bout = { matchStatus: 'Ongoing', entryClosedAt: first, entryClosedReason: 'scoring_started', entryClosedBy: 'scorer:a' };
  assert.equal(closeEntriesForScoring(bout, { actor: 'scorer:b', now: new Date('2026-10-24T23:30:00Z') }), false);
  assert.equal(bout.entryClosedAt, first);
  assert.equal(bout.entryClosedBy, 'scorer:a');
});

test('a manual admin closure is not relabelled by scoring', () => {
  const manual = new Date('2026-10-24T22:00:00Z');
  const bout = { entryClosedAt: manual };
  assert.equal(closeEntriesForScoring(bout, { actor: 'admin:x' }), false);
  assert.equal(bout.entryClosedAt, manual);
  assert.equal(bout.entryClosedReason, undefined);
});
