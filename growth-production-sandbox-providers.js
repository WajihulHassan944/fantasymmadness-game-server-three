'use strict';
// Isolated preview only. Records what WOULD be sent; never opens a network connection,
// never reads credentials. Every receipt is marked sandbox:true and delivered:false.
const crypto = require('node:crypto');
function assertPreview(environment) { if (environment !== 'preview') throw Error('sandbox_providers_are_preview_only'); }
function createSandboxEmail({ environment }) {
  assertPreview(environment);
  return {
    name: 'sandbox-email', realDelivery: false,
    readiness: async () => ({ provider: 'sandbox', sender: 'contact@fantasymmadnesscom.com', ready: true, sandbox: true, blockers: [] }),
    send: async (msg, { canSend = async () => true } = {}) => {
      if (!await canSend()) return { ok: false, reason: 'emergency_stop_or_campaign_changed' };
      return { ok: true, receipt: { provider: 'sandbox', providerMessageId: 'sandbox-' + crypto.randomUUID(), status: 'sandbox_recorded_not_sent', delivered: false, sandbox: true, recipient: msg.recipient, at: new Date().toISOString() } };
    },
  };
}
function createSandboxMeta({ environment }) {
  assertPreview(environment);
  const channels = { facebook: { ready: true, destinationId: 'sandbox-facebook-page', name: 'SANDBOX Facebook Page (nothing is posted)', blockers: [] }, instagram: { ready: true, destinationId: 'sandbox-instagram-account', name: 'SANDBOX Instagram account (nothing is posted)', blockers: [] } };
  return {
    readiness: async () => channels,
    publish: async (post, { canSend = async () => true } = {}) => {
      if (!channels[post.channel] || post.destinationId !== channels[post.channel].destinationId) return { ok: false, reason: 'sandbox_destination_mismatch' };
      if (!await canSend()) return { ok: false, reason: 'emergency_stop_or_campaign_changed' };
      return { ok: true, receipt: { provider: post.channel, providerPostId: 'sandbox-' + crypto.randomUUID(), status: 'sandbox_recorded_not_posted', sandbox: true, publicPermalink: null, publishedAt: new Date().toISOString() } };
    },
  };
}
module.exports = { createSandboxEmail, createSandboxMeta };
