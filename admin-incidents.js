'use strict';
// Structured, admin-only incident records. Never infer incidents from successful activity.
function registerIncidentRoutes({app,mongoose,verifyAdminToken}) {
  const schema = new mongoose.Schema({
    key:{type:String,required:true,unique:true,index:true},
    source:{type:String,required:true},
    severity:{type:String,enum:['critical','review'],required:true},
    title:{type:String,required:true},
    description:{type:String,required:true},
    affectedType:{type:String,required:true},
    affectedId:{type:String,required:true},
    actionUrl:{type:String,required:true},
    status:{type:String,enum:['open','investigating','resolved'],default:'open',index:true},
    occurrences:{type:Number,default:1},
    firstSeen:{type:Date,default:Date.now},
    lastSeen:{type:Date,default:Date.now},
    resolvedAt:Date,
    resolutionNote:String,
  },{timestamps:true});
  const Incident=mongoose.models.AdminIncident||mongoose.model('AdminIncident',schema);
  const validUrl=(value)=>typeof value==='string'&&/^\/administration\/[a-zA-Z0-9/_?=&%-]+$/.test(value)&&!value.startsWith('//');
  app.get('/api/admin/incidents',verifyAdminToken,async(req,res)=>{
    try {
      const query=req.query.history==='true'?{}:{status:{$ne:'resolved'}};
      const records=await Incident.find(query).sort({lastSeen:-1}).limit(250).lean();
      res.json({ok:true,incidents:records});
    } catch(error){res.status(500).json({ok:false,message:'Unable to load incidents.'});}
  });
  app.patch('/api/admin/incidents/:id/status',verifyAdminToken,async(req,res)=>{
    try {
      if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({ok:false,message:'Invalid incident id'});
      const status=String(req.body?.status||'');
      if(!['open','investigating','resolved'].includes(status))return res.status(400).json({ok:false,message:'Invalid incident status'});
      if(status==='resolved'&&!String(req.body?.resolutionNote||'').trim())return res.status(400).json({ok:false,message:'Resolution note required'});
      const update={status,resolutionNote:status==='resolved'?String(req.body.resolutionNote).trim():null,resolvedAt:status==='resolved'?new Date():null};
      const incident=await Incident.findByIdAndUpdate(req.params.id,{$set:update},{new:true});
      if(!incident)return res.status(404).json({ok:false,message:'Incident not found'});
      res.json({ok:true,incident});
    }catch(error){res.status(500).json({ok:false,message:'Could not update incident'});}
  });
  async function reportIncident({key,source,severity,title,description,affectedType,affectedId,actionUrl}) {
    if(!key||!source||!['critical','review'].includes(severity)||!title||!description||!affectedType||!affectedId||!validUrl(actionUrl))throw new Error('Incident requires specific diagnostics and a valid admin destination.');
    const now=new Date();
    return Incident.findOneAndUpdate({key},{$set:{source,severity,title,description,affectedType,affectedId,actionUrl,status:'open',lastSeen:now,resolvedAt:null,resolutionNote:null},$setOnInsert:{firstSeen:now},$inc:{occurrences:1}},{upsert:true,new:true});
  }
  return {reportIncident};
}
module.exports={registerIncidentRoutes};
