'use strict';
const crypto=require('node:crypto');
const PROVIDERS={tiktok:{token:'https://open.tiktokapis.com/v2/oauth/token/',me:'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name',required:['user.info.basic']},x:{token:'https://api.x.com/2/oauth2/token',me:'https://api.x.com/2/users/me?user.fields=id,name,username',required:['users.read','tweet.read','offline.access']}};
const scopes=s=>[...new Set(String(s||'').split(/[ ,]+/).filter(Boolean))].sort();
function createConnectionManager({db,env,fetchImpl=globalThis.fetch,clock=()=>new Date()}){
 if(db.databaseName!=='fmgrowthtest')throw Error('isolated_database_required');
 if(env.VERCEL&&(env.VERCEL_ENV!=='preview'||env.VERCEL_PROJECT_ID!==require('./growth-runtime-config').ISOLATED_PROJECT_ID)||env.GROWTH_OUTBOUND_ENABLED==='true'||env.GROWTH_SOCIAL_PROVIDER==='live')throw Error('isolated_preview_maintenance_required');
 const {encrypt,decrypt}=require('./growth-social-oauth-isolated');
 const key=Buffer.from(env.GROWTH_SOCIAL_TOKEN_KEY||'','base64');if(key.length!==32)throw Error('original_oauth_encryption_key_required');
 const accounts=db.collection('growth_social_accounts'),alerts=db.collection('preview198_growth_connection_alerts');
 const configs={tiktok:{id:env.GROWTH_TIKTOK_CLIENT_KEY,secret:env.GROWTH_TIKTOK_CLIENT_SECRET},x:{id:env.GROWTH_X_CLIENT_ID,secret:env.GROWTH_X_CLIENT_SECRET}};
 const remote=(url,opts={})=>fetchImpl(url,{...opts,redirect:'error',signal:AbortSignal.timeout(10000)});
 async function alert(p,reason){await alerts.updateOne({_id:p+':'+reason},{$set:{provider:p,reason,state:'open',lastSeenAt:clock()},$setOnInsert:{createdAt:clock(),action:reason==='refresh_token_expired'?'The access token may still work, but its refresh grant has expired. Review the provider expiry evidence and reauthorize before access expires; no token was revoked.':'Review Connections; reconnect only if provider renewal is unavailable. No credentials were regenerated.'}},{upsert:true});}
 function expiryFacts(a){
  const finite=v=>{const n=new Date(v).getTime();return v&&Number.isFinite(n)?n:null;};let tokens;
  try{tokens=decrypt(a.credentials,key);}catch{}
  const credentialReadable=Boolean(tokens);const access=finite(a.tokenExpiresAt),accessTtl=tokens?.expires_in,refreshTtl=tokens?.refresh_expires_in;
  const issued=access&&Number.isFinite(accessTtl)&&accessTtl>0?access-accessTtl*1000:null;
  const derived=issued&&Number.isFinite(refreshTtl)&&refreshTtl>0?issued+refreshTtl*1000:null;
  const stored=finite(a.refreshExpiresAt),refresh=derived||stored;
  return{credentialReadable,accessExpiresAt:access?new Date(access).toISOString():null,refreshExpiresAt:refresh?new Date(refresh).toISOString():null,refreshExpiryKnown:Boolean(refresh),refreshExpired:Boolean(refresh&&refresh<=+clock()),accessExpired:Boolean(access&&access<=+clock()),expiryEvidence:{source:derived?'encrypted_provider_response':stored?'stored_provider_metadata':'unknown',issuedAt:issued?new Date(issued).toISOString():null,accessLifetimeSeconds:Number.isFinite(accessTtl)?accessTtl:null,refreshLifetimeSeconds:Number.isFinite(refreshTtl)?refreshTtl:null,storedRefreshExpiresAt:stored?new Date(stored).toISOString():null,metadataMismatch:Boolean(derived&&stored&&Math.abs(derived-stored)>60000)},nextRefreshAt:access?new Date(Math.min(access,refresh||Infinity)-30*60000).toISOString():null};
 }
 function summary(a){
  if(!a?.confirmed||!a.identity||!a.credentials)return{provider:a?._id,status:a?.status==='disconnected'?'disconnected':'not_connected'};
  const life=expiryFacts(a),now=clock();let status=a.connectionHealth?.status;
  if(status==='expired'&&a.connectionHealth?.reason==='refresh_token_expired'&&!life.accessExpired)status='connected';
  if(!status||status==='connected')status=!life.accessExpiresAt?'refresh-needed':life.accessExpired?'expired':life.nextRefreshAt&&new Date(life.nextRefreshAt)<=now&&!life.refreshExpired?'refresh-needed':'connected';
  if(!life.credentialReadable)status='refresh-needed';
  const renewalStatus=!life.credentialReadable?'key-unavailable':a.pendingRefresh?'verification-pending':!a.refreshAvailable?'reauthorization-required':life.refreshExpired?'expired':(a.refreshAttempts||0)>=6?'review-required':!life.refreshExpiryKnown?'expiry-unknown':new Date(life.nextRefreshAt)<=now?'due':'available';
  const warnings=[life.refreshExpired&&!life.accessExpired&&!a.pendingRefresh?'refresh_grant_expired_access_still_valid':null,life.expiryEvidence.metadataMismatch?'refresh_expiry_metadata_differs_from_provider_response':null].filter(Boolean);
  return{provider:a.provider||a._id,identity:a.identity,username:a.username,displayName:a.displayName,status,accessStatus:!life.accessExpiresAt?'unknown':life.accessExpired?'expired':'valid',tokenExpiresAt:life.accessExpiresAt,refreshExpiresAt:life.refreshExpiresAt,refreshExpiryKnown:life.refreshExpiryKnown,refreshAvailable:a.refreshAvailable===true,renewalAvailable:life.credentialReadable&&a.refreshAvailable===true&&(Boolean(a.pendingRefresh)||!life.refreshExpired),renewalStatus,nextRefreshAt:life.nextRefreshAt,expiryEvidence:life.expiryEvidence,warnings,grantedScopes:a.grantedScopes||[],scopesVerifiedAt:a.scopesVerifiedAt||null,identityVerifiedAt:a.identityVerifiedAt||a.verifiedAt||null,nextRetryAt:a.nextRefreshAttemptAt||null,reason:!life.credentialReadable?'original_token_key_unavailable':a.connectionHealth?.reason||warnings[0]||null,publishingEnabled:false};
 }
 async function renew(p,{force=false}={}){
  if(!PROVIDERS[p])return{ok:false,status:400,error:'unsupported_provider'};
  const before=await accounts.findOne({_id:p});if(!before?.confirmed||before.status!=='connected'||!before.credentials)return{ok:false,status:409,error:'not_connected_or_refresh_in_progress'};
  const timing=expiryFacts(before);
  if(!before.pendingRefresh&&timing.refreshExpired){await alert(p,'refresh_token_expired');return{ok:false,status:409,error:'refresh_token_expired',connection:summary(before)};}
  if(!force&&!timing.accessExpiresAt){await alert(p,'access_expiry_unknown');return{ok:false,status:409,error:'access_expiry_unknown',connection:summary(before)};}
  if(!force&&timing.nextRefreshAt&&new Date(timing.nextRefreshAt)>clock()&&!before.pendingRefresh)return{ok:true,skipped:'not_due',connection:summary(before)};
  if(!force&&(before.refreshAttempts||0)>=6)return{ok:false,status:409,error:'renewal_retry_budget_exhausted_review_required'};
  if(!force&&before.nextRefreshAttemptAt>clock())return{ok:true,skipped:'retry_backoff',connection:summary(before)};
  const lock=crypto.randomUUID(),now=clock();
  const a=await accounts.findOneAndUpdate({_id:p,revision:before.revision,status:'connected',$or:[{refreshLockUntil:{$exists:false}},{refreshLockUntil:{$lte:now}}]},{$set:{refreshLock:lock,refreshLockUntil:new Date(+now+90000)}},{returnDocument:'after'});
  if(!a)return{ok:false,status:409,error:'not_connected_or_refresh_in_progress'};
  const fail=async(status,error,health='refresh-needed')=>{const attempts=(a.refreshAttempts||0)+1;await accounts.updateOne({_id:p,revision:a.revision,refreshLock:lock},{$set:{connectionHealth:{status:health,reason:error,at:clock()},refreshAttempts:attempts,nextRefreshAttemptAt:new Date(+clock()+Math.min(60,Math.pow(2,Math.min(attempts,6)))*60000)}});await alert(p,error);return{ok:false,status,error};};
  try{
   let previous;try{previous=decrypt(a.credentials,key);}catch{return await fail(409,'original_token_key_unavailable');}
   if(!previous.refresh_token)return await fail(409,'reauthorization_required');
   if(!a.pendingRefresh&&expiryFacts(a).refreshExpired)return await fail(409,'refresh_token_expired','expired');
   if(!configs[p].id||!configs[p].secret)return await fail(409,'existing_client_configuration_missing');
   let tokens,issuedAt;
   if(a.pendingRefresh){try{const pending=decrypt(a.pendingRefresh,key);tokens=pending.tokens;issuedAt=new Date(pending.issuedAt);}catch{return await fail(409,'pending_rotation_key_unavailable');}}
   else{
    const body=new URLSearchParams({grant_type:'refresh_token',refresh_token:previous.refresh_token,[p==='tiktok'?'client_key':'client_id']:configs[p].id});const headers={'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'};
    if(p==='x')headers.Authorization='Basic '+Buffer.from(encodeURIComponent(configs[p].id)+':'+encodeURIComponent(configs[p].secret)).toString('base64');else body.set('client_secret',configs[p].secret);
    let r;try{r=await remote(PROVIDERS[p].token,{method:'POST',headers,body:body.toString()});tokens=await r.json();}catch{return await fail(400,'refresh_or_identity_verification_failed');}
    if(!r.ok||tokens.error)return await fail(400,tokens.error==='invalid_grant'?'refresh_grant_rejected_reconnect_required':'refresh_or_identity_verification_failed',['access_denied','token_revoked','revoked_token'].includes(tokens.error)?'revoked':'refresh-needed');
    if(typeof tokens.access_token!=='string'||!/^[^\s]{8,4096}$/.test(tokens.access_token)||String(tokens.token_type).toLowerCase()!=='bearer'||!Number.isFinite(tokens.expires_in)||tokens.expires_in<=0||tokens.expires_in>2678400||tokens.refresh_token!==undefined&&(typeof tokens.refresh_token!=='string'||!/^[^\s]{8,4096}$/.test(tokens.refresh_token)))return await fail(400,'refresh_or_identity_verification_failed');
    tokens={...tokens,refresh_token:tokens.refresh_token||previous.refresh_token,scope:tokens.scope||previous.scope};issuedAt=clock();
    // Quarantine a returned rotation before network identity verification. This is
    // encrypted and never usable as the active connection until verified + CAS.
    await accounts.updateOne({_id:p,revision:a.revision,refreshLock:lock},{$set:{pendingRefresh:encrypt({tokens,issuedAt},key)}});
   }
   const granted=scopes(tokens.scope);if(PROVIDERS[p].required.some(s=>!granted.includes(s)))return await fail(403,'renewal_granted_scopes_insufficient','insufficient-permissions');
   let r,profile;try{r=await remote(PROVIDERS[p].me,{headers:{Authorization:'Bearer '+tokens.access_token,Accept:'application/json'}});if(!r.ok)return await fail(r.status===403?403:400,'refresh_or_identity_verification_failed',r.status===403?'insufficient-permissions':'refresh-needed');profile=await r.json();}catch{return await fail(400,'refresh_or_identity_verification_failed');}
   const identity=p==='tiktok'?profile.data?.user?.open_id:profile.data?.id;
   if(identity!==a.identity||p==='tiktok'&&(tokens.open_id!==identity||profile.error?.code&&profile.error.code!=='ok')||p==='x'&&String(profile.data?.username||'').toLowerCase()!=='fmmadness2024')return await fail(403,'refresh_identity_mismatch','refresh-needed');
   const set={credentials:encrypt(tokens,key),refreshAvailable:Boolean(tokens.refresh_token),tokenExpiresAt:new Date(+issuedAt+tokens.expires_in*1000),refreshedAt:clock(),identityVerifiedAt:clock(),scopesVerifiedAt:clock(),grantedScopes:granted,revision:crypto.randomUUID(),refreshAttempts:0,connectionHealth:{status:'connected',reason:null,at:clock()},publishingEnabled:false};
   if(Number.isFinite(tokens.refresh_expires_in)&&tokens.refresh_expires_in>0)set.refreshExpiresAt=new Date(+issuedAt+tokens.refresh_expires_in*1000);
   const result=await accounts.updateOne({_id:p,status:'connected',revision:a.revision,refreshLock:lock},{$set:set,$unset:{pendingRefresh:'',nextRefreshAttemptAt:''}});
   if(!result.modifiedCount)return{ok:false,status:409,error:'account_changed_during_refresh'};
   await alerts.updateMany({provider:p,state:'open'},{$set:{state:'resolved',resolvedAt:clock()}});
   return{ok:true,publishingEnabled:false,connection:summary({...a,...set})};
  }finally{await accounts.updateOne({_id:p,refreshLock:lock},{$unset:{refreshLock:'',refreshLockUntil:''}});}
 }
 async function identity(p){const a=await accounts.findOne({_id:p});if(!a?.credentials)return summary(a);if(a.identityVerifiedAt&&clock()-new Date(a.identityVerifiedAt)<15*60000)return summary(a);if(new Date(a.tokenExpiresAt)<=clock())return summary(a);
  let tokens;try{tokens=decrypt(a.credentials,key);}catch{return{...summary(a),status:'refresh-needed',reason:'original_token_key_unavailable'};}
  let r,j;try{r=await remote(PROVIDERS[p].me,{headers:{Authorization:'Bearer '+tokens.access_token,Accept:'application/json'}});j=await r.json();}catch{return{...summary(a),reason:'provider_identity_check_temporarily_unavailable'};}

  const id=p==='tiktok'?j.data?.user?.open_id:j.data?.id;
  const valid=r.ok&&id===a.identity&&(p!=='tiktok'||!j.error?.code||j.error.code==='ok')&&(p!=='x'||String(j.data?.username||'').toLowerCase()==='fmmadness2024');
  const granted=scopes(tokens.scope),status=valid?PROVIDERS[p].required.some(x=>!granted.includes(x))?'insufficient-permissions':new Date(a.tokenExpiresAt)-clock()<30*60000?'refresh-needed':'connected':r.status===403?'insufficient-permissions':r.status===401?'expired':'refresh-needed';
  const health=valid&&(a.pendingRefresh||a.refreshAttempts>0)&&a.connectionHealth?.status!=='connected'?a.connectionHealth:{status:!valid&&r.status===401&&a.connectionHealth?.status==='revoked'?'revoked':status,reason:valid?null:'provider_identity_verification_failed',at:clock()};
  await accounts.updateOne({_id:p,revision:a.revision},{$set:{identityVerifiedAt:valid?clock():a.identityVerifiedAt||null,grantedScopes:granted,connectionHealth:health}});return summary({...a,grantedScopes:granted,connectionHealth:health});
 }
 async function maintain({paused=false}={}){if(paused)return{paused:true,renewals:[],connections:(await accounts.find({confirmed:true}).toArray()).map(summary)};const renewals=[];for(const p of Object.keys(PROVIDERS))renewals.push({provider:p,...await renew(p)});const connections=[];for(const p of Object.keys(PROVIDERS)){const checked=await identity(p);connections.push(checked);if(checked.accessStatus==='valid'&&checked.renewalStatus==='available'&&checked.identityVerifiedAt&&clock()-new Date(checked.identityVerifiedAt)<15*60000)await alerts.updateMany({provider:p,reason:'refresh_token_expired',state:'open'},{$set:{state:'resolved',resolvedAt:clock(),resolution:'Verified current identity and non-expired provider-reported grant; no forced exchange.'}});}return{renewals,connections,publishingEnabled:false,outboundEnabled:false};}
 return{renew,identity,maintain,summary,expiryFacts};
}
module.exports={createConnectionManager,PROVIDERS};
