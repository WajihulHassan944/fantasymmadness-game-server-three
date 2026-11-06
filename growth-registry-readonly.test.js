'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {productionReadOnlyFetch,preparationCollectionName}=require('./growth-production-preparation-config');
test('Growth rejects game mutations, credential forwarding and side-effectful GET cron/admin routes',async()=>{
 let calls=0;const fetch=productionReadOnlyFetch(async()=>{calls++;return{ok:true};}),host='https://fantasymmadness-game-server-three-taupe.vercel.app';
 for(const path of ['/api/cron/ufc-event-discovery','/api/cron-job','/api/cron/retention','/api/admin/fights','/api/admin/ufc-event-discovery/refresh','/addMatch','/addShadow','/compare-matches'])for(const method of ['GET','HEAD','POST','PUT','PATCH','DELETE'])await assert.rejects(()=>fetch(host+path,{method}));
 for(const method of ['POST','PUT','PATCH','DELETE'])await assert.rejects(()=>fetch(host+'/match',{method}));
 for(const key of ['Authorization','Cookie','X-Cron-Secret','X-Admin-Token'])await assert.rejects(()=>fetch(host+'/match',{headers:{[key]:'TEST FIXTURE'}}),/anonymous_read/);
 assert.equal(calls,0);for(const path of ['/match?status=any','/shadow','/api/public/fights','/api/public/prediction-fights','/api/public/pro-wrestling/matches'])await fetch(host+path);assert.equal(calls,5);
});
test('Growth namespace refuses game records while preserving its own campaign and attribution stores',()=>{
 for(const name of ['matches','shadows','combat_fighters','users','payments','transactions','user_matches','scores','affiliates','pro_wrestling_matches'])assert.throws(()=>preparationCollectionName(name),/game_registry_collection_forbidden/);
 assert.equal(preparationCollectionName('growth_drafts'),'production_preparation_growth_drafts');assert.equal(preparationCollectionName('growth_affiliates'),'production_preparation_growth_affiliates');assert.equal(preparationCollectionName('growth_attribution_events'),'production_preparation_growth_attribution_events');
});
