'use strict';
// Verify served staging JPEGs inside the owner's staging backend. Never return
// artwork, image IDs, fighter metadata, QR payloads or authorization headers.
const crypto=require('node:crypto');
const {decodeQr,RENDER_VERSION}=require('./growth-poster-studio');
function createPosterHttpHealth({db,origin,fetchImpl=globalThis.fetch,clock=()=>new Date()}){
 if(db.databaseName!=='fmgrowthtest')throw Error('isolated_database_required');
 const site=new URL(origin);if(site.protocol!=='https:'||['fantasymmadness.com','www.fantasymmadness.com'].includes(site.hostname))throw Error('isolated_origin_required');
 const settings=db.collection('preview198_growth_settings');let flight;
 async function inspect(){
  const drafts=await db.collection('preview198_growth_drafts').find({kind:'marketing',status:'needs_owner_review','poster.renderVersion':RENDER_VERSION,'poster.status':'ready','poster.needsArtwork':false},{projection:{id:1,contestFingerprint:1,poster:1}}).sort({id:1}).limit(2).toArray();
  const signature=crypto.createHash('sha256').update(JSON.stringify(drafts.map(d=>[d.contestFingerprint,d.poster.portrait.id,d.poster.story.id,d.poster.qrUrl]))).digest('hex');
  const cached=await settings.findOne({_id:'poster-http-health'});if(cached?.signature===signature&&clock()-new Date(cached.checkedAt)<300000)return cached.result;
  const result={checkedAt:clock().toISOString(),checked:0,passed:0,failed:0,technicalErrors:[],imagesExported:false};
  for(const d of drafts)for(const format of ['portrait','story']){
   result.checked++;try{
    const id=d.poster[format]?.id;if(!/^[a-f0-9]{20}-(portrait|story)$/.test(id||''))throw Error('invalid_poster_reference');
    const stored=await db.collection('preview198_growth_posters').findOne({id,withdrawnAt:{$exists:false}},{projection:{sha256:1,width:1,height:1}});if(!stored)throw Error('stored_poster_missing');
    const r=await fetchImpl(site.origin+'/api/growth/posters/'+id+'.jpg',{redirect:'error',signal:AbortSignal.timeout(8000)});if(!r.ok||!/^image\/jpeg(?:;|$)/.test(r.headers.get('content-type')||''))throw Error('served_poster_unavailable');
    const b=Buffer.from(await r.arrayBuffer());if(b.length<20000||b.length>12000000||crypto.createHash('sha256').update(b).digest('hex')!==stored.sha256)throw Error('served_poster_integrity_failed');
    const md=await require('sharp')(b).metadata();if(md.format!=='jpeg'||md.width!==1080||md.height!==(format==='portrait'?1350:1920))throw Error('served_poster_dimensions_failed');
    const qr=await decodeQr(b);if(!qr.ok||qr.text!==d.poster.qrUrl)throw Error('served_poster_qr_failed');result.passed++;
   }catch(e){result.failed++;const safe=['invalid_poster_reference','stored_poster_missing','served_poster_unavailable','served_poster_integrity_failed','served_poster_dimensions_failed','served_poster_qr_failed'];const reason=safe.includes(e.message)?e.message:'served_poster_check_unavailable';if(!result.technicalErrors.includes(reason))result.technicalErrors.push(reason);}
  }
  await settings.updateOne({_id:'poster-http-health'},{$set:{signature,checkedAt:result.checkedAt,result}},{upsert:true});return result;
 }
 return{check:()=>flight||=(inspect().finally(()=>{flight=null;}))};
}
module.exports={createPosterHttpHealth};
