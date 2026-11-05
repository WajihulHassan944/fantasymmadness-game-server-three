'use strict';
// Dedicated production-preparation HTTP surface; never mounts the game server.
const express=require('express'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {resolveProductionPreparationConfig}=require('./growth-production-preparation-config');
const {createAdminSso}=require('./growth-admin-sso');
const {signProductionSession,verifyProductionSession}=require('./growth-production-session');
function createProductionPreparationApp({env=process.env,context,startScheduled}={}){
 const app=express();app.disable('x-powered-by');app.use(express.json({limit:'16kb'}));const resolved=resolveProductionPreparationConfig(env);
 app.use((req,res,next)=>{res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});const origin=req.headers.origin;if(resolved.config.sso.siteOrigins.includes(origin))res.set({'Access-Control-Allow-Origin':origin,Vary:'Origin','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Methods':'GET, POST, OPTIONS'});if(req.method==='OPTIONS')return res.status(resolved.config.sso.siteOrigins.includes(origin)?204:403).end();next();});
 const ready=async()=>{if(!resolved.ok)throw Error('production_preparation_not_configured');return context();};
 const health=async(_req,res)=>{if(!resolved.ok)return res.status(503).json({ok:false,environment:'production',preparationActive:false,blockers:resolved.errors,publishingEnabled:false,outboundEnabled:false});try{const c=await ready();res.json({ok:true,service:'growth-production-preparation',...await c.status()});}catch{res.status(503).json({ok:false,environment:'production',preparationActive:false,reason:'production_preparation_unavailable',publishingEnabled:false,outboundEnabled:false});}};
 app.get('/health',health);app.get('/api/growth/health',health);
 const assets={'index.html':'text/html; charset=utf-8','app.js':'application/javascript; charset=utf-8','app.css':'text/css; charset=utf-8'};for(const [file,type] of Object.entries(assets))app.get('/api/growth/console'+(file==='index.html'?'':'/'+file),(_req,res)=>{try{res.set({'Content-Type':type,'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors https://fantasymmadness.com https://www.fantasymmadness.com",'Referrer-Policy':'no-referrer'}).send(fs.readFileSync(path.join(process.cwd(),'growth-production-console',file)));}catch{res.status(503).json({ok:false,reason:'preparation_console_unavailable'});}});
 let ssoPromise;const sso=()=>ssoPromise||=(async()=>{const c=await ready();return createAdminSso({config:resolved.config.sso,collections:c.sessionCollections,signSession:claims=>signProductionSession(resolved.secrets.adminJwtSecret,claims)});})().catch(e=>{ssoPromise=null;throw e;});
 const safe=fn=>async(req,res)=>{try{await fn(req,res);}catch{res.status(503).json({ok:false,reason:'production_preparation_unavailable'});}};
 app.post('/api/growth/admin/sso/assertion',safe(async(req,res)=>{const r=await(await sso()).exchange(req.body?.assertion,{ip:req.ip});res.status(r.status||200).json(r);}));
 app.post('/api/growth/admin/sso/revoke',safe(async(req,res)=>{const r=await(await sso()).revokeAdmin(req.body?.assertion,{ip:req.ip});res.status(r.status||200).json(r);}));
 const auth=async(req,res,next)=>{try{const c=verifyProductionSession(resolved.secrets.adminJwtSecret,String(req.headers.authorization||'').replace(/^Bearer\s+/i,''));if(c.method!=='website_admin'||!c.adminId||!resolved.config.autonomy.owners.includes(c.adminId))throw Error('owner_required');if(await(await sso()).revokedReason(c))throw Error('revoked');req.owner=c;next();}catch{res.status(401).json({ok:false,reason:'verified_production_owner_required'});}};
 app.get('/api/growth/admin/session',auth,(req,res)=>res.json({ok:true,method:'website_admin',exp:req.owner.exp,environment:'production'}));
 app.post('/api/growth/admin/logout',auth,safe(async(req,res)=>res.json({ok:true,...await(await sso()).revokeSession(req.owner,{reason:'owner_logout'})})));
 const activate=async()=>{if(!/^dpl_[A-Za-z0-9]+$/.test(env.VERCEL_DEPLOYMENT_ID||'')||!startScheduled)throw Error('verified_production_deployment_required');const c=await ready();await c.activate({deploymentId:env.VERCEL_DEPLOYMENT_ID,confirmation:'ACTIVATE PRODUCTION PREPARATION ONLY'});const state=await c.status();await startScheduled(state.scheduler.generation);return state;};
 app.post('/api/growth/internal/preparation/activate',safe(async(req,res)=>{const x=Buffer.from(String(req.headers.authorization||'')),y=Buffer.from('Bearer '+String(resolved.secrets.cronSecret||''));if(!resolved.ok||!resolved.secrets.cronSecret||x.length!==y.length||!crypto.timingSafeEqual(x,y))return res.status(401).json({ok:false});if(req.body?.confirmation!=='ACTIVATE PRODUCTION PREPARATION ONLY'||req.body?.deploymentId!==env.VERCEL_DEPLOYMENT_ID)return res.status(409).json({ok:false,reason:'explicit_verified_deployment_activation_required'});res.json({ok:true,...await activate()});}));
 app.post('/api/growth/admin/autonomy/stop',auth,safe(async(_req,res)=>{await(await ready()).stop();res.json({ok:true,...await(await ready()).status()});}));
 app.post('/api/growth/admin/autonomy/resume',auth,safe(async(req,res)=>{if(req.body?.confirmation!=='ACTIVATE PRODUCTION PREPARATION ONLY')return res.status(409).json({ok:false,reason:'explicit_production_preparation_confirmation_required'});res.json({ok:true,...await activate()});}));
 app.get('/api/growth/admin/:section',auth,safe(async(req,res)=>res.json(await(await ready()).read(req.params.section,req.query))));
 // No cron tick, campaign approval, OAuth exchange, affiliate mapping mutation,
 // registration, test journey, publishing, payment or outbound-delivery routes.
 app.use((_req,res)=>res.status(404).json({ok:false,reason:'disabled_in_production_preparation'}));
 return app;
}
module.exports={createProductionPreparationApp};
