'use strict';
const {MongoClient}=require('mongodb');
const {resolveProductionPreparationConfig,DATABASE}=require('../shared/growth-production-preparation-config');
let cached;
async function context(){return cached||=(async()=>{
 const resolved=resolveProductionPreparationConfig();if(!resolved.ok)throw Error('production_preparation_safety_checks_failed');
 const original=new URL(process.env.MONGODB_URI||'');if(original.protocol!=='mongodb+srv:'||original.hostname!=='fmgrowthtest.zxhtsfa.mongodb.net')throw Error('original_production_owner_evidence_source_required');
 const evidenceClient=await new MongoClient(process.env.MONGODB_URI,{maxPoolSize:1,serverSelectionTimeoutMS:10000}).connect();let verifiedOwnerIds;
 try{const records=await evidenceClient.db('fmgrowthtest').collection('growth_audit_log').find({action:'sso_login',method:'website_admin',transport:'first_party_assertion',issuerConfirmed:true,site:{$in:['https://fantasymmadness.com','https://www.fantasymmadness.com']}},{projection:{_id:0,adminId:1}}).toArray();verifiedOwnerIds=[...new Set(records.map(x=>String(x.adminId||'').toLowerCase()).filter(x=>/^[a-f0-9]{24}$/.test(x)))];}finally{await evidenceClient.close();}
 if(!resolved.config.autonomy.owners.every(id=>verifiedOwnerIds.includes(id)))throw Error('production_first_party_owner_evidence_required');
 const client=await new MongoClient(resolved.secrets.mongoUri,{maxPoolSize:3,serverSelectionTimeoutMS:10000}).connect();
 try{return await require('../shared/growth-production-preparation').createProductionPreparation({rawDb:client.db(DATABASE),...resolved,verifiedOwnerIds});}catch(e){await client.close();throw e;}
 })().catch(e=>{cached=null;throw e;});}
async function cycle(generation,ordinal){const c=await context();return c.cycle({generation,ordinal,deploymentId:process.env.VERCEL_DEPLOYMENT_ID});}
module.exports={context,cycle};
