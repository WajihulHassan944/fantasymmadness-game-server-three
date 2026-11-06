'use strict';

// Connection health is evidence, never permission to publish.
function productionChannelStatus(connections = {}) {
  const stale = connections.verificationStale !== false;
  return Object.fromEntries(['facebook', 'instagram', 'tiktok', 'x'].map(provider => {
    const oauth = (connections.oauth || []).find(account => account.provider === provider);
    const meta = connections.meta?.[provider];
    const connected = !stale && (meta ? meta.verified === true : oauth?.status === 'connected' && oauth?.accessStatus === 'valid');
    return [provider, {
      mode: 'off', ready: false, connected,
      connectionStatus: stale ? 'verification-needed' : connected ? 'connected' : oauth?.status || meta?.state || 'unverified',
      checkedAt: connections.checkedAt || null,
      publishingAuthorized: false,
      blockers: ['Production publishing is disabled; campaign approval and a verified delivery release are required.'],
      note: connected ? 'Connection verified. Publishing is disabled.' : 'Connection needs verification. Publishing is disabled.',
    }];
  }));
}

module.exports = { productionChannelStatus };
