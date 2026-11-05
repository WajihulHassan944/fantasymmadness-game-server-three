'use strict';
const {MongoClient}=require('mongodb');
const {validate}=require('./runtime.cjs');
const {inventory}=require('../shared/growth-link-audit');
async function inspect(){const config=validate();const client=await new MongoClient(config.secrets.mongoUri,{maxPoolSize:2,serverSelectionTimeoutMS:10000}).connect();try{return await inventory({db:client.db('fmgrowthtest')});}finally{await client.close();}}
module.exports={inspect};
