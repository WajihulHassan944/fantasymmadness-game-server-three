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
    const url='https://news.google.com/rss/search?q='+encodeURIComponent(genre.q)+'&hl=en-US&gl=US&ceid=US:en';
    const feed=await parser.parseURL(url);
    const opportunities=(feed.items||[]).slice(0,12).map(item=>({
      title:String(item.title||'').slice(0,220),
      url:safeUrl(item.link),
      publishedAt:item.isoDate||item.pubDate||null,
      source:'Google News public feed'
    })).filter(x=>x.url);
    const audiences=(COMMUNITIES[genre.id]||[]).map(([name,url])=>({name,url,type:url.includes('reddit.com')?'public_community':'promoter',status:'candidate_unverified',contactMethod:'Review community rules or official partnership contact',outreachSent:false}));
    const data={id:genre.id,name:genre.name,status:'research_ready',opportunities,audiences,discovered:opportunities.length,audiencesIdentified:audiences.length};
    cache.set(genre.id,{at:now,data});return data;
   }catch(err){return {id:genre.id,name:genre.name,status:'research_unavailable',opportunities:[],audiences:[],discovered:0,audiencesIdentified:0,error:'Public research feed unavailable'};}
  }));
  return result;
 };
 const campaigns=()=>mongoose.connection.db.collection('fan_acquisition_campaigns');
 const createDrafts=async(record)=>{
  const existing=await campaigns().find({runId:String(record._id)}).toArray();
  if(existing.length)return {created:0,campaigns:existing};
  const docs=record.agents.flatMap(agent=>(agent.audiences||[]).map(audience=>({runId:String(record._id),sport:agent.id,sportName:agent.name,sourceTitle:audience.name,sourceUrl:audience.url,audienceType:audience.type,contactMethod:audience.contactMethod,message:"Fight fans: the action is happening now. Put your fight IQ to the test with FANTASY MMADNESS. Predict the punches, rounds and finishes. Don't just watch the fight—predict it! https://www.fantasymmadness.com",status:'awaiting_review',createdAt:new Date(),publishedAt:null,channel:null})));
  if(docs.length)await campaigns().insertMany(docs);
  return {created:docs.length,campaigns:docs};
 };
 const run=async()=>{
  const agents=await discover();
  const record={createdAt:new Date(),agents:agents.map(a=>({id:a.id,name:a.name,status:a.status,discovered:a.discovered,audiences:a.audiences||[],audiencesIdentified:a.audiencesIdentified||0,opportunities:a.opportunities.map(o=>({...o,invitation:'Fight fans: put your fight IQ to the test. Predict the action at https://www.fantasymmadness.com'}))})),mode:'research_only'};
  const saved=await Collection().insertOne(record);
  record._id=saved.insertedId;
  record.campaignDrafts=await createDrafts(record);
  return record;
 };
 app.get('/api/cron/fan-acquisition',async(req,res)=>{
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
 app.get('/api/admin/fan-acquisition/campaigns',verifyAdminToken,async(req,res)=>{
  try{return res.json({ok:true,campaigns:await campaigns().find({}).sort({createdAt:-1}).limit(100).toArray()});}
  catch(e){return res.status(503).json({ok:false,message:'Campaign queue unavailable'});}
 });
 app.get('/api/admin/fan-acquisition/discover',verifyAdminToken,async(req,res)=>{
  try{const last=await Collection().findOne({},{sort:{createdAt:-1}});const agents=last?.agents||await discover();res.set('Cache-Control','private, no-store');return res.json({ok:true,mode:'research_only',lastRunAt:last?.createdAt||null,agents,acquisitionMetrics:{fansReached:null,visitors:null,signups:null,players:null},publishingEnabled:false,note:'Research is not fan acquisition. No automatic social posting is configured.'});}catch(e){return res.status(503).json({ok:false,message:'Fan acquisition data unavailable'});}
 });
};
