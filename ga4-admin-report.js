'use strict';
// Read-only Google Analytics Data API reporting. Never expose service credentials to browsers.
const crypto = require('crypto');
const PROPERTY = '559734194';
const b64 = x => Buffer.from(JSON.stringify(x)).toString('base64url');
let cached = { token: '', expires: 0 };
async function googleToken() {
  if (cached.token && cached.expires > Date.now() + 60000) return cached.token;
  const email = process.env.GA4_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GA4_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) return null;
  const now = Math.floor(Date.now()/1000);
  const claim = { iss:email, scope:'https://www.googleapis.com/auth/analytics.readonly', aud:'https://oauth2.googleapis.com/token', iat:now, exp:now+3500 };
  const unsigned = b64({alg:'RS256',typ:'JWT'})+'.'+b64(claim);
  const signature = crypto.sign('RSA-SHA256',Buffer.from(unsigned),key).toString('base64url');
  const response = await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:unsigned+'.'+signature})});
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error('Google service account authentication failed');
  cached = {token:data.access_token,expires:Date.now()+(Number(data.expires_in)||3600)*1000};
  return cached.token;
}
module.exports = ({app,verifyAdminToken}) => {
  app.get('/api/admin/analytics/ga4',verifyAdminToken,async(req,res)=>{
    res.set('Cache-Control','private, no-store');
    const tokenConfigured = Boolean(process.env.GA4_SERVICE_ACCOUNT_EMAIL && process.env.GA4_SERVICE_ACCOUNT_PRIVATE_KEY);
    if (!tokenConfigured) return res.status(200).json({ok:false,configured:false,propertyId:PROPERTY,message:'Connect a Google Analytics service account with Viewer access and set GA4_SERVICE_ACCOUNT_EMAIL and GA4_SERVICE_ACCOUNT_PRIVATE_KEY in Vercel.'});
    try {
      const days = [7,30,90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
      const token = await googleToken();
      const request = async body => {
        const response = await fetch('https://analyticsdata.googleapis.com/v1beta/properties/'+PROPERTY+':runReport',{
          method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)
        });
        const json = await response.json();
        if (!response.ok) throw new Error('Google Analytics report unavailable ('+response.status+'): '+String(json?.error?.message||'check property access').slice(0,160));
        return json;
      };
      const range={startDate:(days-1)+'daysAgo',endDate:'today'};
      const [summary,sources,pages,daily] = await Promise.all([
        request({dateRanges:[range],metrics:[{name:'activeUsers'},{name:'sessions'},{name:'screenPageViews'},{name:'newUsers'},{name:'engagedSessions'}]}),
        request({dateRanges:[range],dimensions:[{name:'sessionDefaultChannelGroup'}],metrics:[{name:'sessions'}],limit:10,orderBys:[{metric:{metricName:'sessions'},desc:true}]}),
        request({dateRanges:[range],dimensions:[{name:'pagePath'}],metrics:[{name:'screenPageViews'}],limit:10,orderBys:[{metric:{metricName:'screenPageViews'},desc:true}]}),
        request({dateRanges:[range],dimensions:[{name:'date'}],metrics:[{name:'activeUsers'},{name:'sessions'}],limit:days,orderBys:[{dimension:{dimensionName:'date'}}]})
      ]);
      const summaryValues=(summary.rows?.[0]?.metricValues||[]).map(x=>Number(x.value)||0);
      const rows=(report)=> (report.rows||[]).map(r=>({name:r.dimensionValues?.[0]?.value||'Unknown',value:Number(r.metricValues?.[0]?.value)||0,secondary:Number(r.metricValues?.[1]?.value)||0}));
      return res.json({ok:true,configured:true,propertyId:PROPERTY,days,summary:{activeUsers:summaryValues[0]||0,sessions:summaryValues[1]||0,pageViews:summaryValues[2]||0,newUsers:summaryValues[3]||0,engagedSessions:summaryValues[4]||0},sources:rows(sources),pages:rows(pages),daily:rows(daily),source:'Google Analytics Data API',fetchedAt:new Date().toISOString()});
    }catch(error){return res.status(502).json({ok:false,configured:true,message:error.message||'Unable to read Google Analytics reports'});}
  });
};
