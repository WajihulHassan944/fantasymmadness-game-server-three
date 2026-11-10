'use strict';

// Connection health is evidence, never permission to publish.
function productionChannelStatus(connections = {}) {
  const stale = connections.verificationStale !== false;
  // Facebook/Instagram have their own live provider check (growth-production-meta-verification.js)
  const metaStale = typeof connections.metaVerificationStale === 'boolean' ? connections.metaVerificationStale : stale;
  return Object.fromEntries(['facebook', 'instagram', 'tiktok', 'x'].map(provider => {
    const oauth = (connections.oauth || []).find(account => account.provider === provider);
    const meta = connections.meta?.[provider];
    const providerStale = meta ? metaStale : stale;
    const connected = !providerStale && (meta ? meta.verified === true : oauth?.status === 'connected' && oauth?.accessStatus === 'valid');
    const required = { facebook: ['pages_manage_posts'], instagram: ['instagram_content_publish'], tiktok: ['video.publish'], x: ['tweet.write'] }[provider];
    const granted = meta ? connections.metaPermissions?.granted || [] : oauth?.grantedScopes || [];
    const permissionEvidenceVerified = meta ? connections.metaPermissions?.verified === true : Boolean(oauth?.scopesVerifiedAt);
    const missingPublishingScopes = required.filter(scope => !granted.includes(scope));
    const publishingScopesVerified = connected && permissionEvidenceVerified && !missingPublishingScopes.length;
    return [provider, {
      mode: 'off', ready: false, connected,
      connectionStatus: providerStale ? 'verification-needed' : connected ? 'connected' : oauth?.status || meta?.state || 'unverified',
      checkedAt: (meta ? connections.metaCheckedAt : null) || connections.checkedAt || null,
      publishingAuthorized: false,
      username: oauth?.username || null, identity: oauth?.identity || null,
      grantedScopes: granted, missingPublishingScopes, publishingScopesVerified,
      blockers: ['Production publishing is disabled; campaign approval and a verified delivery release are required.'],
      note: connected ? 'Connection verified' + (oauth?.username ? ' as @' + oauth.username : '') + '. ' + (publishingScopesVerified ? 'Publishing scope evidence verified. ' : permissionEvidenceVerified ? 'Missing publishing scope: ' + missingPublishingScopes.join(', ') + '. ' : 'Publishing permissions not verified. ') + 'Publishing is disabled.' : 'Connection needs verification. Publishing is disabled.',
    }];
  }));
}

module.exports = { productionChannelStatus };
