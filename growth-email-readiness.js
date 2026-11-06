'use strict';
// Read-only readiness check for verified business email (PR + affiliate outreach).
// Checks the sender domain's public DNS (SPF, DKIM for the provider, DMARC) via
// DNS-over-HTTPS and, when an API key is configured, the provider's own domain
// verification status. It never sends anything; real sending stays off until
// every approval flag in growth-runtime-config.js is set.
const PROVIDER_DKIM_SELECTOR = 'resend._domainkey';

async function txt(fetchImpl, name) {
  const r = await fetchImpl(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, { headers: { Accept: 'application/dns-json' } });
  if (!r.ok) throw Error(`DNS lookup failed (${r.status})`);
  const j = await r.json();
  return (j.Answer || []).filter((a) => a.type === 16).map((a) => String(a.data || '').replace(/^"|"$/g, '').replace(/"\s*"/g, ''));
}

async function checkEmailReadiness({ delivery, sender, apiKey = '', fetchImpl = globalThis.fetch }) {
  const domain = String(sender || '').split('@')[1] || '';
  const out = {
    sender, domain, provider: delivery.provider, realDelivery: delivery.realDelivery === true, sendingBlockers: delivery.blockers || [],
    dns: { spf: null, dkim: null, dmarc: null, error: null }, providerDomain: { checked: false, status: null, error: null }, ready: false, steps: [],
  };
  try {
    const [root, dkim, dmarc] = await Promise.all([txt(fetchImpl, domain), txt(fetchImpl, `${PROVIDER_DKIM_SELECTOR}.${domain}`), txt(fetchImpl, `_dmarc.${domain}`)]);
    out.dns.spf = root.some((t) => /^v=spf1\b/i.test(t));
    out.dns.dkim = dkim.some((t) => /p=[A-Za-z0-9+/=]{40,}/.test(t));
    out.dns.dmarc = dmarc.some((t) => /^v=DMARC1\b/i.test(t));
  } catch (e) { out.dns.error = String(e.message).slice(0, 200); }
  if (apiKey) {
    try {
      const r = await fetchImpl('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${apiKey}` } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) out.providerDomain.error = `provider returned ${r.status}`;
      else { const d = (j.data || []).find((x) => String(x.name).toLowerCase() === domain.toLowerCase()); out.providerDomain = { checked: true, status: d ? d.status : 'not_added', error: null }; }
    } catch (e) { out.providerDomain.error = String(e.message).slice(0, 200); }
  }
  const step = (done, text) => out.steps.push({ done: Boolean(done), text });
  step(out.dns.spf, `SPF record published for ${domain}`);
  step(out.dns.dkim, `DKIM key published at ${PROVIDER_DKIM_SELECTOR}.${domain} (from the email provider's domain setup)`);
  step(out.dns.dmarc, `DMARC record published at _dmarc.${domain}`);
  step(out.providerDomain.status === 'verified', 'Sender domain shows "verified" at the email provider');
  step(out.realDelivery, 'Owner approval flags set to switch real sending on');
  out.ready = out.steps.every((s) => s.done);
  return out;
}

module.exports = { checkEmailReadiness };
