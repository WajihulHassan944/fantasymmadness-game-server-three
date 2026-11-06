'use strict';
// Separate production contract. Never relax the isolated runtime's test-DB gate.
const crypto=require('node:crypto');
const PROJECT=require('./growth-runtime-config').ISOLATED_PROJECT_ID;
const DATABASE='fmgrowthproduction',PREFIX='production_preparation_';
const approved=new WeakSet();
function resolveProductionPreparationConfig(env=process.env){
 const usingExisting=env.GROWTH_PREPARATION_CREDENTIAL_SOURCE==='existing_production_growth_binding'&&env.GROWTH_PREPARATION_ALLOW_SHARED_CLUSTER==='true';
 const errors=[],uri=String(env.GROWTH_PREPARATION_MONGODB_URI||(usingExisting?env.MONGODB_URI:'')||''),host=String(env.GROWTH_PREPARATION_ATLAS_HOST||'').toLowerCase(),owners=[...new Set(String(env.GROWTH_PREPARATION_OWNER_IDS||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean))];
 if(env.VERCEL_ENV!=='production'||env.VERCEL_PROJECT_ID!==PROJECT)errors.push('dedicated_growth_production_target_required');
 if(env.GROWTH_PREPARATION_MODE!=='production_preparation')errors.push('explicit_production_preparation_mode_required');
 if(env.GROWTH_PREPARATION_APPROVED!=='true')errors.push('production_preparation_authorization_binding_required');
 if(!/^[a-f0-9]{40}$/.test(env.GROWTH_PREPARATION_VERIFIED_SHA||'')||env.GROWTH_PREPARATION_VERIFIED_SHA!==env.VERCEL_GIT_COMMIT_SHA)errors.push('verified_production_release_commit_required');
 let parsed;try{parsed=new URL(uri);}catch{}
 if(!parsed||parsed.protocol!=='mongodb+srv:'||(!usingExisting&&parsed.pathname!=='/'+DATABASE)||(usingExisting&&(!['/fmgrowthtest','/',''].includes(parsed?.pathname)||parsed?.hostname!=='fmgrowthtest.zxhtsfa.mongodb.net')))errors.push('dedicated_production_growth_database_binding_required');
 if(!host||!parsed||parsed.hostname.toLowerCase()!==host||(!usingExisting&&host==='fmgrowthtest.zxhtsfa.mongodb.net'))errors.push('production_atlas_host_pin_required');
 if(!owners.length||owners.some(x=>!/^[a-f\d]{24}$/.test(x)))errors.push('verified_production_owner_ids_required');
 for(const k of ['GROWTH_OUTBOUND_ENABLED','GROWTH_SOCIAL_PUBLISHING_APPROVED','GROWTH_AUTOMATION_LIVE_APPROVED','GROWTH_AUTOMATIC_APPROVAL_ENABLED','GROWTH_PAYMENT_MUTATIONS_ENABLED'])if(env[k]!=='false')errors.push(k+'_must_be_false');
 if(env.GROWTH_DELIVERY_PROVIDER!=='none'||env.GROWTH_SOCIAL_PROVIDER!=='none')errors.push('production_delivery_and_publishing_providers_must_be_none');
 for(const k of ['JWT_SECRET_ADMIN','GROWTH_UNSUBSCRIBE_SECRET'])if(String(env[k]||'').length<32)errors.push(k+'_required');
 if(String(env.CRON_SECRET||'').length<16)errors.push('CRON_SECRET_required');
 const sso=require('./growth-admin-sso').resolveSsoConfig(env);
 if(!sso.enabled||sso.errors.length||!['https://fantasymmadness.com','https://www.fantasymmadness.com'].every(o=>sso.siteOrigins.includes(o))||sso.siteOrigins.some(o=>!['https://fantasymmadness.com','https://www.fantasymmadness.com'].includes(o)))errors.push('production_website_sso_required');
 const config={mode:'production_preparation',onVercel:true,autonomy:{liveApproved:false,owners},database:{kind:'atlas',name:DATABASE,host,hostPinned:Boolean(host),credentialSource:usingExisting?'existing_production_growth_binding':'dedicated_production_binding',sharedCluster:usingExisting,isolation:'separate_database_and_namespace'},collectionPrefix:PREFIX,delivery:{provider:'none',realDelivery:false,blockers:['owner_delivery_approval_not_granted']},discoveryEnabled:true,discoveryCountries:['US','GB','CA','AU','BR','MX','JP','DE','FR','ZA'],discoveryLimitPerWorker:10,unsubscribeBaseUrl:'',staleRunMinutes:35,contestSourceUrl:'https://fantasymmadness-game-server-three-taupe.vercel.app',marketingHorizonDays:21,maxCampaignsPerSport:3,liveReport:{configured:false},ingest:{configured:false},social:{provider:'none',approved:false,paused:true,channels:{}},fightUrlDiscovery:true,researchPerRun:4,posters:{enabled:false},sso:{...sso,allow:owners},meta:{liveTestApproved:false}};
 const secrets={mongoUri:uri,adminJwtSecret:env.JWT_SECRET_ADMIN,unsubscribeSecret:env.GROWTH_UNSUBSCRIBE_SECRET,cronSecret:env.CRON_SECRET,tokenEncryptionKey:env.GROWTH_TOKEN_ENCRYPTION_KEY||'',social:{}};
 if(!errors.length)approved.add(config);
 return{ok:!errors.length,errors,config,secrets};
}
function assertProductionDatabase(db,config){if(!approved.has(config)||db?.databaseName!==DATABASE||config.collectionPrefix!==PREFIX)throw Error('validated_production_preparation_database_required');}
function productionReadOnlyFetch(fetchImpl=globalThis.fetch){return async(url,options={})=>{const u=new URL(url),method=String(options.method||'GET').toUpperCase();
 if(/^fantasymmadness-game-server-three[a-z0-9-]*\.vercel\.app$/.test(u.hostname)){
  const path=u.pathname,publicRead=/^\/(?:match|shadow)(?:\/[a-f\d]{24})?\/?$/i.test(path)||/^\/api\/public\/(?:fights|prediction-fights)(?:\/[a-f\d]{24})?\/?$/i.test(path)||/^\/api\/public\/pro-wrestling\/matches(?:\/[a-f\d]{24})?\/?$/i.test(path);
  if(!publicRead)throw Error('game_registry_public_read_path_required');
  const headers=new Headers(options.headers||{});if(['authorization','cookie','x-cron-secret','x-admin-token'].some(key=>headers.has(key)))throw Error('game_registry_anonymous_read_required');
 }
if(u.protocol!=='https:'||u.username||u.password||!['GET','HEAD'].includes(method)||options.body!==undefined)throw Error('production_preparation_read_only_network_required');return fetchImpl(url,{...options,method,redirect:options.redirect==='manual'?'manual':'error',signal:options.signal||AbortSignal.timeout(15000)});};}
function preparationCollectionName(name){
 if(!/^[a-z_]+$/.test(name)||name.startsWith('preview'))throw Error('production_collection_not_permitted');
 if(new Set(['match','matches','shadow','shadows','scores','users','admins','affiliates','payments','transactions','user_matches','bettingwins','combat_fighters','pro_wrestling_matches','full_card_entries','full_cards']).has(name))throw Error('game_registry_collection_forbidden');
 return PREFIX+name;
}
function deploymentFingerprint(config){return crypto.createHash('sha256').update(JSON.stringify({mode:config.mode,database:config.database,prefix:config.collectionPrefix,owners:config.autonomy.owners})).digest('hex');}
module.exports={resolveProductionPreparationConfig,assertProductionDatabase,productionReadOnlyFetch,preparationCollectionName,deploymentFingerprint,DATABASE,PREFIX,PROJECT};
