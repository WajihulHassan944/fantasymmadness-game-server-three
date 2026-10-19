'use strict';
// Passive attribution: never blocks registration, modifies auth, or handles payment data.
const CAMPAIGN = /^combat_fans_[a-z0-9_-]{1,60}$/;
function normalize(input) {
 if (!input || input.utm_source !== 'fan_acquisition' || input.utm_medium !== 'partner_outreach') return null;
 if (!CAMPAIGN.test(String(input.utm_campaign || ''))) return null;
 return {
  source:'fan_acquisition', medium:'partner_outreach',
  campaign:String(input.utm_campaign),
  content:String(input.utm_content || '').replace(/[^a-z0-9_-]/gi,'').slice(0,32),
  landingPath:String(input.landingPath || '/').slice(0,256),
 };
}
function registrationCapture(req,res,next) {
 if (req.method !== 'POST' || req.path !== '/register') return next();
 const attribution=normalize(req.body?.campaignAttribution);
 const email=String(req.body?.email || '').trim().toLowerCase();
 if (!attribution || !email || email.length > 254) return next();
 const requestedAt=new Date();
 res.once('finish',()=>{
  if (res.statusCode < 200 || res.statusCode >= 300) return;
  // Account must have been created during this request. Never attach campaigns
  // to older users, even if they try registering again.
  setImmediate(async()=>{
   try {
    const mongoose=require('mongoose');
    const User=mongoose.models.User;
    if (!User || mongoose.connection.readyState !== 1) return;
    const escaped=email.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const user=await User.collection.findOne({email:{$regex:'^'+escaped+'$', $options:'i'}},{projection:{_id:1,createdAt:1,campaignAttribution:1}});
    if (!user || user.campaignAttribution || !user.createdAt) return;
    const created=new Date(user.createdAt).getTime();
    if (!Number.isFinite(created) || created < requestedAt.getTime()-60000 || created > Date.now()+60000) return;
    await User.collection.updateOne({_id:user._id,campaignAttribution:{$exists:false}},{$set:{campaignAttribution:{...attribution,registeredAt:new Date()}}});
   } catch(error){console.error('[acquisition] attribution capture skipped:',error?.message);}
  });
 });
 next();
}
function installReports({app,mongoose,verifyAdminToken}) {
 app.get('/api/admin/fan-acquisition/registration-report',verifyAdminToken,async(req,res)=>{
  try{
   if(mongoose.connection.readyState!==1)return res.status(503).json({ok:false,message:'Database unavailable'});
   const User=mongoose.models.User;
   const groups=await User.collection.aggregate([
    {$match:{'campaignAttribution.source':'fan_acquisition'}},
    {$group:{_id:'$campaignAttribution.campaign',registrations:{$sum:1}}},
    {$sort:{registrations:-1}},{$limit:50}
   ]).toArray();
   return res.json({ok:true,verifiedRegistrationCounts:true,paymentAttributionConnected:false,groups:groups.map(g=>({campaign:g._id,registrations:g.registrations}))});
  }catch(error){return res.status(503).json({ok:false,message:'Registration reporting unavailable'});}
 });
}
module.exports={registrationCapture,installReports};
