'use strict';
// Read-only provider observation + trusted website resolution. Configured URLs alone
// never establish that a clickable profile link exists or preserves attribution.
const {readable}=require('./growth-text-quality');
const {trackingUrl}=require('./growth-platform-copy');
const trusted=u=>u.protocol==='https:'&&!u.username&&!u.password&&['www.fantasymmadness.com','fantasymmadness.com'].includes(u.hostname)&&(!u.port||u.port==='443');
async function verifyProfileDestination({profile,c,ch,fetchImpl=globalThis.fetch,now=new Date()}){
 const fail=reason=>({verified:false,reason,checkedAt:now.toISOString()});
 if(!profile?.verified||!profile.accountId||!profile.website)return fail(profile?.reason||'provider_profile_website_unavailable');
 let u;try{u=new URL(profile.website);}catch{return fail('provider_profile_website_invalid');}if(!trusted(u))return fail('profile_link_host_not_approved');
 const expected=new URL(trackingUrl(c,ch));let matched=false;
 for(let i=0;i<4;i++){
  matched=u.origin===expected.origin&&u.pathname===expected.pathname&&['play','ref','utm_source','utm_medium','utm_campaign','utm_content'].every(k=>u.searchParams.get(k)===expected.searchParams.get(k));
  let r;try{r=await fetchImpl(u.toString(),{method:'GET',redirect:'manual',signal:AbortSignal.timeout(6000)});}catch{return fail('profile_destination_unreachable');}
  if([301,302,303,307,308].includes(r.status)){try{u=new URL(r.headers.get('location'),u);if(!trusted(u))return fail('profile_redirect_host_not_approved');continue;}catch{return fail('profile_redirect_invalid');}}
  if(!r.ok)return fail('profile_destination_unavailable');
  if(!matched){const content=await r.text();if(Buffer.byteLength(content)>1000000)return fail('profile_hub_too_large');const links=[...content.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)].map(m=>readable(m[1]));matched=links.some(raw=>{try{const x=new URL(raw,u);return x.toString()===expected.toString();}catch{return false;}});}
  if(!matched)return fail('profile_destination_not_this_tracked_fight');
  return{verified:true,source:'provider_profile_website',accountId:profile.accountId,profileUrl:profile.website,destinationUrl:expected.toString(),contestId:c.id,checkedAt:now.toISOString()};
 }
 return fail('profile_redirect_limit');
}
function createProfileDestinations({meta,fetchImpl,settings}){
 let observation;
 async function forContest(c,now=new Date()){
  if(!observation||now-Date.parse(observation.checkedAt)>300000){try{observation=meta?.profileWebsite?await meta.profileWebsite():{verified:false,reason:'provider_profile_website_lookup_not_supported',checkedAt:now.toISOString()};}catch{observation={verified:false,reason:'provider_profile_website_lookup_failed',checkedAt:now.toISOString()};}}
  const instagram=await verifyProfileDestination({profile:observation,c,ch:'instagram',fetchImpl,now});
  const result={instagram,tiktok:{verified:false,reason:'tiktok_api_does_not_verify_clickable_website_field'},youtube_shorts:{verified:false,reason:'youtube_channel_profile_destination_not_verified'}};
  if(settings)await settings.updateOne({_id:'caption-destinations:'+c.id},{$set:{at:now.toISOString(),result}},{upsert:true});return result;
 }
 return{forContest};
}
module.exports={verifyProfileDestination,createProfileDestinations};
