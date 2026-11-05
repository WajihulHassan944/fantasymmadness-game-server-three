'use strict';
const twitter=require('twitter-text');
const {readable}=require('./growth-text-quality');
const {timeLabel,validateTiming,captionTimeErrors}=require('./growth-event-timing');
const VERSION=2;
const RULES={instagram:{min:3,max:5,limit:2200},facebook:{min:2,max:4,limit:2200},tiktok:{min:3,max:5,limit:2200},x:{min:1,max:2,limit:280},youtube_shorts:{min:3,max:5,limit:5000}};
const SPORT={boxing:'Boxing','mma-ufc':'MMA',kickboxing:'Kickboxing','bare-knuckle':'BareKnuckle','pro-wrestling':'ProWrestling'};
const tag=s=>String(s||'').normalize('NFC').replace(/[^\p{L}\p{M}\p{N}_]/gu,'');
const hashTags=s=>String(s||'').match(/#[\p{L}\p{M}\p{N}_]+/gu)||[];
function trackingUrl(c,ch){const u=new URL(c.contestUrl);u.searchParams.set('utm_source','fan_acquisition');u.searchParams.set('utm_medium','partner_outreach');u.searchParams.set('utm_campaign','combat_fans_gs_'+c.sport.replace(/[^a-z0-9]+/g,'_'));u.searchParams.set('utm_content',ch);return u.toString();}
function destinationValid(d,c,ch,now=new Date()){
 if(!d||d.verified!==true||d.source!=='provider_profile_website'||!d.accountId||d.contestId!==c.id||!d.checkedAt||now-Date.parse(d.checkedAt)<0||now-Date.parse(d.checkedAt)>300000)return false;
 try{const u=new URL(d.destinationUrl),target=new URL(trackingUrl(c,ch));return u.origin===target.origin&&u.pathname===target.pathname&&['play','ref','utm_source','utm_medium','utm_campaign','utm_content'].every(k=>u.searchParams.get(k)===target.searchParams.get(k));}catch{return false;}
}
function buildPlatformCopy(c,{destinations={},now=new Date()}={}){
 const vs=readable(`${c.fighterA} vs ${c.fighterB}`),sport=SPORT[c.sport]||c.sport;
 const subject=[vs,readable(c.eventName),sport==='MMA'?'MMA':sport.replace(/([a-z])([A-Z])/g,'$1 $2'),c.dateKey].filter(Boolean).join(' | ');
 const allTags=[...new Set(['FANTASYMMADNESS',sport,tag(c.fighterA),tag(c.fighterB),tag(c.promotion)].filter(Boolean))];
 const posts={},platformCopy={};
 for(const [ch,rule]of Object.entries(RULES)){
  const hashtags=(ch==='x'?[sport,'FANTASYMMADNESS']:ch==='facebook'?allTags.slice(0,3):allTags.slice(0,5)).map(t=>'#'+t);
  const verified=destinationValid(destinations[ch],c,ch,now),url=trackingUrl(c,ch);
  const direct=ch==='facebook'||ch==='x';
  const cta=direct?`Make your picks on FANTASY MMADNESS: ${url}`:verified?(ch==='instagram'||ch==='tiktok'?'Link in bio — make your picks on FANTASY MMADNESS.':'Use the verified channel profile link for this FANTASY MMADNESS fight.'):`Find ${vs} on FANTASY MMADNESS.`;
  const details=[[c.venue,c.city].filter(Boolean).join(', '),c.maxRounds?c.maxRounds+' rounds':null,c.weightClass,c.promotion].filter(Boolean).join(' · ');
  const play=c.sport==='pro-wrestling'?'Make your match picks on FANTASY MMADNESS.':'Make your round-by-round picks on FANTASY MMADNESS.';
  let parts=[subject,timeLabel(c),details,play,cta,hashtags.join(' ')];
  if(ch==='x'){parts=[subject,play,url,hashtags.join(' ')];if(twitter.parseTweet(parts.join('\n')).weightedLength>280)parts=[`${vs} | ${sport} | ${c.dateKey}`,'FANTASY MMADNESS — round-by-round picks.',url,hashtags.join(' ')];}
  posts[ch]=parts.filter(Boolean).join('\n\n');
  const blockers=[];if(!direct&&!verified)blockers.push('verified_profile_destination_required');if(ch==='youtube_shorts')blockers.push('youtube_publishing_not_connected');
  platformCopy[ch]={caption:posts[ch],cta,hashtags,trackingUrl:url,destination:verified?destinations[ch]:null,ready:blockers.length===0,blockers,...(ch==='youtube_shorts'?{title:`${vs} | FANTASY MMADNESS`}:{}),length:ch==='x'?twitter.parseTweet(posts[ch]).weightedLength:ch==='youtube_shorts'?Buffer.byteLength(posts[ch],'utf8'):posts[ch].length};
 }
 return {copyVersion:VERSION,posts,platformCopy,text:posts.instagram,link:trackingUrl(c,'instagram')};
}
function validatePlatformCopy(d,c,{now=new Date()}={}){
 const e=[];
 for(const [ch,p]of Object.entries(d.platformCopy||{})){
  const rule=RULES[ch];if(!rule){e.push(ch+'_unsupported_caption');continue;}
  const text=d.posts?.[ch]||'',tags=hashTags(text),allowed=new Set(['FANTASYMMADNESS',SPORT[c.sport],tag(c.fighterA),tag(c.fighterB),tag(c.promotion)].filter(Boolean));
  if(tags.length<rule.min||tags.length>rule.max)e.push(ch+'_hashtag_count');
  if(tags.some(t=>!allowed.has(t.slice(1))))e.push(ch+'_irrelevant_hashtag');
  const n=ch==='x'?twitter.parseTweet(text).weightedLength:ch==='youtube_shorts'?Buffer.byteLength(text,'utf8'):text.length;
  if(n>rule.limit||ch==='x'&&!twitter.parseTweet(text).valid)e.push(ch+'_caption_too_long_or_invalid');
  e.push(...captionTimeErrors(text,c));
  if(ch==='youtube_shorts'&&([...String(p.title||'')].length>100||/[<>]/.test(text+p.title)))e.push(ch+'_metadata_invalid');
  if(['facebook','x'].includes(ch)){
   let found=false;for(const raw of text.match(/https:\/\/[^\s]+/g)||[]){try{const u=new URL(raw),v=new URL(trackingUrl(c,ch));if(u.origin===v.origin&&[c.contestUrl,c.idUrl,c.cleanUrl].filter(Boolean).some(base=>new URL(base).pathname===u.pathname)&&['play','ref','utm_source','utm_medium','utm_campaign','utm_content'].every(k=>u.searchParams.get(k)===v.searchParams.get(k)))found=true;}catch{}}
   if(!found)e.push(ch+'_tracked_fight_link_missing');
  }else{
   const verified=destinationValid(p.destination,c,ch,now);
   if(/https?:\/\/\S+/i.test(text))e.push(ch+'_nonclickable_caption_url');
   if(/link in bio|verified channel profile link/i.test(text)&&!verified)e.push(ch+'_profile_link_not_verified');
   if((d.channels||[]).includes(ch)&&!verified)e.push(ch+'_destination_not_ready');
  }
 }
 return [...new Set([...e,...validateTiming(c)])];
}
module.exports={VERSION,RULES,buildPlatformCopy,validatePlatformCopy,trackingUrl,destinationValid,hashTags};
