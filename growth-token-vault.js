'use strict';
// Encrypts connection credentials (Meta tokens, app secret) before they are stored in
// the isolated fmgrowthtest database. AES-256-GCM with a 32-byte key from
// GROWTH_TOKEN_ENCRYPTION_KEY (base64). The record label is bound as associated data, so
// a sealed value cannot be moved to another field or record. Plain values are never
// logged or returned by any API.
const crypto = require('crypto');

function parseKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let buf = null;
  try { buf = Buffer.from(s, 'base64'); } catch { buf = null; }
  return buf && buf.length === 32 ? buf : null;
}

function createTokenVault(rawKey) {
  const key = parseKey(rawKey);
  const keyId = key ? crypto.createHash('sha256').update(key).digest('hex').slice(0, 12) : null;
  const need = () => { if (!key) throw new Error('GROWTH_TOKEN_ENCRYPTION_KEY is not configured (32 bytes, base64)'); };
  function seal(plain, label) {
    need();
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(Buffer.from(String(label)));
    const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return ['v1', keyId, iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }
  function open(sealed, label) {
    need();
    const [v, kid, iv, tag, ct] = String(sealed || '').split('.');
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('sealed value is malformed');
    if (kid !== keyId) throw new Error('sealed with a different encryption key (reconnect required)');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(String(label)));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  }
  return { configured: Boolean(key), keyId, seal, open };
}

module.exports = { createTokenVault };
