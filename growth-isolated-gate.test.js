'use strict';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { isolatedGate } = require('./growth-isolated-gate');

test('isolated gate: only /api/growth reaches the app; legacy routes 404 first', async () => {
  const app = express(); let legacyHits = 0;
  app.use(isolatedGate);
  app.use((req, res, next) => { legacyHits++; next(); });
  app.get('/api/growth/health', (req, res) => res.json({ ok: true }));
  app.all('*', (req, res) => res.json({ legacy: true }));
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/growth/health`)).status, 200);
    for (const p of ['/', '/api/cron-job', '/api/signup', '/api/growthx', '/api/growth-admin', '/api/payments/webhook', '/api/GROWTH/health']) {
      const r = await fetch(`${base}${p}`, { method: p.includes('webhook') ? 'POST' : 'GET' });
      assert.equal(r.status, 404, p); assert.equal((await r.json()).service, 'growth-engine-isolated');
    }
    assert.equal(legacyHits, 1);
  } finally { srv.close(); }
});
