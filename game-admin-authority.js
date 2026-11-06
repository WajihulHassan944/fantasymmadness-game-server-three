'use strict';
const jwt=require('jsonwebtoken');
// Website administration credentials are not interchangeable with Growth tokens,
// even if a legacy installation accidentally shares a signing secret.
function isGrowthAuthority(claims){return Boolean(claims&&typeof claims==='object'&&(/^growth(?:[_:-]|$)/i.test(String(claims.scope||''))||/growth/i.test(String(claims.iss||''))||/growth/i.test(JSON.stringify(claims.aud||''))));}
function verifyGameAdministrator(token,secret){
 const claims=jwt.verify(token,secret,{algorithms:['HS256']});
 if(!claims||typeof claims!=='object'||Array.isArray(claims)||claims.scope!==undefined&&claims.scope!=='admin'||isGrowthAuthority(claims))throw Error('game_administrator_authority_required');
 if(!/^[a-f\d]{24}$/i.test(String(claims.id||''))||typeof claims.email!=='string'||!claims.email.includes('@'))throw Error('game_administrator_identity_required');
 return claims;
}
module.exports={verifyGameAdministrator,isGrowthAuthority};
