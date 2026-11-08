'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('crypto'),{MongoClient}=require('mongodb');
const {createProductionMailAuthorization,encryptCredential}=require('./growth-production-mail-authorization');
const {createTokenVault}=require('./growth-token-vault');
const uri=process.env.GROWTH_TEST_MONGO_URI;
test('encrypted credential reuse is owner-authorized, expiring, authenticated, sealed and duplicate protected; controlled test sends once',{skip:!uri},async()=>{
 const client=await new MongoClient(uri).connect(),db=client.db('growth_mail_import_local'),prefix=crypto.randomBytes(8).toString('hex'),settings=db.collection(prefix+'settings'),audit=db.collection(prefix+'audit');
 const token='fixture-owner-capability',vaultKey=crypto.randomBytes(32).toString('base64');let sent=0,now=new Date('2026-11-08T18:00:00Z');
 const provider={readiness:async()=>({ready:true}),sendControlledVerification:async(id,{canSend})=>{assert.equal(await canSend(),true);sent++;return{ok:true,receipt:{providerAcceptanceResponse:'250 OK fixture-provider-id',status:'accepted',delivered:false}};}};
 const args={settings,audit,vaultKey,provider,clock:()=>now,verifyCredential:async password=>({ready:password==='private-fixture-password'}),authorization:{id:'owner-test-fixture-20261108',tokenHash:crypto.createHash('sha256').update(token).digest('hex'),expiresAt:'2026-11-08T18:30:00Z'}},api=createProductionMailAuthorization(args);
 try{
 const c=await api.challenge(),cipher=encryptCredential(c.publicKey,c.id,'private-fixture-password');assert.doesNotMatch(JSON.stringify(cipher),/private-fixture-password/);
 assert.equal((await api.importCredential(cipher,'wrong')).ok,false);assert.equal((await api.importCredential({...cipher,ciphertext:'invalid'},token)).ok,false);
 const imported=await api.importCredential(cipher,token);assert.equal(imported.ok,true);assert.doesNotMatch(JSON.stringify(imported),/password|credentialSealed/);assert.equal(await api.credential(),'private-fixture-password');
 const stored=await settings.findOne({_id:'mailbox-authorization'});assert.doesNotMatch(JSON.stringify(stored),/private-fixture-password/);assert.equal(createTokenVault(vaultKey).open(stored.credentialSealed,'mail:contact:gmail-smtp'),'private-fixture-password');
 assert.equal((await api.importCredential(cipher,token)).duplicate,true);assert.equal((await api.controlledTest('wrong')).ok,false);assert.equal((await api.controlledTest(token)).ok,false);
 await settings.insertOne({_id:'distribution-policy',paused:false});const results=await Promise.all([api.controlledTest(token),createProductionMailAuthorization(args).controlledTest(token)]);assert.equal(sent,1);assert.ok(results.some(r=>r.state==='accepted'));assert.equal((await api.controlledTest(token)).duplicate,true);assert.equal(sent,1);
 now=new Date('2026-11-08T19:00:00Z');assert.equal((await api.controlledTest(token)).ok,false);assert.equal((await api.importCredential(cipher,token)).ok,false);
 }finally{await settings.drop().catch(()=>{});await audit.drop().catch(()=>{});await client.close();}
});
