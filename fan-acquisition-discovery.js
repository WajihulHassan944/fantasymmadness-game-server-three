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
const cache=new Map();
const safeUrl=url=>{try{const u=new URL(url);return ['https:','http:'].includes(u.protocol)?u.href:null;}catch{return null;}};
module.exports=({app,verifyAdminToken})=>{
 app.get('/api/admin/fan-acquisition/discover',verifyAdminToken,async(req,res)=>{
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
    const data={id:genre.id,name:genre.name,status:'research_ready',opportunities,discovered:opportunities.length};
    cache.set(genre.id,{at:now,data});return data;
   }catch(err){return {id:genre.id,name:genre.name,status:'research_unavailable',opportunities:[],discovered:0,error:'Public research feed unavailable'};}
  }));
  res.set('Cache-Control','private, no-store');
  res.json({ok:true,mode:'research_only',agents:result,acquisitionMetrics:{fansReached:null,visitors:null,signups:null,players:null},publishingEnabled:false,note:'Public news research is not evidence of outreach, fan contact, or acquisition.'});
 });
};
