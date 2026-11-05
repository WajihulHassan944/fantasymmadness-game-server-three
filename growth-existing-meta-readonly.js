'use strict';
// Reuse existing isolated Meta authorization without migrating, renewing or mutating credentials.
const crypto = require('crypto');
const { createTokenVault } = require('./growth-token-vault');
const { resolveMetaConfig } = require('./growth-meta-connect');
const clean = (v, n=120) => String(v || '').replace(/[\x00-\x1f]/g,' ').slice(0,n);
const validId = v => /^\d{5,30}$/.test(String(v || ''));
function createExistingMetaReadOnly({ db, env, fetchImpl=globalThis.fetch, clock=()=>new Date() }) {
 if (db.databaseName !== 'fmgrowthtest') throw Error('Existing Meta lookup is restricted to fmgrowthtest');
 const original=db.collection('growth_connections'), local=db.collection('preview198_growth_connections'), cache=db.collection('preview198_meta_connection_health');
 const vault=createTokenVault(env.GROWTH_TOKEN_ENCRYPTION_KEY), cfg=resolveMetaConfig(env);let inFlight=null;
 const blocked=async()=>({ok:false,reason:'existing_meta_is_read_only_in_preview'});
 const graphUrl='https://graph.facebook.com/'+cfg.version;
 async function read(path,fields,token) {
  try {
   const u=new URL(graphUrl+'/'+path);u.searchParams.set('fields',fields);
   const r=await fetchImpl(u.toString(),{method:'GET',redirect:'error',headers:{Accept:'application/json',Authorization:'Bearer '+token},signal:AbortSignal.timeout(6000)});
   const j=await r.json();
   if(!r.ok||j?.error){const code=Number(j?.error?.code)||null;return{ok:false,reason:code===190?'existing_authorization_expired_or_revoked':[10,200].includes(code)?'existing_authorization_permissions_missing':[4,17,32,613].includes(code)||r.status===429?'provider_rate_limited':r.status>=500?'provider_temporarily_unavailable':'provider_rejected_existing_authorization',providerCode:code};}
   return{ok:true,data:j};
  }catch{return{ok:false,reason:'provider_verification_unavailable',providerCode:null};}
 }
 async function status({force=false}={}) {
  if(inFlight)return inFlight;
  inFlight=(async()=>{
   // A deliberately disconnected local record is never resurrected by the fallback.
   const scoped=await local.findOne({key:'meta'}), prior=await original.findOne({key:'meta'});
   const doc=scoped?.selected || scoped?.disconnectedAt ? scoped : prior || scoped;const source=doc===scoped&&scoped?'existing_preview_record':prior?'existing_isolated_record':'existing_environment';
   const stamp=crypto.createHash('sha256').update(JSON.stringify({doc,fb:env.GROWTH_FB_PAGE_ID||env.FACEBOOK_PAGE_ID,ig:env.GROWTH_IG_USER_ID||env.INSTAGRAM_BUSINESS_ACCOUNT_ID,keyId:vault.keyId})).digest('hex');
   const cached=await cache.findOne({_id:'meta-existing'});
   if(!force&&cached?.stamp===stamp&&clock().getTime()-Date.parse(cached.checkedAt)<300000)return cached.status;
   let pageId=doc?.selected?.pageId,igId=doc?.selected?.igUserId, pageToken=null,igToken=null,tokenProblem=null;
   if(doc?.disconnectedAt && !doc?.selected)tokenProblem='existing_connection_was_disconnected';
   else if(doc?.selected){const page=(doc.pages||[]).find(p=>p.id===pageId);if(!vault.configured)tokenProblem='original_encryption_key_unavailable';else if(!page?.tokenSealed)tokenProblem='existing_selected_page_token_missing';else{try{pageToken=vault.open(page.tokenSealed,'meta:page:'+pageId);igToken=pageToken;}catch{tokenProblem='original_encryption_key_mismatch_or_corrupt_record';}}}
   else {
    pageId=env.GROWTH_FB_PAGE_ID||env.FACEBOOK_PAGE_ID;
    pageToken=env.GROWTH_FB_PAGE_ACCESS_TOKEN||env.FACEBOOK_PAGE_ACCESS_TOKEN||env.META_PAGE_ACCESS_TOKEN;
    igId=env.GROWTH_IG_USER_ID||env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
    igToken=env.GROWTH_IG_ACCESS_TOKEN||env.INSTAGRAM_ACCESS_TOKEN||pageToken;
    tokenProblem=doc&&!pageToken&&!igToken?'existing_page_selection_missing':null;
   }
   const fb={verified:false,state:'not_verified',reason:tokenProblem||(!validId(pageId)?'existing_facebook_page_id_missing':!pageToken?'existing_facebook_authorization_missing':null)};
   const ig={verified:false,state:'not_verified',reason:tokenProblem||(!validId(igId)?'existing_instagram_account_id_missing':!igToken?'existing_instagram_authorization_missing':null)};
   if(cfg.expected.pageId&&pageId!==cfg.expected.pageId)fb.reason='existing_facebook_identity_does_not_match_pin';
   await Promise.all([
    (async()=>{if(fb.reason)return;const r=await read('me','id,name',pageToken);if(!r.ok){Object.assign(fb,r);delete fb.ok;return;}if(String(r.data?.id)!==String(pageId)){fb.reason='facebook_provider_identity_mismatch';return;}Object.assign(fb,{verified:true,state:'connected',reason:null,id:String(pageId),name:clean(r.data.name)});})(),
    (async()=>{if(ig.reason)return;const r=await read(igId,'id,username',igToken);if(!r.ok){Object.assign(ig,r);delete ig.ok;return;}if(String(r.data?.id)!==String(igId)){ig.reason='instagram_provider_identity_mismatch';return;}if(cfg.expected.igUsername&&String(r.data.username||'').toLowerCase()!==cfg.expected.igUsername){ig.reason='instagram_provider_username_does_not_match_pin';return;}Object.assign(ig,{verified:true,state:'connected',reason:null,id:String(igId),username:clean(r.data.username,60)});})()
   ]);
   if(ig.verified&&fb.reason==='facebook_provider_identity_mismatch'&&igToken===pageToken){ig.verified=false;ig.state='not_verified';ig.reason='existing_page_token_identity_mismatch';}
   if(ig.verified&&validId(pageId)&&pageToken){const linked=await read(pageId,'instagram_business_account{id}',pageToken);if(!linked.ok){ig.verified=false;ig.state='not_verified';ig.reason='instagram_page_link_verification_unavailable';}else if(String(linked.data?.instagram_business_account?.id)!==String(igId)){ig.verified=false;ig.state='not_verified';ig.reason='instagram_page_link_changed';}}
   const ok=fb.verified&&ig.verified;
   const problems=[!fb.verified&&'Facebook: '+fb.reason,!ig.verified&&'Instagram: '+ig.reason].filter(Boolean);
   const out={readOnlyExisting:true,state:ok?'connected':fb.verified||ig.verified?'partially_connected':'verification_required',connectionLabel:ok?'Existing Facebook & Instagram verified':fb.verified||ig.verified?'Existing connection partially verified':'Existing connection investigation',source,existingRecordFound:Boolean(doc),encryptionConfigured:vault.configured,appId:doc?.app?.appId||env.GROWTH_META_APP_ID||null,setup:[{done:vault.configured,text:'Original encryption key binding available'},{done:Boolean(doc?.app?.appSecretSealed||env.GROWTH_META_APP_SECRET),text:'Existing Meta application configuration found'}],selected:doc?.selected?{pageId:clean(doc.selected.pageId,40),pageName:clean(doc.selected.pageName),igUserId:clean(doc.selected.igUserId,40),igUsername:clean(doc.selected.igUsername,60)}:null,platforms:{facebook:fb,instagram:ig},health:{checkedAt:clock().toISOString(),ok,problems,warnings:[]},redirectUri:cfg.redirectUri,publishingEnabled:false};
   await cache.updateOne({_id:'meta-existing'},{$set:{stamp,checkedAt:out.health.checkedAt,status:out}},{upsert:true});return out;
  })();try{return await inFlight;}finally{inFlight=null;}
 }
 async function summary(){const s=await status();return{existingRecordFound:s.existingRecordFound,source:s.source,encryptionConfigured:s.encryptionConfigured,checkedAt:s.health.checkedAt,facebook:{verified:s.platforms.facebook.verified,state:s.platforms.facebook.state,reason:s.platforms.facebook.reason},instagram:{verified:s.platforms.instagram.verified,state:s.platforms.instagram.state,reason:s.platforms.instagram.reason},credentialsChanged:false,publishingEnabled:false};}
 return{init:async()=>{},status,summary,healthCheck:async options=>{const s=await status(options);return{...s.health,readOnly:true};},setApp:blocked,startAuthorization:blocked,handleCallback:blocked,selectPage:blocked,disconnect:blocked,credentials:async()=>null,graphUrl,liveTestApproved:false};
}
module.exports={createExistingMetaReadOnly};
