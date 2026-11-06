'use strict';
const crypto=require('node:crypto'),jwt=require('jsonwebtoken');
const audience='fmm-growth-production-preparation';
const key=secret=>{if(String(secret||'').length<32)throw Error('production_admin_signing_secret_required');return crypto.createHmac('sha256',secret).update('fmm-growth-production-preparation/session/v1').digest();};
function signProductionSession(secret,{email,adminId,sid,iatMs,ttl}){return jwt.sign({email,adminId,sid,iatMs,role:'growth_owner',method:'website_admin',scope:'preparation_only'},key(secret),{algorithm:'HS256',audience,issuer:'fmm-growth-engine',expiresIn:ttl});}
function verifyProductionSession(secret,token){const c=jwt.verify(String(token||''),key(secret),{algorithms:['HS256'],audience,issuer:'fmm-growth-engine'});if(c.role!=='growth_owner'||c.method!=='website_admin'||c.scope!=='preparation_only'||!c.sid||!c.adminId)throw Error('production_owner_session_required');return c;}
module.exports={signProductionSession,verifyProductionSession};
