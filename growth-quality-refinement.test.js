'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {greetingFor,readable}=require('./growth-text-quality'),{renderPersonalEmail,renderBusinessEmail}=require('./growth-business-email-templates');
const {buildCampaign,verifyContest,checkCampaign}=require('./growth-contest-campaigns'),{RULES,hashTags,trackingUrl}=require('./growth-platform-copy'),{timingFromRegistry}=require('./growth-event-timing'),{verifyProfileDestination}=require('./growth-profile-destinations');
const now=new Date('2026-11-05T00:00:00Z');
const raw={__feed:'prediction',_id:'fixture-123',matchCategory:'boxing',matchFighterA:'Naoya Inoue',matchFighterB:'Murodjon Akhmadaliev',matchStatus:'Open',matchType:'LIVE',matchDate:'2026-11-14T00:00:00Z',matchDateKey:'2026-11-14',matchTime:'20:00',eventTimeZone:'America/New_York',timeTba:false};
const c=verifyContest(raw,{now}).contest;
test('greetings require a verified personal identity, never mailbox/show/author inference',()=>{
 for(const name of ['Open','Info','Support','Contact','Acme Media','Cami’s Kickboxing Podcast','Dana Smith'])assert.equal(greetingFor({email:'info@fixture.example',name},{title:'Show'}),'Hi,');
 assert.equal(greetingFor({email:'dana@fixture.example',name:'Dana Smith'},{title:'Dana Smith'}),'Hi,');
 const person={email:'dana@fixture.example',name:'Dana Smith',type:'person',nameVerified:true,nameSource:'https://fixture.example/team'};assert.equal(greetingFor(person,{title:'Fighting Show'}),'Hi Dana,');
 for(const name of ['Open','Info','Support','Contact','Acme Media','A Podcast'])assert.equal(greetingFor({...person,name}),'Hi,');
 assert.match(renderBusinessEmail({recipientName:'Open'}).text,/\n\nHi,/);
});
test('entities decode before escaping exactly once, including nested encodings and hostile markup',()=>{
 const m=renderPersonalEmail({subject:'Boxing &amp;amp; MMA &#8212; “News”\r\nBcc: nope',greeting:'Hi,',paragraphs:['Fight &amp; Fitness &#x26; Boxing','&lt;script&gt;alert(1)&lt;/script&gt;'],cta:{label:'Join &amp; review',url:'https://www.fantasymmadness.com/auth?mode=signup&role=affiliate&utm_campaign=fixture'}});
 assert.ok(m.subject.includes('Boxing & MMA'));assert.ok(!/[\r\n]|&amp;/.test(m.subject));assert.ok(m.text.includes('Fight & Fitness & Boxing'));assert.ok(m.html.includes('Fight &amp; Fitness &amp; Boxing'));assert.ok(!m.html.includes('&amp;amp;'));assert.ok(!m.html.includes('<script>'));assert.ok(m.html.includes('&lt;script&gt;'));assert.ok(m.html.includes('role=affiliate&amp;utm_campaign=fixture'));assert.ok(m.html.includes('Join &amp; review'));
});
test('all five captions use relevant hashtag budgets, complete names, branding and platform-correct attribution',()=>{
 const d={kind:'marketing',genre:c.sport,contestId:c.id,channels:['facebook','x'],...buildCampaign(c,{now})};
 for(const [ch,r]of Object.entries(RULES)){const p=d.platformCopy[ch];assert.ok(p.caption.includes(c.fighterA)&&p.caption.includes(c.fighterB));assert.ok(p.caption.includes('FANTASY MMADNESS'));assert.ok(hashTags(p.caption).length>=r.min&&hashTags(p.caption).length<=r.max);assert.ok(p.length<=r.limit);if(['facebook','x'].includes(ch))assert.ok(p.caption.includes(trackingUrl(c,ch)));else{assert.ok(!/https?:\/\//.test(p.caption));assert.ok(!/Link in bio/i.test(p.caption));assert.equal(p.ready,false);}}
 assert.deepEqual(checkCampaign(d,c,{now}),[]);assert.ok(d.posts.youtube_shorts);assert.ok([...d.platformCopy.youtube_shorts.title].length<=100);
 const wrong=structuredClone(d);wrong.posts.x+=' #fyp';assert.ok(checkCampaign(wrong,c,{now}).includes('x_irrelevant_hashtag'));
 const badTime=structuredClone(d);badTime.posts.facebook+='\nEvent starts at 9 PM';assert.ok(checkCampaign(badTime,c,{now}).includes('caption_event_time_unverified'));
 const long=structuredClone(d);long.posts.x+='漢'.repeat(140);assert.ok(checkCampaign(long,c,{now}).includes('x_caption_too_long_or_invalid'));
 const tampered=structuredClone(d);tampered.posts.facebook=tampered.posts.facebook.replace('utm_content=facebook','utm_content=instagram');assert.ok(checkCampaign(tampered,c,{now}).includes('facebook_tracked_fight_link_missing'));
});
test('Link in bio requires current provider-observed website and exact campaign destination; configs and wrong identities do not qualify',async()=>{
 const url=trackingUrl(c,'instagram');const fetchImpl=async()=>({ok:true,status:200,text:async()=>'<html>fight</html>'});
 const proof=await verifyProfileDestination({profile:{verified:true,accountId:'178414000000000',website:url},c,ch:'instagram',fetchImpl,now});assert.equal(proof.verified,true);
 const k=buildCampaign(c,{now,destinations:{instagram:proof}});assert.match(k.posts.instagram,/Link in bio/);assert.ok(!k.posts.instagram.includes('https://'));assert.equal(k.platformCopy.instagram.ready,true);
 const bad=await verifyProfileDestination({profile:{verified:true,accountId:'178414000000000',website:'https://www.fantasymmadness.com/'},c,ch:'instagram',fetchImpl,now});assert.equal(bad.verified,false);assert.equal(bad.reason,'profile_destination_not_this_tracked_fight');
 assert.equal((await verifyProfileDestination({profile:{verified:false,website:url},c,ch:'instagram',fetchImpl,now})).verified,false);
 assert.ok(!/Link in bio/.test(buildCampaign(c,{now:new Date(+now+301000),destinations:{instagram:proof}}).posts.instagram));
 assert.equal((await verifyProfileDestination({profile:{verified:true,accountId:'1',website:'https://127.0.0.1/'},c,ch:'instagram',fetchImpl,now})).reason,'profile_link_host_not_approved');
});
test('event starts require explicit evidence, cutoff is separate, inconsistent metadata blocks approval',()=>{
 assert.equal(c.timing.eventTimeVerified,false);assert.ok(c.timing.entryCutoffAt);assert.ok(!/8:00|20:00/.test(buildCampaign(c,{now}).text));
 const t=timingFromRegistry({...raw,eventStartAt:'2026-11-15T01:00:00Z',eventTimeVerified:true,eventTimeSourceUrl:'https://official.example/event'});assert.equal(t.eventTimeVerified,true);assert.deepEqual(t.errors,[]);
 const inconsistent={...c,timing:timingFromRegistry({...raw,eventStartAt:'2026-11-14T22:00:00Z',eventTimeVerified:true,eventTimeSourceUrl:'https://official.example/event'})};assert.ok(checkCampaign({kind:'marketing',genre:c.sport,contestId:c.id,...buildCampaign(inconsistent,{now})},inconsistent,{now}).includes('entry_cutoff_after_event_start'));
 for(const extra of [{matchTime:'99:99'},{eventTimeZone:'Mars/Phobos'},{matchDateKey:'2026-11-15'},{timeTba:true,matchTime:'20:00'}])assert.ok(timingFromRegistry({...raw,...extra}).errors.length);
});
