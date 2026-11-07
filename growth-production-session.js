'use strict';
const crypto=require('node:crypto'),jwt=require('jsonwebtoken');
const audience='fmm-growth-production-preparation';
const key=(secret,sessionAudience=audience)=>{if(String(secret||'').length<32)throw Error('production_admin_signing_secret_required');return crypto.createHmac('sha256',secret).update(sessionAudience+'/session/v1').digest();};
function signProductionSession(secret,{email,adminId,sid,iatMs,ttl},sessionAudience=audience){return jwt.sign({email,adminId,sid,iatMs,role:'growth_owner',method:'website_admin',scope:'preparation_only'},key(secret,sessionAudience),{algorithm:'HS256',audience:sessionAudience,issuer:'fmm-growth-engine',expiresIn:ttl});}
function verifyProductionSession(secret,token,sessionAudience=audience){const c=jwt.verify(String(token||''),key(secret,sessionAudience),{algorithms:['HS256'],audience:sessionAudience,issuer:'fmm-growth-engine'});if(c.role!=='growth_owner'||c.method!=='website_admin'||c.scope!=='preparation_only'||!c.sid||!c.adminId)throw Error('production_owner_session_required');return c;}
module.exports={signProductionSession,verifyProductionSession};
