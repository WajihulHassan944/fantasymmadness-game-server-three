'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { productionChannelStatus } = require('./growth-production-channel-status');

test('verified connections remain distinct from publishing authorization', () => {
  const source = { verificationStale: false, checkedAt: '2026-11-06T20:00:00Z', meta: { facebook: { verified: true }, instagram: { verified: true } }, oauth: [{ provider: 'tiktok', status: 'connected', accessStatus: 'valid' }, { provider: 'x', status: 'connected', accessStatus: 'valid' }] };
  const before = JSON.stringify(source);
  const result = productionChannelStatus(source);
  assert.equal(Object.keys(result).length, 4);
  for (const channel of Object.values(result)) {
    assert.equal(channel.connected, true);
    assert.equal(channel.connectionStatus, 'connected');
    assert.equal(channel.publishingAuthorized, false);
    assert.equal(channel.mode, 'off');
    assert.equal(channel.ready, false);
  }
  assert.equal(JSON.stringify(source), before);
});

test('stale, missing and expired credentials never appear connected or ready', () => {
  for (const source of [{}, { meta: { facebook: { verified: true } } }, { verificationStale: true, oauth: [{ provider: 'x', status: 'connected', accessStatus: 'valid' }] }, { verificationStale: false, oauth: [{ provider: 'x', status: 'connected', accessStatus: 'expired' }] }]) {
    for (const channel of Object.values(productionChannelStatus(source))) {
      assert.equal(channel.connected, false);
      assert.equal(channel.ready, false);
      assert.equal(channel.publishingAuthorized, false);
    }
  }
});
