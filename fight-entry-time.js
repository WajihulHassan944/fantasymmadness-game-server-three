// Match dates are stored at midnight for calendar grouping; the separate
// matchTime is the scheduled start. Entries must lock at that start, not at
// midnight at the beginning of the event day.
const getFightEntryLockTime = (fight) => {
  if (fight?.lockAt) {
    const explicit = new Date(fight.lockAt).getTime();
    if (Number.isFinite(explicit)) return explicit;
  }

  const rawDate = fight?.matchDateKey || fight?.matchDate;
  const date = String(rawDate instanceof Date ? rawDate.toISOString() : rawDate || '').slice(0, 10);
  const time = String(fight?.matchTime || '').trim();
  const parts = time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !parts) {
    const fallback = new Date(fight?.matchDate || '').getTime();
    return Number.isFinite(fallback) ? fallback : NaN;
  }

  const [year, month, day] = date.split('-').map(Number);
  const hour = Number(parts[1]);
  const minute = Number(parts[2]);
  const second = Number(parts[3] || 0);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return NaN;

  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  const zone = String(fight?.eventTimeZone || 'UTC');
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return NaN;
  }
  const asWallTime = (timestamp) => {
    const fields = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
    return Date.UTC(Number(fields.year), Number(fields.month) - 1, Number(fields.day), Number(fields.hour), Number(fields.minute), Number(fields.second));
  };
  let instant = target;
  for (let i = 0; i < 3; i += 1) instant += target - asWallTime(instant);
  // An invalid local time during a DST jump must never silently shift entry
  // to another hour. The admin can enter a valid event time instead.
  return asWallTime(instant) === target ? instant : NaN;
};

const isFightOpenForEntry = (fight, now = Date.now()) => {
  const status = String(fight?.matchStatus || '').toLowerCase();
  if (['finished', 'closed', 'draft'].includes(status) || fight?.entryClosedAt) return false;
  if (String(fight?.matchShadowOpenStatus || 'open').toLowerCase() === 'closed') return false;
  if (String(fight?.matchShadowStatus || 'active').toLowerCase() === 'inactive') return false;
  const lock = getFightEntryLockTime(fight);
  return Number.isFinite(lock) && lock > now;
};

module.exports = { getFightEntryLockTime, isFightOpenForEntry };
