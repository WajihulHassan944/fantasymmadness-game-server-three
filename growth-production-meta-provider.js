'use strict';
// Reuses the selected original encrypted Page authorization; never writes credentials.
const {createTokenVault}=require('./growth-token-vault');
const {createExistingMetaReadOnly}=require('./growth-existing-meta-readonly');
function createProductionMetaProvider({withSource,env,fetchImpl=globalThis.fetch}={}){
 async function verified(db){const reader=createExistingMetaReadOnly({db,env,fetchImpl});const [s,p]=await Promise.all([reader.status({force:true}),reader.permissions()]);return{s,p};}
 async function readiness(){try{return await withSource(async db=>{const {s,p}=await verified(db);return Object.fromEntries(['facebook','instagram'].map(channel=>{const x=s.platforms[channel],scope=channel==='facebook'?'pages_manage_posts':'instagram_content_publish';return[channel,{ready:x.verified===true&&p.verified===true&&p.granted.includes(scope),destinationId:x.id||null,name:x.name||x.username||null,checkedAt:s.health.checkedAt,blockers:!x.verified?[x.reason||'identity_not_verified']:!p.verified?[p.reason||'provider_permissions_unverified']:!p.granted.includes(scope)?['provider_scope_required:'+scope]:[]}];}));});}catch{return{facebook:{ready:false,blockers:['existing_meta_verification_unavailable']},instagram:{ready:false,blockers:['existing_meta_verification_unavailable']}};}}
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
   async function publicationReceipt(id,response,extra={}){
    const receipt={provider:channel,providerPostId:id,accountId:x.id,accountName:x.name||x.username||null,status:'published',sandbox:false,publishedAt:new Date().toISOString(),providerResponse:response,...extra};
    try{
     const fields=channel==='facebook'?'id,permalink_url,created_time':'id,permalink,timestamp';
     const r=await fetchImpl(graph+encodeURIComponent(id)+'?fields='+encodeURIComponent(fields),{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(20000)});
     const data=await r.json();
     if(!r.ok||data.error||String(data.id)!==id)throw Error('publication_readback_failed');
     const url=new URL(data.permalink_url||data.permalink);
     const hosts=channel==='facebook'?['facebook.com','www.facebook.com']:['instagram.com','www.instagram.com'];
     if(url.protocol!=='https:'||!hosts.includes(url.hostname)||url.username||url.password)throw Error('public_permalink_unverified');
     receipt.publicPermalink=url.href;receipt.providerPublishedAt=data.created_time||data.timestamp||null;receipt.readbackVerified=true;
    }catch{receipt.readbackVerified=false;receipt.readbackError='publication_readback_unavailable';}
    // A successful mutation is never retried because a readback failed.
    return{ok:true,receipt};
   }
   if(channel==='facebook'){const r=await call(encodeURIComponent(x.id)+'/photos',{url:post.imageUrl,caption:post.text});if(!r.ok)return r;const id=String(r.data.post_id||r.data.id||'');return id?await publicationReceipt(id,{post_id:r.data.post_id||null,id:r.data.id||null}):{ok:false,reason:'meta_post_receipt_missing',uncertain:true};}
   const image=require('./growth-social-publishing').instagramImageUrl(post.imageUrl);const container=await call(encodeURIComponent(x.id)+'/media',{image_url:image,caption:post.text});if(!container.ok)return{...container,uncertain:false,retryable:false};if(!container.data.id)return{ok:false,reason:'instagram_container_receipt_missing'};
   // A processing container is retained for inspection rather than recreated automatically.
   const result=await call(encodeURIComponent(x.id)+'/media_publish',{creation_id:String(container.data.id)});if(!result.ok)return{...result,reason:result.reason+':container_'+container.data.id,retryable:false};
   return result.data.id?await publicationReceipt(String(result.data.id),{id:result.data.id},{containerId:String(container.data.id)}):{ok:false,reason:'instagram_publication_receipt_missing',uncertain:true};
  });
 }
 // Read-only verification summary (identity + granted permissions). No token renewal, no credential
 // write, nothing published. Cached for 5 minutes; force=true performs a fresh provider check.
 let lastVerify=null,lastVerifyAt=0;
 async function verify({force=false}={}){
  if(!force&&lastVerify&&Date.now()-lastVerifyAt<300000)return lastVerify;
  try{return await withSource(async db=>{
   const reader=createExistingMetaReadOnly({db,env,fetchImpl});const [s,p]=await Promise.all([reader.status({force}),reader.permissions()]);
   const pick=(x,extra)=>({verified:x?.verified===true,state:x?.state||null,reason:x?.verified===true?null:x?.reason||null,id:x?.verified===true?String(x.id):null,...extra});
   const out={checkedAt:s.health?.checkedAt||new Date().toISOString(),selected:s.selected?{pageId:s.selected.pageId||null,pageName:s.selected.pageName||null,igUserId:s.selected.igUserId||null,igUsername:s.selected.igUsername||null}:null,
    facebook:pick(s.platforms?.facebook,{name:s.platforms?.facebook?.verified?s.platforms.facebook.name||null:null}),
    instagram:pick(s.platforms?.instagram,{username:s.platforms?.instagram?.verified?s.platforms.instagram.username||null:null}),
    permissions:p?.verified===true?{verified:true,granted:p.granted||[],checkedAt:p.checkedAt||null}:{verified:false,reason:p?.reason||'permission_evidence_unavailable'}};
   lastVerify=out;lastVerifyAt=Date.now();return out;
  });}catch{return{checkedAt:new Date().toISOString(),facebook:{verified:false,reason:'existing_meta_verification_unavailable'},instagram:{verified:false,reason:'existing_meta_verification_unavailable'},permissions:{verified:false,reason:'existing_meta_verification_unavailable'}};}
 }
 return{readiness,publish,verify};
}
module.exports={createProductionMetaProvider};
