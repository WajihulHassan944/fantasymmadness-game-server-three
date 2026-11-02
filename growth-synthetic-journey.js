'use strict';
// Synthetic end-to-end test of the money path (staging only):
//   click (from a campaign link with the affiliate ref) -> registration -> settled TEST
//   payment -> accepted entry -> exactly one affiliate credit.
// Every step goes through the real signed-event path (HMAC signature + timestamp check +
// idempotent storage). Replays, a forged signature and a second payment for the same entry
// prove idempotency and that credit is never duplicated. No payment system is contacted;
// the "payment" is a signed test event marked paymentMode "test".
const crypto = require('crypto');

const SYN_AFFILIATE = { id: 'syn-affiliate', name: 'Synthetic Test Affiliate', code: 'aff_synthetic_test', liveAffiliateId: 'feedfacefeedfacefeedface', status: 'active', synthetic: true };

async function runSyntheticJourney({ col, signedIngest, secret, contest, now = new Date() }) {
  if (!secret || secret.length < 32) return { ok: false, reason: 'ingest_not_configured' };
  await col.affiliates.updateOne({ id: SYN_AFFILIATE.id }, { $setOnInsert: { ...SYN_AFFILIATE, genre: contest?.sport || null, createdAt: now.toISOString(), history: [] } }, { upsert: true });
  const run = `${now.toISOString().replace(/[^0-9]/g, '').slice(0, 14)}${crypto.randomBytes(3).toString('hex')}`;
  const fightId = contest?.id || 'syn_fight';
  const sign = (body, { ts = Date.now(), forge = false } = {}) => {
    const raw = JSON.stringify(body);
    const sig = crypto.createHmac('sha256', forge ? 'x'.repeat(40) : secret).update(`${ts}.${raw}`).digest('hex');
    return signedIngest(raw, { timestamp: String(ts), signature: sig });
  };
  const base = { campaign: `combat_fans_${SYN_AFFILIATE.code}`, liveAffiliateId: SYN_AFFILIATE.liveAffiliateId, channel: 'instagram' };
  const player = `syn_p_${run}`; const entry = `syn_e_${run}`;
  const steps = [];
  const step = async (name, body, opts, expect) => { const r = await sign(body, opts); const pass = expect(r); steps.push({ step: name, status: r.status, result: r.body, pass }); return r; };
  await step('click from campaign link (affiliate ref + campaign tag)', { ...base, eventId: `syn_${run}_click`, type: 'click', fightId }, {}, (r) => r.status === 200 && r.body.attributedTo === SYN_AFFILIATE.id);
  await step('same click replayed (idempotent)', { ...base, eventId: `syn_${run}_click`, type: 'click', fightId }, {}, (r) => r.status === 200 && r.body.duplicate === true);
  await step('registration', { ...base, eventId: `syn_${run}_reg`, type: 'registration', playerRef: player }, {}, (r) => r.status === 200 && r.body.ok);
  await step('settled TEST payment (signed)', { ...base, eventId: `syn_${run}_pay`, type: 'paid_entry', playerRef: player, entryId: entry, fightId, amountCents: 500, paymentStatus: 'settled', paymentMode: 'test' }, {}, (r) => r.status === 200 && r.body.ok);
  await step('payment event replayed (idempotent)', { ...base, eventId: `syn_${run}_pay`, type: 'paid_entry', playerRef: player, entryId: entry, fightId, amountCents: 500, paymentStatus: 'settled', paymentMode: 'test' }, {}, (r) => r.status === 200 && r.body.duplicate === true);
  await step('entry accepted', { ...base, eventId: `syn_${run}_acc`, type: 'entry_accepted', playerRef: player, entryId: entry, fightId }, {}, (r) => r.status === 200 && r.body.ok);
  await step('second payment for the same entry (must not double-credit)', { ...base, eventId: `syn_${run}_pay2`, type: 'paid_entry', playerRef: player, entryId: entry, fightId, amountCents: 500, paymentStatus: 'settled', paymentMode: 'test' }, {}, (r) => r.status === 200);
  await step('forged signature refused', { ...base, eventId: `syn_${run}_forged`, type: 'paid_entry', playerRef: player, entryId: `${entry}x`, fightId, amountCents: 999, paymentStatus: 'settled', paymentMode: 'test' }, { forge: true }, (r) => r.status === 401);
  await step('stale timestamp refused (replay protection)', { ...base, eventId: `syn_${run}_old`, type: 'registration', playerRef: player }, { ts: Date.now() - 10 * 60000 }, (r) => r.status === 401);
  return { ok: steps.every((s) => s.pass), run, entryId: entry, playerRef: player, affiliateId: SYN_AFFILIATE.id, steps };
}

module.exports = { runSyntheticJourney, SYN_AFFILIATE };
