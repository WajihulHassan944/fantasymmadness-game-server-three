'use strict';
const ORIGIN='https://fantasymmadness-game-server-three-taupe.vercel.app/api/growth-mail-relay';
const TEST_ID='owner-contact-delivery-verification-20261108';
const TEST={id:TEST_ID,kind:'owner_delivery_verification',ownerApproved:true,sendPermitted:true,recipient:'facester1@gmail.com',subject:'FANTASY MMADNESS Delivery Verification',text:'Owner-authorized FANTASY MMADNESS Growth Engine email delivery verification. This is a test only. No campaign or invitation is included.'};
function createSmtpRelayProvider({fetchImpl=globalThis.fetch,getToken=()=>require('@vercel/oidc').getVercelOidcToken()}={}){
 async function call(path,body){let token;try{token=await getToken();}catch{return{ok:false,reason:'workload_identity_unavailable'};}
  try{const r=await fetchImpl(ORIGIN+path,{method:body?'POST':'GET',redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(45000)}),j=await r.json().catch(()=>({}));if(!r.ok)return{ok:false,reason:'mail_service_access_'+r.status};return j;}catch{return{ok:false,reason:'mail_service_outcome_unknown',uncertain:Boolean(body)};}
 }
 async function readiness(){const r=await call('/verify');return{provider:'gmail-smtp',sender:'contact@fantasymmadnesscom.com',ready:r.ok===true&&r.ready===true&&r.sender==='contact@fantasymmadnesscom.com',blockers:r.ok?[]:[r.reason||'existing_mail_service_unverified'],credentialLocation:'existing_backend_only',credentialTransferred:false,checkedAt:r.checkedAt||null};}
 async function send(draft,{canSend=async()=>false,deliveryClaim}={}){if(draft.status!=='approved'||draft.ownerApproved!==true||draft.sendPermitted!==true)return{ok:false,reason:'exact_owner_approval_required'};if(!await canSend())return{ok:false,reason:'emergency_stop_or_campaign_changed'};return call('/send',{id:draft.id,deliveryClaim,ownerApproved:true,sendPermitted:true,recipient:draft.recipient,subject:draft.subject,text:draft.text,listUnsubscribe:draft.listUnsubscribe});}
 async function controlledVerification({settings,audit,authorizationId,canSend}){
  if(authorizationId!==TEST_ID)return{ok:false,reason:'explicit_owner_verification_grant_required'};
  const key='controlled-mail-test:'+TEST_ID,old=await settings.findOne({_id:key});if(old)return{ok:old.state==='accepted',duplicate:true,state:old.state,receipt:old.receipt||null};
  const r=await readiness();if(!r.ready||!await canSend())return{ok:false,reason:'mailbox_unverified_or_emergency_stop'};
  const deliveryClaim=require('crypto').randomUUID();let claim;try{claim=await settings.updateOne({_id:key},{$setOnInsert:{state:'attempting',sendClaim:deliveryClaim,at:new Date().toISOString(),recipient:TEST.recipient,source:'explicit_owner_chat_approval'}},{upsert:true});}catch(e){if(e.code===11000)return{ok:false,reason:'test_already_claimed'};throw e;}
  if(claim.upsertedCount!==1)return{ok:false,reason:'test_already_claimed'};
  await audit.insertOne({action:'owner_controlled_mail_test_authorized',id:TEST_ID,recipient:TEST.recipient,at:new Date().toISOString()});
  const result=await canSend()?await call('/send',{...TEST,deliveryClaim}):{ok:false,reason:'emergency_stop'},state=result.ok?'accepted':result.uncertain?'needs_check':'failed';
  await settings.updateOne({_id:key},{$set:{state,receipt:result.receipt||null,reason:result.reason||null,completedAt:new Date().toISOString()}});await audit.insertOne({action:'owner_controlled_mail_test_result',id:TEST_ID,state,receipt:result.receipt||null,at:new Date().toISOString()});return{...result,state};
 }
 return{name:'gmail-smtp-existing-backend',realDelivery:true,readiness,send,controlledVerification};
}
module.exports={createSmtpRelayProvider,TEST_ID};
