'use strict';
// Reuses the selected original encrypted Page authorization; never writes credentials.
const {createTokenVault}=require('./growth-token-vault');
const {createExistingMetaReadOnly}=require('./growth-existing-meta-readonly');
function createProductionMetaProvider({withSource,env,fetchImpl=globalThis.fetch}={}){
 async function verified(db){const reader=createExistingMetaReadOnly({db,env,fetchImpl});const [s,p]=await Promise.all([reader.status({force:true}),reader.permissions()]);return{s,p};}
 async function readiness(){try{return await withSource(async db=>{const {s,p}=await verified(db);return Object.fromEntries(['facebook','instagram'].map(channel=>{const x=s.platforms[channel],scope=channel==='facebook'?'pages_manage_posts':'instagram_content_publish';return[channel,{ready:x.verified===true&&p.verified===true&&p.granted.includes(scope),destinationId:x.id||null,name:x.name||x.username||null,checkedAt:s.health.checkedAt,blockers:!x.verified?[x.reason||'identity_not_verified']:!p.verified||!p.granted.includes(scope)?['provider_scope_required:'+scope]:[]}];}));});}catch{return{facebook:{ready:false,blockers:['existing_meta_verification_unavailable']},instagram:{ready:false,blockers:['existing_meta_verification_unavailable']}};}}
 async function publish(post,{canSend=async()=>true}={}){
  if(!['facebook','instagram'].includes(post.channel))return{ok:false,reason:'unsupported_channel'};
  return withSource(async db=>{
   const {s,p}=await verified(db),channel=post.channel,x=s.platforms[channel],scope=channel==='facebook'?'pages_manage_posts':'instagram_content_publish';
   if(!x.verified||x.id!==post.destinationId||!p.verified||!p.granted.includes(scope))return{ok:false,reason:'provider_identity_or_scope_changed'};
   const local=await db.collection('preview198_growth_connections').findOne({key:'meta'}),prior=await db.collection('growth_connections').findOne({key:'meta'}),doc=local?.selected||local?.disconnectedAt?local:prior||local;
   if(!doc?.selected||doc.selected.pageId!==s.selected?.pageId||doc.selected.igUserId!==s.selected?.igUserId||doc.disconnectedAt&&!doc.selected)return{ok:false,reason:'existing_selected_page_required'};
   const page=(doc.pages||[]).find(p=>p.id===doc.selected.pageId);let token;try{token=createTokenVault(env.GROWTH_TOKEN_ENCRYPTION_KEY).open(page.tokenSealed,'meta:page:'+doc.selected.pageId);}catch{return{ok:false,reason:'existing_authorization_unavailable'};}
   const {preflight}=require('./growth-social-publishing');const pf=await preflight(post,{fetchImpl});if(!pf.ok)return{ok:false,reason:'provider_preflight_failed'};
   const graph='https://graph.facebook.com/v21.0/';
   async function call(path,body){if(!await canSend())return{ok:false,reason:'emergency_stop_or_campaign_changed'};try{const r=await fetchImpl(graph+path,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body).toString(),signal:AbortSignal.timeout(20000)});const j=await r.json().catch(()=>({}));if(!r.ok||j.error)return{ok:false,reason:'meta_provider_rejected_'+r.status,uncertain:r.status>=500,retryable:r.status===429};return{ok:true,data:j};}catch{return{ok:false,reason:'meta_provider_outcome_unknown',uncertain:true};}}
   if(channel==='facebook'){const r=await call(encodeURIComponent(x.id)+'/photos',{url:post.imageUrl,caption:post.text});if(!r.ok)return r;const id=String(r.data.post_id||r.data.id||'');return id?{ok:true,receipt:{provider:'facebook',providerPostId:id,status:'published',sandbox:false,publishedAt:new Date().toISOString()}}:{ok:false,reason:'meta_post_receipt_missing',uncertain:true};}
   const image=require('./growth-social-publishing').instagramImageUrl(post.imageUrl);const container=await call(encodeURIComponent(x.id)+'/media',{image_url:image,caption:post.text});if(!container.ok)return{...container,uncertain:false,retryable:false};if(!container.data.id)return{ok:false,reason:'instagram_container_receipt_missing'};
   // A processing container is retained for inspection rather than recreated automatically.
   const result=await call(encodeURIComponent(x.id)+'/media_publish',{creation_id:String(container.data.id)});if(!result.ok)return{...result,reason:result.reason+':container_'+container.data.id,retryable:false};
   return result.data.id?{ok:true,receipt:{provider:'instagram',providerPostId:String(result.data.id),containerId:String(container.data.id),status:'published',sandbox:false,publishedAt:new Date().toISOString()}}:{ok:false,reason:'instagram_publication_receipt_missing',uncertain:true};
  });
 }
 return{readiness,publish};
}
module.exports={createProductionMetaProvider};
