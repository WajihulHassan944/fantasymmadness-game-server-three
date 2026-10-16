'use strict';
// Passive HTTP failure telemetry. Never changes the response or legacy business logic.
const mongoose = require('mongoose');
const crypto = require('crypto');
const { URL } = require('url');
const schema = new mongoose.Schema({
  key:{type:String,unique:true,index:true},source:String,severity:String,title:String,
  description:String,affectedType:String,affectedId:String,actionUrl:String,
  status:{type:String,default:'open'},occurrences:{type:Number,default:1},
  firstSeen:Date,lastSeen:Date,resolvedAt:Date,resolutionNote:String
},{timestamps:true});
const Incident=mongoose.models.AdminIncident||mongoose.model('AdminIncident',schema);
const routeFor=(pathname)=>{
  // Only map a record when the request carries its real identifier and the admin route is known.
  const fight=pathname.match(/^\/api\/(?:admin\/)?(?:fights|matches)\/([a-f0-9]{24})(?:\/|$)/i);
  if(fight)return {type:'fight',id:fight[1],url:'/administration/upcomingFights'};
  return {type:'endpoint',id:pathname,url:'/administration/notifications'};
};
function passiveIncidentMonitor(req,res,next){
  const started=Date.now();
  res.once('finish',()=>{
    if(res.statusCode<500 || !/^\/api\//.test(req.path||'') || /^\/api\/admin\/incidents/.test(req.path||''))return;
    try{
      const path=String(req.path||'').slice(0,250);
      const target=routeFor(path);
      const key=crypto.createHash('sha256').update(req.method+'|'+path+'|'+res.statusCode).digest('hex');
      const now=new Date();
      const description='HTTP '+res.statusCode+' from '+req.method+' '+path+'; elapsed '+(Date.now()-started)+'ms. Server failure observed. No private request body or credentials stored.';
      // Fire-and-forget. Telemetry cannot hold up or alter a user response.
      Incident.findOneAndUpdate({key},{
        $set:{source:'legacy-http',severity:'critical',title:'Backend request failed: '+path,
          description,affectedType:target.type,affectedId:target.id,actionUrl:target.url,lastSeen:now,status:'open',resolvedAt:null},
        $setOnInsert:{firstSeen:now},$inc:{occurrences:1}
      },{upsert:true}).catch(()=>{});
    }catch(_ignored){}
  });
  next();
}
module.exports={passiveIncidentMonitor};
