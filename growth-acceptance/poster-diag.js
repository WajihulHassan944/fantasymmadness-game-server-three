'use strict';
// One-off read-only diagnostic: how many queued campaigns use official artwork vs a text poster.
// Exit code = 130 + 12*official + text (official capped at 9, text at 11); 1 = error.
const { MongoClient } = require('mongodb');
(async () => {
  const c = await new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 }).connect();
  const d = await c.db('fmgrowthtest').collection('growth_drafts').find({ kind: 'marketing', status: { $in: ['needs_owner_review', 'approved'] } }, { projection: { poster: 1, contest: 1 } }).toArray();
  const off = d.filter((x) => x.poster?.art?.used).length; const txt = d.filter((x) => x.poster && !x.poster.art?.used).length;
  console.log('[poster-diag]', JSON.stringify({ off, txt, reasons: d.filter((x) => x.poster && !x.poster.art?.used).map((x) => x.poster.art.reason) }));
  await c.close(); process.exit(130 + Math.min(off, 9) * 12 + Math.min(txt, 11));
})().catch((e) => { console.error(e); process.exit(1); });
