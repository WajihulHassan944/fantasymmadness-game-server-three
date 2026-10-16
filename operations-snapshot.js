'use strict';
// Read-only, authenticated snapshot. Never mutate core business records.
function registerOperationsSnapshot({app,mongoose,verifyAdminToken}) {
  const names = ['Match','User','Affiliate','Score','AdminIncident'];
  app.get('/api/admin/operations-snapshot',verifyAdminToken,async(_req,res)=>{
    const checkedAt=new Date().toISOString();
    const databaseConnected=mongoose.connection.readyState===1;
    const checks=await Promise.all(names.map(async name=>{
      const model=mongoose.models[name];
      if(!model)return {name,status:'not-connected',count:null,reason:'Model is not registered'};
      if(!databaseConnected)return {name,status:'unavailable',count:null,reason:'Database is not connected'};
      try{
        const count=await model.countDocuments({}).maxTimeMS(3500);
        return {name,status:'responding',count};
      }catch(_error){return {name,status:'unavailable',count:null,reason:'Count query failed'};}
    }));
    const unavailable=checks.some(c=>c.status!=='responding');
    res.status(unavailable?503:200).json({ok:!unavailable,checkedAt,databaseConnected,checks,
      coverage:{fightReadiness:'partial',serverErrors:'passive',scoringIntegrity:'not-implemented',
        payments:'not-implemented',payouts:'not-implemented',affiliates:'model-count-only',
        users:'model-count-only',notifications:'not-implemented',email:'not-implemented'},
      note:'Counts establish connectivity only. They do not establish business correctness.'});
  });
}
module.exports={registerOperationsSnapshot};
