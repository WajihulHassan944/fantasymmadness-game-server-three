'use strict';
// Reuses Gmail's authenticated SMTP service; never changes mailbox credentials.
const SENDER='contact@fantasymmadnesscom.com';
function createGmailSmtpProvider({user='',password='',transportFactory,credentialSource=null,clock=()=>Date.now()}={}){
 const matches=String(user).trim().toLowerCase()===SENDER;let credential=String(password||'').replace(/\s+/g,'');
 let checkedAt=0,cached=null;
 const make=()=> (transportFactory||require('nodemailer').createTransport)({host:'smtp.gmail.com',port:465,secure:true,auth:{user:String(user).trim(),pass:credential},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:20000,tls:{rejectUnauthorized:true}});
 async function readiness({force=false}={}){
  if(credentialSource){try{const saved=await credentialSource();if(saved)credential=String(saved).replace(/\s+/g,'');}catch{return{provider:'gmail-smtp',sender:SENDER,ready:false,blockers:['saved_mailbox_authorization_unavailable']};}}
  const out={provider:'gmail-smtp',sender:SENDER,ready:false,blockers:[]};
  if(!user||!credential){out.blockers.push('existing_contact_mailbox_smtp_binding_required');return out;}
  if(!matches){out.blockers.push('smtp_authenticated_mailbox_must_match_business_sender');return out;}
  if(!force&&cached&&clock()-checkedAt<120000)return cached;
  const t=make();try{await t.verify();Object.assign(out,{ready:true,authenticatedSender:SENDER,host:'smtp.gmail.com',port:465,tlsVerified:true,checkedAt:new Date(clock()).toISOString()});}
  catch(e){out.blockers.push('gmail_smtp_authentication_not_verified');out.code=String(e.code||'UNKNOWN').replace(/[^A-Z0-9_]/g,'').slice(0,30);out.responseCode=Number(e.responseCode)||null;}
  finally{t.close?.();}cached=out;checkedAt=clock();return out;
 }
 async function send(draft,{canSend=async()=>true}={}){
  if(!draft?.id||draft.status!=='approved'||draft.ownerApproved!==true||draft.sendPermitted!==true)return{ok:false,reason:'owner_approval_required'};
  if(!/^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[a-z]{2,}$/i.test(draft.recipient||'')||!draft.subject||/[\r\n]/.test(draft.subject)||!draft.text)return{ok:false,reason:'invalid_message'};
  if(!/^https:\/\/[^\s<>\r\n]+$/.test(draft.listUnsubscribe||'')||!draft.text.includes(draft.listUnsubscribe))return{ok:false,reason:'unsubscribe_link_required'};
  return deliver(draft,{canSend});
 }
 async function deliver(draft,{canSend}){
  const r=await readiness({force:true});if(!r.ready)return{ok:false,reason:r.blockers[0]};
  if(!await canSend())return{ok:false,reason:'emergency_stop_or_campaign_changed'};
  const t=make();try{
   const info=await t.sendMail({from:'FANTASY MMADNESS <'+SENDER+'>',envelope:{from:SENDER,to:[draft.recipient]},to:draft.recipient,subject:draft.subject,text:draft.text,messageId:'<growth-'+require('crypto').createHash('sha256').update(draft.id).digest('hex')+'@fantasymmadnesscom.com>',headers:draft.listUnsubscribe?{'List-Unsubscribe':'<'+draft.listUnsubscribe+'>','List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}:undefined});
   const accepted=(info.accepted||[]).some(x=>String(x.address||x).toLowerCase()===draft.recipient.toLowerCase());
   const response=String(info.response||'').replace(/[\r\n]/g,' ').slice(0,500);
   if(!accepted||!/^250\b/.test(response))return{ok:false,reason:'gmail_smtp_acceptance_unconfirmed',uncertain:true};
   return{ok:true,receipt:{provider:'gmail-smtp',providerAcceptanceResponse:response,messageId:info.messageId||null,status:'accepted',acceptedAt:new Date(clock()).toISOString(),delivered:false,realDelivery:true,sandbox:false}};
  }catch(e){const code=Number(e.responseCode)||0;return{ok:false,reason:code?'gmail_smtp_rejected_'+code:'gmail_smtp_outcome_unknown',retryable:code>=400&&code<500,uncertain:!code};}
  finally{t.close?.();}
 }
 async function sendControlledVerification(id,{canSend=async()=>false}={}){if(!/^[a-z0-9-]{10,100}$/.test(id||''))return{ok:false,reason:'explicit_verification_id_required'};return deliver({id:'owner-verification:'+id,recipient:'facester1@gmail.com',subject:'FANTASY MMADNESS Delivery Verification',text:'Owner-authorized FANTASY MMADNESS Growth Engine email delivery verification. This is a test only. No campaign or invitation is included.'},{canSend});}
 return{name:'gmail-smtp',realDelivery:true,readiness,send,sendControlledVerification};
}
module.exports={createGmailSmtpProvider,SENDER};
