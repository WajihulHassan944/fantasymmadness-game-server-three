'use strict';
// TEST ONLY: read-only diagnostic of the public FANTASY MMADNESS contest feeds.
// Exit code = 128 + bitmask of sports that have at least one FUTURE-dated listing
// (any status) in the feeds (boxing=1, mma-ufc=2, kickboxing=4, bare-knuckle=8, pro-wrestling=16).
// 64 + mask (second line of evidence) is printed to the log only.
const cc = require('../growth-contest-campaigns');
(async () => {
  try {
    const base = cc.DEFAULT_SOURCE;
    const pf = await (await fetch(`${base}/api/public/prediction-fights?limit=100`)).json();
    const pw = await (await fetch(`${base}/api/public/pro-wrestling/matches?limit=50`)).json();
    const today = new Date().toISOString().slice(0, 10);
    let mask = 0;
    const rows = [...(pf.items || []).map((x) => ({ ...x, __feed: 'prediction' })), ...(pw.items || []).map((x) => ({ ...x, __feed: 'pro-wrestling' }))];
    for (const it of rows) {
      const sp = cc.sportOf(it); if (!sp) continue;
      const key = it.matchDateKey || (it.matchDate ? new Date(it.matchDate).toISOString().slice(0, 10) : '');
      if (key && key >= today) mask |= 1 << cc.SPORTS.indexOf(sp);
    }
    console.log('[feed-diag]', rows.length, 'listings; future mask', mask);
    process.exit(64 + mask);
  } catch (e) { console.log('[feed-diag] failed', e.message); process.exit(1); }
})();
