'use strict';
// TEST ONLY, read-only: public DNS records of the business sender domain.
// Exit = 64 + bits: SPF=1, DKIM(resend._domainkey)=2, DMARC=4, MX=8, domain resolves (any record)=16
(async () => {
  try {
    const d = 'fantasymmadnesscom.com';
    const q = async (name, type) => { const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${name}&type=${type}`, { headers: { Accept: 'application/dns-json' } }); const j = await r.json(); return j; };
    let m = 0;
    const txt = await q(d, 'TXT'); const ans = (txt.Answer || []).map((a) => String(a.data));
    if (ans.some((t) => /v=spf1/i.test(t))) m |= 1;
    if (((await q(`resend._domainkey.${d}`, 'TXT')).Answer || []).length) m |= 2;
    if (((await q(`_dmarc.${d}`, 'TXT')).Answer || []).some((a) => /DMARC1/i.test(a.data))) m |= 4;
    const mx = await q(d, 'MX'); if ((mx.Answer || []).length) m |= 8;
    if (txt.Status === 0 || mx.Status === 0) m |= 16;
    process.exit(64 + m);
  } catch (e) { process.exit(250); }
})();
