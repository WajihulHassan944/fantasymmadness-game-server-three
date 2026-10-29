'use strict';
// Explicit staging-only preflight. Never print, compare, or export credential values.
// Require a separate, operator-attested test database and sandbox mail provider.
// Presence of preview deployment alone is not proof of isolation.
function stagingPreflight(env={}){
 const failures=[];
 if(env.GROWTH_STAGING_MODE!=='isolated')failures.push('isolated_mode_required');
 if(env.GROWTH_STAGING_DB_ATTESTED!=='true')failures.push('dedicated_database_attestation_required');
 if(env.GROWTH_STAGING_MAIL_SANDBOX_ATTESTED!=='true')failures.push('sandbox_mail_attestation_required');
 if(env.GROWTH_OUTBOUND_ENABLED==='true')failures.push('outbound_must_remain_disabled');
 if(env.GROWTH_PRODUCTION_APPROVED==='true')failures.push('production_approval_not_valid_for_staging');
 return {ready:failures.length===0,failures,mode:'STAGING_ONLY',realDeliveryPermitted:false};
}
module.exports={stagingPreflight};
