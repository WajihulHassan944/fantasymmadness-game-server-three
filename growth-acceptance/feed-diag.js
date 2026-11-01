'use strict';
// TEST ONLY: read-only. Why did future-dated Boxing / Bare-Knuckle listings fail verification?
// Exit = 1 + bitmask of reasons: horizon=1, not_open/closed=2, auto_discovered=4,
// shadow/mystery=8, name_placeholder_or_media=16, locked/entries_closed=32, other=64.
const cc = require('../growth-contest-campaigns');
(async () => {
  try {
    const pf = await (await fetch(`${cc.DEFAULT_SOURCE}/api/public/prediction-fights?limit=100`)).json();
    const today = new Date().toISOString().slice(0, 10); let mask = 0;
    for (const it of (pf.items || []).map((x) => ({ ...x, __feed: 'prediction' }))) {
      const sp = cc.sportOf(it); if (!['boxing', 'bare-knuckle'].includes(sp)) continue;
      const key = it.matchDateKey || (it.matchDate ? new Date(it.matchDate).toISOString().slice(0, 10) : '');
      if (!key || key < today) continue;
      const v = cc.verifyContest(it, { now: new Date() }); if (v.ok) continue;
      for (const r of v.reasons) {
        if (/horizon/.test(r)) mask |= 1; else if (/not_open|entries_closed$|contest_entries_closed/.test(r)) mask |= 2; else if (/auto_discovered/.test(r)) mask |= 4;
        else if (/shadow/.test(r)) mask |= 8; else if (/fighter_/.test(r) || /same_fighter|media/.test(r)) mask |= 16; else if (/locked|entries_already/.test(r)) mask |= 32; else mask |= 64;
      }
    }
    process.exit(1 + mask);
  } catch (e) { process.exit(250); }
})();
