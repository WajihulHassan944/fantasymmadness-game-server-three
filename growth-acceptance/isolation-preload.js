'use strict';
// Growth acceptance harness (test-only; never loaded in production).
// Loaded with `node -r` for the backend under test. Refuses to start unless the
// database is local, and blocks every outbound connection except loopback, so
// the server cannot reach production data, payment gateways or mail providers.
const fs = require('fs');
const net = require('net');
const path = require('path');
if (process.env.GROWTH_ACCEPTANCE_ISOLATED !== '1') throw new Error('Refusing to start: GROWTH_ACCEPTANCE_ISOLATED=1 required.');
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(String(process.env.MONGODB_URI || ''))) throw new Error('Refusing to start: local database required.');
for (const name of ['RESEND_API_KEY', 'SENDGRID_API_KEY', 'BREVO_API_KEY', 'POSTMARK_SERVER_TOKEN', 'AUTHORIZE_NET_API_LOGIN_ID', 'AUTHORIZE_NET_TRANSACTION_KEY', 'CLOUDINARY_API_SECRET', 'STRIPE_SECRET_KEY']) {
  if (process.env[name]) throw new Error(`Refusing to start: ${name} must not be set.`);
}
const log = path.join(process.env.GROWTH_ACCEPTANCE_OUT || '/tmp', 'blocked-outbound.log');
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '']);
const hostOf = (args) => {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === 'object') return first.path ? 'unix' : String(first.host || first.hostname || 'localhost');
  if (typeof first === 'number' || /^\d+$/.test(String(first))) return typeof args[1] === 'string' ? args[1] : 'localhost';
  return typeof first === 'string' ? 'unix' : 'localhost';
};
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function isolatedConnect(...args) {
  const host = hostOf(args).replace(/^\[|\]$/g, '').toLowerCase();
  if (host !== 'unix' && !LOOPBACK.has(host)) {
    fs.appendFileSync(log, `${new Date().toISOString()} ${host}\n`);
    const error = Object.assign(new Error(`Isolated acceptance: outbound connection to ${host} blocked.`), { code: 'ECONNREFUSED' });
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return original.apply(this, args);
};
console.log('[acceptance] backend isolation active: loopback-only network');
