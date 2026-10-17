'use strict';
// Five-genre public research feed. Does not scrape private people or post without approval.
const Parser=require('rss-parser');
const parser=new Parser({timeout:9000,headers:{'User-Agent':'FANTASYMMADNESS-FanResearch/1.0'}});
const GENRES=[
 {id:'boxing',name:'Boxing',q:'boxing fight boxing championship upcoming'},
 {id:'mma',name:'MMA / UFC',q:'UFC MMA fight upcoming'},
 {id:'bare-knuckle',name:'Bare Knuckle',q:'BKFC bare knuckle boxing upcoming'},
 {id:'kickboxing',name:'Kickboxing / Muay Thai',q:'kickboxing Muay Thai ONE Championship upcoming'},
 {id:'wrestling',name:'Pro Wrestling',q:'WWE AEW pro wrestling upcoming'}
];
const COMMUNITIES={
 boxing:[['r/Boxing','https://www.reddit.com/r/Boxing/'],['r/BoxingDiscussion','https://www.reddit.com/r/BoxingDiscussion/']],
 mma:[['r/MMA','https://www.reddit.com/r/MMA/'],['r/ufc','https://www.reddit.com/r/ufc/']],
 'bare-knuckle':[['BKFC official','https://www.bkfc.com/']],
 kickboxing:[['r/MuayThai','https://www.reddit.com/r/MuayThai/'],['r/Kickboxing','https://www.reddit.com/r/Kickboxing/']],
 wrestling:[['r/SquaredCircle','https://www.reddit.com/r/SquaredCircle/'],['r/WWE','https://www.reddit.com/r/WWE/']]
};
const FIGHTER_NETWORKS={
 boxing:[
 ['USA Boxing Alumni Association','https://www.usaboxing.org/alumni','alumni_network'],
 ['British Boxing Board Ex-Boxers Associations','https://w.bbbofc.com/exboxer','veteran_fighter_network'],
 ['Veteran Boxers Association Ring One','https://www.vbaringone.com/about','veteran_fighter_network'],
 ['IBA Champions and Veterans Committee','https://www.iba.sport/about-iba/organizational-structure/committees/technical-management-committees/champions-and-veterans-committee/','veteran_fighter_network']
 ],
 mma:[], 'bare-knuckle':[], kickboxing:[], wrestling:[]
};
const fighterNetworks=genre=>(FIGHTER_NETWORKS[genre.id]||[]).map(([name,url,type])=>({
 name,url,type,status:'directory_candidate_unverified',source:'Public fighter/alumni organization directory',
 contactMethod:'Approach organization publicly for an introduction; invite individual fighters to opt in',
 proposedRole:'fighter_affiliate',affiliateStatus:'not_invited',outreachSent:false
}));
const VIDEO_QUERIES={
 boxing:'boxing fight predictions breakdown',
 mma:'UFC MMA fight predictions breakdown',
 'bare-knuckle':'BKFC bare knuckle fight predictions',
 kickboxing:'Muay Thai kickboxing fight predictions',
 wrestling:'WWE AEW wrestling match predictions'
};
const youtubeDiscover=async genre=>{
 if(!process.env.YOUTUBE_API_KEY)return {status:'not_configured',audiences:[]};
 const params=new URLSearchParams({part:'snippet',type:'channel',q:VIDEO_QUERIES[genre.id],maxResults:'8',order:'relevance',key:process.env.YOUTUBE_API_KEY});
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),6500);
 try{
  const response=await fetch('https://www.googleapis.com/youtube/v3/search?'+params,{signal:controller.signal});
  if(!response.ok)return {status:'provider_error_'+response.status,audiences:[]};
  const body=await response.json();
  return {status:'searched',audiences:(body.items||[]).filter(item=>item.id?.channelId).map(item=>({
   name:item.snippet?.channelTitle||item.snippet?.title||'YouTube channel',
   url:'https://www.youtube.com/channel/'+encodeURIComponent(item.id.channelId),
   type:'youtube_creator',status:'candidate_unverified',source:'YouTube Data API search',
   contactMethod:'Review public creator business contact and partnership terms',
   evidence:item.snippet?.description?.slice(0,220)||'',outreachSent:false
  }))};
 }catch(e){return {status:'provider_unavailable',audiences:[]};}
 finally{clearTimeout(timer);}
};
const podcastDiscover=async genre=>{
 const query=({boxing:'boxing podcast',mma:'MMA UFC podcast','bare-knuckle':'bare knuckle boxing podcast',kickboxing:'Muay Thai kickboxing podcast',wrestling:'professional wrestling WWE podcast'})[genre.id];
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),6500);
 try{
  const u='https://itunes.apple.com/search?'+new URLSearchParams({term:query,media:'podcast',entity:'podcast',country:'US',limit:'15'});
  const r=await fetch(u,{signal:controller.signal,headers:{'User-Agent':'FANTASYMMADNESS-Research/1.0'}});
  if(!r.ok)return {status:'provider_error_'+r.status,audiences:[]};
  const body=await r.json();
  const audiences=(body.results||[]).filter(p=>p.collectionName && safeUrl(p.collectionViewUrl||p.feedUrl)).map(p=>({
   name:String(p.collectionName).slice(0,160),url:safeUrl(p.collectionViewUrl||p.feedUrl),
   type:'podcast_creator',status:'candidate_unverified',source:'Apple Podcasts public search',
   evidence:String(p.artistName||'').slice(0,120),contactMethod:'Review podcast public website or business contact',
   outreachSent:false
  }));
  return {status:'searched',audiences};
 }catch(e){return {status:'provider_unavailable',audiences:[]};}
 finally{clearTimeout(timer);}
};
const cache=new Map();
const safeUrl=url=>{try{const u=new URL(url);return ['https:','http:'].includes(u.protocol)?u.href:null;}catch{return null;}};
module.exports=({app,verifyAdminToken,mongoose})=>{
 const Collection=()=>mongoose.connection.db.collection('fan_acquisition_runs');
 const discover=async()=>{

  const now=Date.now();
  const result=await Promise.all(GENRES.map(async genre=>{
   const cached=cache.get(genre.id);
   if(cached && now-cached.at<15*60*1000)return cached.data;
   try{
    const [video,podcasts]=await Promise.all([youtubeDiscover(genre),podcastDiscover(genre)]);
    const url='https://news.google.com/rss/search?q='+encodeURIComponent(genre.q)+'&hl=en-US&gl=US&ceid=US:en';
    const feed=await parser.parseURL(url);
    const opportunities=(feed.items||[]).slice(0,12).map(item=>({
      title:String(item.title||'').slice(0,220),
      url:safeUrl(item.link),
      publishedAt:item.isoDate||item.pubDate||null,
      source:'Google News public feed'
    })).filter(x=>x.url);
    const directory=(COMMUNITIES[genre.id]||[]).map(([name,url])=>({name,url,type:url.includes('reddit.com')?'public_community':'promoter',status:'directory_candidate_unverified',source:'Curated starting directory',contactMethod:'Review community rules or official partnership contact',outreachSent:false}));
    const audiences=[...video.audiences,...podcasts.audiences,...directory,...fighterNetworks(genre)].filter((a,i,all)=>all.findIndex(b=>b.url===a.url)===i);
    const data={id:genre.id,name:genre.name,status:'research_ready',videoSearchStatus:video.status,podcastSearchStatus:podcasts.status,opportunities,audiences,discovered:opportunities.length,audiencesIdentified:audiences.length};
    cache.set(genre.id,{at:now,data});return data;
   }catch(err){const podcasts=await podcastDiscover(genre);const directory=(COMMUNITIES[genre.id]||[]).map(([name,url])=>({name,url,type:url.includes('reddit.com')?'public_community':'promoter',status:'directory_candidate_unverified',source:'Curated starting directory',contactMethod:'Review community rules or official partnership contact',outreachSent:false}));const audiences=[...podcasts.audiences,...directory,...fighterNetworks(genre)];return {id:genre.id,name:genre.name,status:audiences.length?'partial_research_ready':'research_unavailable',podcastSearchStatus:podcasts.status,videoSearchStatus:'unavailable',opportunities:[],audiences,discovered:0,audiencesIdentified:audiences.length,error:'News research feed unavailable; alternative audience discovery attempted'};}
  }));
  return result;
 };
 const campaigns=()=>mongoose.connection.db.collection('fan_acquisition_campaigns');
 const audienceStore=()=>mongoose.connection.db.collection('fan_acquisition_audiences');
 const createDrafts=async(record)=>{
  const existing=await campaigns().find({runId:String(record._id)}).toArray();
  if(existing.length)return {created:0,campaigns:existing};
  const docs=record.agents.flatMap(agent=>(agent.audiences||[]).map(audience=>({runId:String(record._id),sport:agent.id,sportName:agent.name,sourceTitle:audience.name,sourceUrl:audience.url,audienceType:audience.type,proposedRole:audience.proposedRole||'audience_partner',contactMethod:audience.contactMethod,message:"Fight fans: the action is happening now. Put your fight IQ to the test with FANTASY MMADNESS. Predict the punches, rounds and finishes. Don't just watch the fight—predict it! https://www.fantasymmadness.com",status:audience.proposedRole==='fighter_affiliate'?'affiliate_invitation_ready':'awaiting_outreach_review',requiresOwnerApproval:false,commercialProposal:false,ownerApprovedAt:null,createdAt:new Date(),publishedAt:null,channel:null})));
  if(docs.length)await campaigns().insertMany(docs);
  return {created:docs.length,campaigns:docs};
 };
 const run=async()=>{
  const agents=await discover();
  const record={createdAt:new Date(),agents:agents.map(a=>({id:a.id,name:a.name,status:a.status,videoSearchStatus:a.videoSearchStatus||'not_configured',podcastSearchStatus:a.podcastSearchStatus||'unavailable',discovered:a.discovered,audiences:a.audiences||[],audiencesIdentified:a.audiencesIdentified||0,opportunities:a.opportunities.map(o=>({...o,invitation:'Fight fans: put your fight IQ to the test. Predict the action at https://www.fantasymmadness.com'}))})),mode:'research_only'};
  const saved=await Collection().insertOne(record);
  record._id=saved.insertedId;
  const candidates=record.agents.flatMap(agent=>(agent.audiences||[]).map(a=>({...a,sport:agent.id,sportName:agent.name,updatedAt:new Date()})));
  if(candidates.length)await Promise.all(candidates.map(a=>audienceStore().updateOne({sport:a.sport,url:a.url},{$set:a,$setOnInsert:{firstSeenAt:new Date(),outreachStatus:'not_contacted'}},{upsert:true})));
  record.campaignDrafts=await createDrafts(record);
  return record;
 };
 // Standard affiliate invitations follow published signup terms and need no owner approval.\n // Custom revenue shares, promoter deals, sponsorships and commercial commitments require owner approval.\n // No outbound sending is configured here; review states do not imply messages were sent.\n app.get('/api/cron/fan-acquisition',async(req,res)=>{
  if(!process.env.CRON_SECRET || req.headers.authorization!=='Bearer '+process.env.CRON_SECRET)return res.status(401).json({ok:false});
  try{const record=await run();return res.json({ok:true,createdAt:record.createdAt,agents:record.agents.map(a=>({id:a.id,status:a.status,discovered:a.discovered,audiencesIdentified:a.audiencesIdentified}))});}catch(e){return res.status(503).json({ok:false,message:'Research run could not be saved'});}
 });
 app.post('/api/admin/fan-acquisition/run',verifyAdminToken,async(req,res)=>{
  try{const record=await run();return res.json({ok:true,createdAt:record.createdAt,agents:record.agents});}catch(e){return res.status(503).json({ok:false,message:'Research run could not be saved'});}
 });
 app.post('/api/admin/fan-acquisition/campaigns/generate',verifyAdminToken,async(req,res)=>{
  try{
   const last=await Collection().findOne({},{sort:{createdAt:-1}});
   if(!last)return res.status(409).json({ok:false,message:'Run all five research agents first.'});
   const result=await createDrafts(last);
   return res.json({ok:true,...result});
  }catch(e){return res.status(503).json({ok:false,message:'Campaign generation unavailable'});}
 });
 app.get('/api/admin/fan-acquisition/audiences',verifyAdminToken,async(req,res)=>{
  try{return res.json({ok:true,audiences:await audienceStore().find({}).sort({updatedAt:-1}).limit(150).toArray()});}catch(e){return res.status(503).json({ok:false,message:'Audience pipeline unavailable'});}
 });
 app.get('/api/admin/fan-acquisition/campaigns',verifyAdminToken,async(req,res)=>{
  try{return res.json({ok:true,campaigns:await campaigns().find({}).sort({createdAt:-1}).limit(100).toArray()});}
  catch(e){return res.status(503).json({ok:false,message:'Campaign queue unavailable'});}
 });
 app.get('/api/admin/fan-acquisition/discover',verifyAdminToken,async(req,res)=>{
  try{const last=await Collection().findOne({},{sort:{createdAt:-1}});const agents=last?.agents||await discover();res.set('Cache-Control','private, no-store');return res.json({ok:true,mode:'research_only',lastRunAt:last?.createdAt||null,agents,acquisitionMetrics:{fansReached:null,visitors:null,signups:null,players:null},publishingEnabled:false,note:'Research is not fan acquisition. No automatic social posting is configured.'});}catch(e){return res.status(503).json({ok:false,message:'Fan acquisition data unavailable'});}
 });
};
