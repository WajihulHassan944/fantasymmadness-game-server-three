'use strict';
// App-owned OAuth only. A ChatGPT Gmail connection is not an app credential.
const SENDER = 'contact@fantasymmadnesscom.com';
const SEND = 'https://www.googleapis.com/auth/gmail.send';
const META = 'https://www.googleapis.com/auth/gmail.metadata';
function createGmailProvider({clientId, clientSecret, refreshToken, fetchImpl=globalThis.fetch, clock=()=>Date.now()}={}) {
 let access=null, expires=0, scopes=[];
 const configured=Boolean(clientId&&clientSecret&&refreshToken);
 async function token() {
  if(!configured)throw Error('gmail_app_oauth_credentials_required');
  if(access&&expires>clock()+60000)return access;
  let r;try{r=await fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:refreshToken,grant_type:'refresh_token'}).toString(),signal:AbortSignal.timeout(15000)});}catch{throw Error('gmail_oauth_unavailable');}
  const j=await r.json().catch(()=>({}));
  if(!r.ok||!j.access_token)throw Error('gmail_oauth_consent_or_credentials_invalid');
  scopes=String(j.scope||'').split(' ');if(!scopes.includes(SEND)||!scopes.includes(META))throw Error('gmail_send_and_metadata_consent_required');
  access=j.access_token;expires=clock()+Math.max(0,Number(j.expires_in)||0)*1000;return access;
 }
 async function call(path,options={}) {
  const bearer=await token();
  return fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/'+path,{...options,redirect:'error',headers:{Authorization:'Bearer '+bearer,'Content-Type':'application/json'},signal:AbortSignal.timeout(15000)});
 }
 async function readiness(){
  if(!configured)return{ready:false,provider:'gmail',sender:SENDER,blockers:['gmail_app_oauth_credentials_required']};
  try{const r=await call('profile'),j=await r.json().catch(()=>({}));
   if(!r.ok||String(j.emailAddress||'').toLowerCase()!==SENDER)return{ready:false,provider:'gmail',sender:SENDER,blockers:['gmail_authenticated_sender_mismatch_or_unverified']};
   return{ready:true,provider:'gmail',sender:SENDER,authenticatedSender:j.emailAddress,grantedScopes:scopes,checkedAt:new Date(clock()).toISOString(),receiptMeaning:'Gmail message ID proves provider acceptance, not recipient delivery.'};
  }catch(e){return{ready:false,provider:'gmail',sender:SENDER,blockers:[e.message]};}
 }
 async function send(draft,{canSend=async()=>true}={}){
  if(!draft?.id||draft.status!=='approved'||draft.ownerApproved!==true||draft.sendPermitted!==true)return{ok:false,reason:'owner_approval_required'};
  if(!/^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[a-z]{2,}$/i.test(draft.recipient||'')||/[\r\n]/.test(draft.subject||'')||!draft.subject||!draft.text)return{ok:false,reason:'invalid_message'};
  if(!/^https:\/\/[^\s<>\r\n]+$/.test(draft.listUnsubscribe||'')||!draft.text.includes(draft.listUnsubscribe))return{ok:false,reason:'unsubscribe_link_required'};
  const ready=await readiness();if(!ready.ready)return{ok:false,reason:ready.blockers[0]};
  const hash=require('crypto').createHash('sha256').update(draft.id).digest('hex');
  const mime=['From: FANTASY MMADNESS <'+SENDER+'>','To: '+draft.recipient,'Subject: =?UTF-8?B?'+Buffer.from(draft.subject).toString('base64')+'?=','Message-ID: <growth-'+hash+'@fantasymmadnesscom.com>','MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','List-Unsubscribe: <'+draft.listUnsubscribe+'>','List-Unsubscribe-Post: List-Unsubscribe=One-Click','',Buffer.from(draft.text).toString('base64').match(/.{1,76}/g).join('\r\n')].join('\r\n');
  // Gmail has no idempotency-key API. Uncertain requests MUST be held by the queue.
  if(!await canSend())return{ok:false,reason:'emergency_stop_or_campaign_changed'};
  try{const r=await call('messages/send',{method:'POST',body:JSON.stringify({raw:Buffer.from(mime).toString('base64url')})}),j=await r.json().catch(()=>({}));
   if(!r.ok)return{ok:false,reason:'gmail_rejected_'+r.status,retryable:r.status===429,uncertain:r.status>=500};
   if(!j.id)return{ok:false,reason:'gmail_acceptance_receipt_missing',uncertain:true};
   return{ok:true,receipt:{provider:'gmail',providerMessageId:j.id,threadId:j.threadId||null,acceptedAt:new Date(clock()).toISOString(),status:'accepted',delivered:false,realDelivery:true,sandbox:false}};
  }catch{return{ok:false,reason:'gmail_send_outcome_unknown',uncertain:true};}
 }
 return{name:'gmail',realDelivery:true,readiness,send};
}
module.exports={createGmailProvider,SENDER,SEND,META};
