'use strict';
// Opt-out (suppression) list and signed one-click unsubscribe tokens.
// Every delivery checks the list first; an opt-out is permanent until an
// operator deliberately removes it. Addresses are stored lowercase.
const crypto = require('crypto');

function createSuppression(collection, { secret, testMode = false } = {}) {
  if (testMode !== true || !collection || typeof collection.updateOne !== 'function') throw Error('Isolated suppression collection required');
  const key = String(secret || '');
  const norm = (address) => String(address || '').trim().toLowerCase();
  const sign = (address) => crypto.createHmac('sha256', key).update(norm(address)).digest('base64url');
  return {
    init: () => collection.createIndex({ address: 1 }, { unique: true }),
    token(address) {
      if (key.length < 16) throw Error('Unsubscribe secret not configured');
      return `${Buffer.from(norm(address)).toString('base64url')}.${sign(address)}`;
    },
    link(baseUrl, address) { return `${String(baseUrl).replace(/\/$/, '')}?token=${encodeURIComponent(this.token(address))}`; },
    async unsubscribe(token, { source = 'link', now = new Date() } = {}) {
      const [encoded, signature] = String(token || '').split('.');
      if (!encoded || !signature || key.length < 16) return { ok: false, reason: 'invalid_token' };
      const address = norm(Buffer.from(encoded, 'base64url').toString('utf8'));
      const expected = sign(address);
      if (expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return { ok: false, reason: 'invalid_token' };
      await collection.updateOne({ address }, { $setOnInsert: { address, source, createdAt: now.toISOString() } }, { upsert: true });
      return { ok: true };
    },
    async suppress(address, { source = 'operator', reason = '', now = new Date() } = {}) {
      await collection.updateOne({ address: norm(address) }, { $setOnInsert: { address: norm(address), source, reason: String(reason).slice(0, 200), createdAt: now.toISOString() } }, { upsert: true });
    },
    async isSuppressed(address) { return Boolean(await collection.findOne({ address: norm(address) })); },
  };
}

module.exports = { createSuppression };
