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

test('read-only OAuth grants never imply publishing permission, and verified grants still require production release', () => {
  const connection={verificationStale:false,oauth:[{provider:'x',username:'FMmadness2024',status:'connected',accessStatus:'valid',grantedScopes:['tweet.read','users.read'],scopesVerifiedAt:'2026-11-06T20:00:00Z'}]};
  let channel=productionChannelStatus(connection).x;
  assert.equal(channel.connected,true);assert.equal(channel.username,'FMmadness2024');assert.deepEqual(channel.missingPublishingScopes,['tweet.write']);assert.equal(channel.publishingScopesVerified,false);
  connection.oauth[0].grantedScopes.push('tweet.write');channel=productionChannelStatus(connection).x;
  assert.equal(channel.publishingScopesVerified,true);assert.equal(channel.publishingAuthorized,false);assert.equal(channel.ready,false);assert.equal(channel.mode,'off');
});
