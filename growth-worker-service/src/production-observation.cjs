'use strict';
const {MongoClient}=require('mongodb'),{validate}=require('./runtime.cjs');
async function inspect(){const config=validate(),client=await new MongoClient(config.secrets.mongoUri,{maxPoolSize:2,serverSelectionTimeoutMS:10000}).connect();try{return await require('../shared/growth-production-observation').observeProductionPreparation({productionDb:client.db('fmgrowthproduction'),originalDb:client.db('fmgrowthtest')});}finally{await client.close();}}
module.exports={inspect};
