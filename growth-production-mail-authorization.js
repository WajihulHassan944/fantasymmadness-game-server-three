'use strict';
// Explicit, expiring server-to-server reuse of the owner's existing SMTP credential.
// The assistant never receives plaintext. Storage is sealed in the Growth namespace.
const crypto=require('node:crypto');
const {createTokenVault}=require('./growth-token-vault');
const SENDER='contact@fantasymmadnesscom.com',INFO='growth-contact-mail-import-v1',LABEL='mail:contact:gmail-smtp';
function keys(vaultKey){const seed=crypto.createHmac('sha256',Buffer.from(vaultKey,'base64')).update(INFO).digest();const privateKey=crypto.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b656e04220420','hex'),seed]),format:'der',type:'pkcs8'});return{privateKey,publicKey:crypto.createPublicKey(privateKey).export({type:'spki',format:'pem'})};}
function encryptCredential(publicKey,id,password){const pair=crypto.generateKeyPairSync('x25519'),secret=crypto.diffieHellman({privateKey:pair.privateKey,publicKey:crypto.createPublicKey(publicKey)}),key=Buffer.from(crypto.hkdfSync('sha256',secret,Buffer.from(id),Buffer.from(INFO),32)),iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(id));const ciphertext=Buffer.concat([c.update(JSON.stringify({sender:SENDER,password})),c.final()]);return{id,ephemeralKey:pair.publicKey.export({type:'spki',format:'pem'}),iv:iv.toString('base64url'),tag:c.getAuthTag().toString('base64url'),ciphertext:ciphertext.toString('base64url')};}
function createProductionMailAuthorization({settings,audit,vaultKey,provider,authorization={},verifyCredential=async password=>require('./growth-gmail-smtp-provider').createGmailSmtpProvider({user:SENDER,password}).readiness({force:true}),clock=()=>new Date()}={}){
 const vault=createTokenVault(vaultKey),id=authorization.id;
 async function claimOnce(key,fields){try{return await settings.updateOne({_id:key},{$setOnInsert:fields},{upsert:true});}catch(e){if(e.code===11000)return{upsertedCount:0};throw e;}}
 function permitted(token){const got=crypto.createHash('sha256').update(String(token||'')).digest('hex'),want=String(authorization.tokenHash||'');return /^[a-z0-9-]{10,100}$/.test(id||'')&&vault.configured&&Number.isFinite(Date.parse(authorization.expiresAt))&&+clock()<Date.parse(authorization.expiresAt)&&want.length===got.length&&crypto.timingSafeEqual(Buffer.from(got),Buffer.from(want));}
 async function challenge(){if(!vault.configured||!id||!Number.isFinite(Date.parse(authorization.expiresAt))||+clock()>=Date.parse(authorization.expiresAt))return{ok:false,reason:'mail_authorization_import_not_active'};return{ok:true,id,sender:SENDER,publicKey:keys(vaultKey).publicKey,expiresAt:authorization.expiresAt};}
 async function credential(){const row=await settings.findOne({_id:'mailbox-authorization',provider:'gmail-smtp',sender:SENDER,verified:true});return row?vault.open(row.credentialSealed,LABEL):'';}
 async function importCredential(body,token){
  if(!permitted(token)||body?.id!==id)return{ok:false,reason:'mail_import_authorization_required'};
  const existing=await settings.findOne({_id:'mail-import:'+id});if(existing)return existing.state==='complete'?{ok:true,duplicate:true,sender:SENDER,verified:true}:{ok:false,reason:'mail_import_already_claimed'};
  let data;try{const own=keys(vaultKey),other=crypto.createPublicKey(body.ephemeralKey);if(other.asymmetricKeyType!=='x25519')throw Error('key');const secret=crypto.diffieHellman({privateKey:own.privateKey,publicKey:other}),key=Buffer.from(crypto.hkdfSync('sha256',secret,Buffer.from(id),Buffer.from(INFO),32)),d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(body.iv,'base64url'));d.setAAD(Buffer.from(id));d.setAuthTag(Buffer.from(body.tag,'base64url'));data=JSON.parse(Buffer.concat([d.update(Buffer.from(body.ciphertext,'base64url')),d.final()]).toString());}catch{return{ok:false,reason:'mail_import_ciphertext_invalid'};}
  if(data.sender!==SENDER||typeof data.password!=='string'||data.password.length>256||data.password.length<8)return{ok:false,reason:'exact_contact_mailbox_credential_required'};
  const claim=await claimOnce('mail-import:'+id,{state:'processing',startedAt:clock().toISOString()});if(claim.upsertedCount!==1)return{ok:false,reason:'mail_import_already_claimed'};
  const ready=await verifyCredential(data.password);
  if(!ready.ready){await settings.updateOne({_id:'mail-import:'+id},{$set:{state:'failed',reason:'contact_authentication_failed'}});return{ok:false,reason:'contact_authentication_failed'};}
  await audit.insertOne({action:'owner_authorized_existing_mail_credential_reuse',authorizationId:id,sender:SENDER,at:clock().toISOString(),plaintextReturned:false,originalCredentialsChanged:false});
  await settings.updateOne({_id:'mailbox-authorization'},{$set:{provider:'gmail-smtp',sender:SENDER,verified:true,credentialSealed:vault.seal(data.password,LABEL),source:'existing_owner_saved_password',authorizationId:id,verifiedAt:clock().toISOString()}},{upsert:true});
  await settings.updateOne({_id:'mail-import:'+id},{$set:{state:'complete',completedAt:clock().toISOString()}});return{ok:true,sender:SENDER,verified:true,plaintextReturned:false,originalCredentialsChanged:false};
 }
 async function controlledTest(token){
  if(!permitted(token))return{ok:false,reason:'explicit_owner_test_authorization_required'};
  const key='owner-mail-test:'+id,old=await settings.findOne({_id:key});if(old)return{ok:old.state==='accepted',duplicate:true,state:old.state,receipt:old.receipt||null};
  const canSend=async()=>{const p=await settings.findOne({_id:'autonomy:policy'}),d=await settings.findOne({_id:'distribution-policy'});return p?.paused!==true&&d?.paused===false;};
  if(!await canSend())return{ok:false,reason:'owner_emergency_stop_or_distribution_paused'};
  if(typeof provider.sendControlledVerification!=='function')return{ok:false,reason:'smtp_verification_provider_required'};
  const ready=await provider.readiness({force:true});if(!ready.ready)return{ok:false,reason:'contact_mailbox_authentication_required'};
  const claim=await claimOnce(key,{state:'attempting',at:clock().toISOString(),recipient:'facester1@gmail.com',sender:SENDER});if(claim.upsertedCount!==1)return{ok:false,reason:'owner_test_already_claimed'};
  await audit.insertOne({action:'owner_controlled_mail_test_authorized',authorizationId:id,recipient:'facester1@gmail.com',sender:SENDER,source:'explicit_owner_chat_request',at:clock().toISOString()});
  let result;try{result=await provider.sendControlledVerification(id,{canSend});}catch{result={ok:false,uncertain:true,reason:'mail_test_outcome_unknown'};}
  const state=result.ok?'accepted':result.uncertain?'needs_check':'failed',receipt=result.receipt||null;
  await settings.updateOne({_id:key},{$set:{state,receipt,reason:result.reason||null,completedAt:clock().toISOString()}});await audit.insertOne({action:'owner_controlled_mail_test_result',authorizationId:id,state,receipt,at:clock().toISOString()});return{ok:result.ok,state,receipt,reason:result.reason||null};
 }
 async function status(){const r=await settings.findOne({_id:'mailbox-authorization'},{projection:{credentialSealed:0}}),t=await settings.findOne({_id:'owner-mail-test:'+(r?.authorizationId||id)});return{authorizationStored:r?.verified===true,sender:SENDER,verificationTest:t?{state:t.state,receipt:t.receipt||null}:null};}
 return{challenge,credential,importCredential,controlledTest,status};
}
module.exports={createProductionMailAuthorization,encryptCredential};
