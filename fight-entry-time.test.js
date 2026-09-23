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
