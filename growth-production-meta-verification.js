'use strict';
// Facebook & Instagram verification for the production Connections view.
//
// Root cause this fixes: the production Connections page took the Meta status from the isolated
// managed worker's "connection-maintenance" snapshot (TikTok/X OAuth maintenance). When that
// snapshot is older than 35 minutes, EVERY provider, including Facebook and Instagram, was shown
// as connection_verification_stale, even though the production distribution worker verifies the
// same Meta connection live (identity + granted publishing permissions) on every readiness check.
//
// Facebook/Instagram status now comes from that same live, read-only provider check (no token
// renewal, no credential change, no publishing). TikTok/X keep their own maintenance freshness rule.
const REQUIRED = { facebook: 'pages_manage_posts', instagram: 'instagram_content_publish' };
const FRESH_MS = 35 * 60000;

// verification: result of meta provider verify(); connections: snapshot from the maintenance record.
function applyMetaVerification(connections = {}, verification, now = Date.now()) {
  const out = { ...connections };
  const checked = Date.parse(verification?.checkedAt || '');
  const fresh = Number.isFinite(checked) && now - checked <= FRESH_MS && checked <= now + 60000;
  if (!verification || !fresh) {
    out.metaVerificationStale = true;
    out.metaCheckedAt = verification?.checkedAt || null;
    return out;
  }
  const platform = (name) => {
    const p = verification[name] || {};
    const scope = REQUIRED[name];
    const scopeOk = verification.permissions?.verified === true && (verification.permissions.granted || []).includes(scope);
    return {
      verified: p.verified === true,
      state: p.verified === true ? 'connected' : p.state || 'not_verified',
      reason: p.verified === true ? null : p.reason || 'identity_not_verified',
      id: p.verified === true ? p.id || null : null,
      ...(name === 'facebook' ? { name: p.verified === true ? p.name || null : null } : { username: p.verified === true ? p.username || null : null }),
      publishingScope: scope,
      publishingScopeGranted: scopeOk,
    };
  };
  const facebook = platform('facebook');
  const instagram = platform('instagram');
  out.meta = { ...(connections.meta || {}), facebook: { verified: facebook.verified, state: facebook.state, reason: facebook.reason }, instagram: { verified: instagram.verified, state: instagram.state, reason: instagram.reason } };
  out.metaIdentity = { selected: verification.selected || null, platforms: { facebook, instagram }, checkedAt: verification.checkedAt };
  out.accountIdentities = { ...(connections.accountIdentities || {}), facebook: { name: facebook.name, verified: facebook.verified }, instagram: { username: instagram.username, verified: instagram.verified } };
  out.metaPermissions = verification.permissions?.verified === true
    ? { verified: true, granted: (verification.permissions.granted || []).filter((s) => typeof s === 'string'), checkedAt: verification.permissions.checkedAt || verification.checkedAt }
    : { verified: false, reason: verification.permissions?.reason || 'permission_evidence_unavailable' };
  out.metaVerificationStale = false;
  out.metaCheckedAt = verification.checkedAt;
  out.metaSource = 'production_provider_live_check';
  return out;
}

module.exports = { applyMetaVerification, REQUIRED_META_SCOPES: REQUIRED };
