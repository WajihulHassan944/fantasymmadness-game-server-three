'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { registerSwarmPhase2Routes, _private } = require('./swarm-phase2');

assert.strictEqual(typeof registerSwarmPhase2Routes, 'function');
assert.strictEqual(_private.normalizeVertical('wrestling'), 'pro_wrestling');
assert.strictEqual(_private.normalizeVertical('mma'), 'combat');

const body = JSON.stringify({ ok: true });
const signature = _private.signRequest({
  crypto,
  method: 'POST',
  pathWithQuery: '/api/internal/swarm/webhooks/job-completed',
  timestamp: '2026-01-01T00:00:00.000Z',
  nonce: 'nonce-1',
  body,
  secret: 'secret-1',
});
assert.strictEqual(signature.length, 64);
assert.strictEqual(_private.sha256Hex(crypto, body).length, 64);

const mappedBlog = _private.mapArtifactToBlog({
  metaTitle: 'Generated Fight Preview',
  metaDescription: 'Preview description',
  header: 'Fight Preview',
  sections: [{ title: 'Main card', content: 'Card content' }],
}, { title: 'Fallback title', summary: 'Fallback summary' });
assert.strictEqual(mappedBlog.metaTitle, 'Generated Fight Preview');
assert.strictEqual(mappedBlog.sections.length, 1);

const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
assert(serverSource.includes("require('./swarm-phase2')"), 'server.js must load the swarm gateway module.');
assert(serverSource.includes('req.rawBody = buf ? buf.toString'), 'server.js must preserve raw JSON body for webhook HMAC validation.');
assert(serverSource.includes('registerSwarmPhase2Routes({'), 'server.js must register swarm phase 2 routes.');

const gatewaySource = fs.readFileSync(path.join(__dirname, 'swarm-phase2.js'), 'utf8');
for (const route of [
  '/api/admin/swarm/config',
  '/api/admin/swarm/health',
  '/api/admin/swarm/jobs',
  '/api/admin/swarm/artifacts',
  '/api/internal/swarm/webhooks/job-completed',
  '/api/internal/swarm/webhooks/job-failed',
]) {
  assert(gatewaySource.includes(route), `Missing swarm route: ${route}`);
}

console.log('Phase 2 swarm backend integration tests passed.');
