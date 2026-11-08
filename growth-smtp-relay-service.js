'use strict';
// The existing SMTP credential stays in this backend runtime. Only the signed,
// production Growth workload may verify authentication or request an approved send.
const SENDER='contact@fantasymmadnesscom.com';
function createSmtpRelayService({env=process.env,verifyToken,transportFactory,claimDelivery}={}){
 const verify=verifyToken||((token)=>require('@vercel/oidc').verifyVercelOidcToken(token,{issuer:'https://oidc.vercel.com/kelly-davis-projects-6c108d0b',audience:'https://vercel.com/kelly-davis-projects-6c108d0b',ownerId:'team_YE6Qw7cYL85CvuigfUXsH1lq',projectId:'prj_Hpe9UjGrBBJOm3boxHsL9lHesWLl',environment:'production'}));
 const make=()=> (transportFactory||require('nodemailer').createTransport)({host:'smtp.gmail.com',port:465,secure:true,auth:{user:SENDER,pass:String(env.SMTP_PASS||env.GMAIL_APP_PASSWORD||'').replace(/\s+/g,'')},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:20000,tls:{rejectUnauthorized:true}});
 return async function(req,res){
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
  try{const token=String(req.headers.authorization||'').replace(/^Bearer /,'');if(!token)throw Error('missing');await verify(token);}catch{res.statusCode=401;return res.end(JSON.stringify({ok:false,reason:'verified_production_growth_workload_required'}));}
  const path=req.url.split('?')[0],isVerify=path==='/api/mail/verify'&&req.method==='GET',isSend=path==='/api/mail/send'&&req.method==='POST';
  if(!isVerify&&!isSend){res.statusCode=404;return res.end(JSON.stringify({ok:false}));}
  if(!String(env.SMTP_PASS||env.GMAIL_APP_PASSWORD||'')){res.statusCode=409;return res.end(JSON.stringify({ok:false,reason:'existing_smtp_authorization_missing'}));}
  let message;
  if(isSend){let body=req.body;if(!body){let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>16000){res.statusCode=413;return res.end(JSON.stringify({ok:false}));}}try{body=JSON.parse(raw);}catch{body=null;}}
   if(!body||typeof body.id!=='string'||body.id.length>200||body.ownerApproved!==true||body.sendPermitted!==true||!/^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[a-z]{2,}$/i.test(body.recipient||'')||!body.subject||String(body.subject).length>200||/[\r\n]/.test(body.subject)||!body.text||String(body.text).length>12000){res.statusCode=400;return res.end(JSON.stringify({ok:false,reason:'exact_approved_message_required'}));}
   const test=body.kind==='owner_delivery_verification'&&body.recipient==='facester1@gmail.com'&&body.subject==='FANTASY MMADNESS Delivery Verification'&&body.text==='Owner-authorized FANTASY MMADNESS Growth Engine email delivery verification. This is a test only. No campaign or invitation is included.';
   if(!test&&(!/^https:\/\/[^\s<>\r\n]+$/.test(body.listUnsubscribe||'')||!body.text.includes(body.listUnsubscribe))){res.statusCode=400;return res.end(JSON.stringify({ok:false,reason:'unsubscribe_required'}));}
   let claimed=false;try{if(claimDelivery)claimed=await claimDelivery(body.id,body.deliveryClaim);else{const token=await require('@vercel/oidc').getVercelOidcToken();const r=await fetch('https://fantasymmadness-growth-isolated-tes.vercel.app/api/growth/internal/mail-attempt',{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({id:body.id,claim:body.deliveryClaim}),signal:AbortSignal.timeout(15000)});const j=await r.json();claimed=r.ok&&j.ok===true;}}catch{}
   if(!claimed)return res.end(JSON.stringify({ok:false,uncertain:true,reason:'durable_delivery_claim_not_verified'}));
   message={from:'FANTASY MMADNESS <'+SENDER+'>',envelope:{from:SENDER,to:[body.recipient]},to:body.recipient,subject:body.subject,text:body.text,messageId:'<growth-'+require('crypto').createHash('sha256').update(body.id).digest('hex')+'@fantasymmadnesscom.com>',headers:body.listUnsubscribe?{'List-Unsubscribe':'<'+body.listUnsubscribe+'>','List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}:undefined};
  }
  const t=make();try{await t.verify();if(isVerify)return res.end(JSON.stringify({ok:true,ready:true,sender:SENDER,authenticated:true,tlsVerified:true,credentialTransferred:false,checkedAt:new Date().toISOString()}));
   const info=await t.sendMail(message),accepted=(info.accepted||[]).some(x=>String(x.address||x).toLowerCase()===message.to.toLowerCase()),response=String(info.response||'').replace(/[\r\n]/g,' ').slice(0,500);
   if(!accepted||!/^250\b/.test(response))return res.end(JSON.stringify({ok:false,uncertain:true,reason:'smtp_acceptance_unconfirmed'}));
   return res.end(JSON.stringify({ok:true,receipt:{provider:'gmail-smtp-existing-backend',providerAcceptanceResponse:response,messageId:info.messageId||null,status:'accepted',acceptedAt:new Date().toISOString(),delivered:false,realDelivery:true,sandbox:false}}));
  }catch(e){const code=Number(e.responseCode)||0;return res.end(JSON.stringify({ok:false,reason:code?'smtp_rejected_'+code:'smtp_operation_unavailable',retryable:code>=400&&code<500,uncertain:isSend&&!code}));}finally{t.close?.();}
 };
}
module.exports={createSmtpRelayService};
