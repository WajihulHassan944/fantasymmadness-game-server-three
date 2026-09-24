const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const safeImage = (src) => /^https:\/\/[a-z0-9.-]+(?::443)?\//i.test(String(src || '')) ? escapeHtml(src) : '';

function affiliateFightEmail({ affiliate, fight, fightId, appUrl }) {
  const id = String(affiliate._id);
  const base = String(appUrl || 'https://www.fantasymmadness.com').replace(/\/$/, '');
  const fightLink = `${base}/fight/${encodeURIComponent(fightId)}?ref=${encodeURIComponent(id)}`;
  const kitLink = `${base}/affiliate/fight-launch?fightId=${encodeURIComponent(fightId)}`;
  const qrLink = `${base}/api/fight-qr?fightId=${encodeURIComponent(fightId)}&affiliateId=${encodeURIComponent(id)}`;
  const prize = Math.max(0, Math.round(Number(fight.pot) || 0));
  const entry = Math.max(0, Math.round(Number(fight.matchTokens) || 0));
  const fighterA = escapeHtml(fight.matchFighterA || 'FIGHTER A');
  const fighterB = escapeHtml(fight.matchFighterB || 'FIGHTER B');
  const photoA = safeImage(fight.fighterAImage);
  const photoB = safeImage(fight.fighterBImage);
  const name = escapeHtml(affiliate.firstName || 'Fight fan');
  const sport = escapeHtml(fight.matchCategoryTwo || fight.matchCategory || 'FIGHT NIGHT');
  const details = prize ? `PRIZE: ${prize.toLocaleString()} FM COINS` : 'PREDICT • SCORE • CLIMB';
  return `<!doctype html><html><body style="margin:0;background:#0a0c16;font-family:Arial,sans-serif;color:#fff">
<div style="display:none;font-size:1px;color:#0a0c16">Your personal fight poster and tracked QR are ready to share.</div>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#0a0c16"><tr><td align="center" style="padding:18px">
<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;background:#141a2b;border:1px solid #76314a;border-radius:16px;overflow:hidden">
<tr><td align="center" style="padding:22px 20px 10px;background:#090b16"><img src="${base}/images/fmm-experience/fantasy-mmadness-logo.png" alt="FANTASY MMADNESS" width="140" style="display:block;max-width:140px;width:100%"></td></tr>
<tr><td align="center" style="padding:8px 22px 0;font-size:14px;font-weight:bold;letter-spacing:3px;color:#ffcb57">${sport.toUpperCase()}</td></tr>
<tr><td style="padding:10px 14px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td align="center" width="45%" style="background:#112346;padding:12px">${photoA ? `<img src="${photoA}" alt="${fighterA}" width="220" height="180" style="display:block;max-width:100%;object-fit:contain">` : ''}<strong style="font-size:22px">${fighterA}</strong></td>
<td align="center" width="10%" style="background:#10111e;color:#ffca51;font-size:30px;font-weight:bold">VS</td>
<td align="center" width="45%" style="background:#461923;padding:12px">${photoB ? `<img src="${photoB}" alt="${fighterB}" width="220" height="180" style="display:block;max-width:100%;object-fit:contain">` : ''}<strong style="font-size:22px">${fighterB}</strong></td>
</tr></table></td></tr>
<tr><td align="center" style="padding:15px 20px 0;color:#ffcf62;font-size:21px;font-weight:900">${escapeHtml(details)}</td></tr>
<tr><td align="center" style="padding:8px 20px 12px;color:#dce1ed;font-size:15px">${entry ? `Entry: ${entry.toLocaleString()} FM coins` : 'The fight is ready to share'}</td></tr>
<tr><td align="center" style="padding:4px 22px 12px;color:#ff394e;font-size:32px;font-weight:900">PREDICT THE FIGHT</td></tr>
<tr><td align="center" style="padding:6px 22px 14px"><a href="${escapeHtml(kitLink)}" style="display:inline-block;padding:16px 25px;background:#f5ad2e;color:#101018;font-size:17px;font-weight:bold;text-decoration:none;border-radius:8px">OPEN MY POSTER + CAPTIONS</a></td></tr>
<tr><td align="center" style="padding:5px 28px;color:#dce1ed;font-size:15px;line-height:1.5">Hi ${name}, the owner has set up this fight. Open your kit to download a social poster with <strong>your personal QR</strong>, then share it with the ready-made caption.</td></tr>
<tr><td align="center" style="padding:12px"><a href="${escapeHtml(fightLink)}"><img src="${escapeHtml(qrLink)}&amp;inline=1" alt="Your personal fight QR" width="130" height="130" style="display:block;background:#fff;padding:7px;border:0"></a></td></tr>
<tr><td align="center" style="padding:14px"><a href="${escapeHtml(fightLink)}" style="color:#ffcc64;word-break:break-all">Your tracked fight link</a> · <a href="${escapeHtml(qrLink)}" style="color:#ffcc64">Download your QR</a></td></tr>
<tr><td align="center" style="padding:15px 25px 24px;color:#aeb7ca;font-size:12px;line-height:1.5">Your tracked paid entries follow the existing affiliate split. Estimated and settled earnings appear in your affiliate Earnings page. FANTASY MMADNESS</td></tr>
</table></td></tr></table></body></html>`;
}

module.exports = { affiliateFightEmail };
