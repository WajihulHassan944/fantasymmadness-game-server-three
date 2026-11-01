'use strict';
// Delivery providers for owner-approved Growth Engine drafts.
//  none:          prepares and approves, never sends (default).
//  sandbox-smtp:  loopback SMTP sandbox only (*.localhost recipients).
//  resend:        REAL email via the Resend HTTP API. Constructed only when
//                 resolveGrowthRuntimeConfig() reports every approval flag and
//                 credential present; each send re-checks the draft approval.
const LOOPBACK_RECIPIENT = /^[^@\s]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*localhost$/i;
const REAL_RECIPIENT = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

function approved(draft) {
  return Boolean(draft && draft.id && draft.status === 'approved' && draft.ownerApproved === true && draft.sendPermitted === true && draft.subject && draft.text);
}

function createDeliveryProvider({ config, secrets = {}, transport, fetchImpl = globalThis.fetch } = {}) {
  const provider = config?.delivery?.provider || 'none';
  if (provider === 'none') {
    return { name: 'none', realDelivery: false, async send() { return { ok: false, reason: 'delivery_disabled' }; } };
  }
  if (provider === 'sandbox-smtp') {
    if (!transport || typeof transport.sendMail !== 'function') throw Error('Sandbox SMTP transport required');
    return {
      name: 'sandbox-smtp', realDelivery: false,
      async send(draft) {
        if (!approved(draft)) return { ok: false, reason: 'owner_approval_required' };
        if (!LOOPBACK_RECIPIENT.test(draft.recipient || '')) return { ok: false, reason: 'sandbox_recipient_required' };
        const info = await transport.sendMail({ from: 'growth-sandbox@localhost', to: draft.recipient, subject: draft.subject, text: draft.text, html: draft.html, headers: draft.listUnsubscribe ? { 'List-Unsubscribe': `<${draft.listUnsubscribe}>` } : undefined });
        const id = String(info?.messageId || '').trim();
        return id ? { ok: true, receipt: { providerMessageId: id, sandbox: true, realDelivery: false } } : { ok: false, reason: 'sandbox_receipt_missing' };
      },
    };
  }
  if (provider === 'resend') {
    if (config.delivery.realDelivery !== true) throw Error(`Real delivery not authorized: ${(config.delivery.blockers || []).join('; ')}`);
    if (!secrets.resendApiKey) throw Error('Resend API key missing');
    if (typeof fetchImpl !== 'function') throw Error('fetch required');
    return {
      name: 'resend', realDelivery: true,
      async send(draft) {
        if (!approved(draft)) return { ok: false, reason: 'owner_approval_required' };
        if (!REAL_RECIPIENT.test(draft.recipient || '') || LOOPBACK_RECIPIENT.test(draft.recipient || '')) return { ok: false, reason: 'invalid_recipient' };
        if (!draft.listUnsubscribe || !/^https:\/\//.test(draft.listUnsubscribe)) return { ok: false, reason: 'unsubscribe_link_required' };
        const response = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${secrets.resendApiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `growth-${draft.id}` },
          body: JSON.stringify({ from: `FANTASY MMADNESS <${config.delivery.sender}>`, to: [draft.recipient], subject: draft.subject, html: draft.html, text: draft.text, headers: { 'List-Unsubscribe': `<${draft.listUnsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }),
          signal: AbortSignal.timeout(15000),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || typeof body.id !== 'string' || !body.id) return { ok: false, reason: `provider_rejected_${response.status}` };
        return { ok: true, receipt: { providerMessageId: body.id, sandbox: false, realDelivery: true } };
      },
    };
  }
  throw Error(`Unknown delivery provider ${provider}`);
}

module.exports = { createDeliveryProvider, LOOPBACK_RECIPIENT };
