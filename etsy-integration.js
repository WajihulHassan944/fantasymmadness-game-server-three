'use strict';
// Etsy Open API v3: seller-authorized, read-only OAuth connection.
const crypto = require('crypto');
const API = 'https://openapi.etsy.com/v3';
const CALLBACK = 'https://fantasymmadness-game-server-three-taupe.vercel.app/api/integrations/etsy/callback';
const SCOPES = 'transactions_r listings_r shops_r';
const b64 = b => Buffer.from(b).toString('base64url');
const hash = s => b64(crypto.createHash('sha256').update(s).digest());
const secretKey = () => {
  if (!process.env.ETSY_TOKEN_ENCRYPTION_KEY) throw new Error('ETSY_TOKEN_ENCRYPTION_KEY is not configured');
  const key = Buffer.from(process.env.ETSY_TOKEN_ENCRYPTION_KEY, 'hex');
  if (key.length !== 32) throw new Error('ETSY_TOKEN_ENCRYPTION_KEY must be 32 bytes in hex');
  return key;
};
function encrypt(data) {
  const iv=crypto.randomBytes(12), cipher=crypto.createCipheriv('aes-256-gcm',secretKey(),iv);
  const bytes=Buffer.concat([cipher.update(JSON.stringify(data),'utf8'),cipher.final()]);
  return [b64(iv),b64(cipher.getAuthTag()),b64(bytes)].join('.');
}
function decrypt(payload) {
  const [i,t,d]=String(payload).split('.');
  const decipher=crypto.createDecipheriv('aes-256-gcm',secretKey(),Buffer.from(i,'base64url'));
  decipher.setAuthTag(Buffer.from(t,'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(d,'base64url')),decipher.final()]).toString());
}
module.exports = ({app,mongoose,verifyAdminToken}) => {
  const Config=mongoose.models.EtsyIntegration || mongoose.model('EtsyIntegration',new mongoose.Schema({
    _id:String, encrypted:String, stateHash:String, verifierEncrypted:String,
    stateExpiresAt:Date, updatedAt:Date, shopId:Number
  },{versionKey:false}));
  const key=()=>String(process.env.ETSY_API_KEYSTRING||'').trim();
  const api=async (path,token) => {
    const response=await fetch(API+path,{headers:{'x-api-key':key(),Authorization:'Bearer '+token}});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error('Etsy API request failed ('+response.status+')');
    return body;
  };
  async function getToken() {
    const row=await Config.findById('main');
    if(!row?.encrypted)throw new Error('Etsy seller authorization is not complete');
    let tokens=decrypt(row.encrypted);
    if(Date.now()>=tokens.expiresAt-120000){
      const response=await fetch('https://api.etsy.com/v3/public/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({
        grant_type:'refresh_token',client_id:key(),refresh_token:tokens.refresh_token
      })});
      if(!response.ok)throw new Error('Etsy token refresh failed ('+response.status+')');
      const updated=await response.json();
      tokens={...tokens,...updated,expiresAt:Date.now()+Number(updated.expires_in||3600)*1000};
      await Config.updateOne({_id:'main'},{$set:{encrypted:encrypt(tokens),updatedAt:new Date()}});
    }
    return tokens.access_token;
  }
  app.get('/api/admin/integrations/etsy/status',verifyAdminToken,async(req,res)=>{
    try {
      const row=await Config.findById('main').select('encrypted updatedAt shopId').lean();
      res.json({ok:true,connected:!!row?.encrypted,shopName:'FANTASYMMADNESS',shopId:row?.shopId||null,lastAuthorizedAt:row?.updatedAt||null,checkout:'etsy'});
    }catch(_){res.status(500).json({ok:false,message:'Etsy status unavailable'});}
  });
  app.get('/api/admin/integrations/etsy/connect',verifyAdminToken,async(req,res)=>{
    try {
      if(!key())return res.status(503).json({ok:false,message:'Etsy API key is not configured'});
      secretKey();
      const state=b64(crypto.randomBytes(32)),verifier=b64(crypto.randomBytes(32));
      await Config.updateOne({_id:'main'},{$set:{stateHash:hash(state),verifierEncrypted:encrypt(verifier),stateExpiresAt:new Date(Date.now()+600000)}},{upsert:true});
      const query=new URLSearchParams({response_type:'code',redirect_uri:CALLBACK,scope:SCOPES,client_id:key(),state,code_challenge:hash(verifier),code_challenge_method:'S256'});
      res.json({ok:true,authorizationUrl:'https://www.etsy.com/oauth/connect?'+query.toString()});
    }catch(_){res.status(503).json({ok:false,message:'Etsy secure connection is not configured'});}
  });
  app.get('/api/integrations/etsy/callback',async(req,res)=>{
    try {
      const code=String(req.query.code||''),state=String(req.query.state||'');
      if(!code||!state||code.length>2048||state.length>256)return res.status(400).send('Missing Etsy authorization');
      const row=await Config.findById('main');
      if(!row?.stateHash||!row?.verifierEncrypted||row.stateExpiresAt<new Date()||hash(state)!==row.stateHash)
        return res.status(400).send('Etsy authorization expired or invalid. Restart from the admin dashboard.');
      const verifier=decrypt(row.verifierEncrypted);
      // Consume one-time state before exchanging code.
      const consumed=await Config.updateOne({_id:'main',stateHash:row.stateHash},{$unset:{stateHash:1,verifierEncrypted:1,stateExpiresAt:1}});
      if(!consumed.modifiedCount)return res.status(400).send('Authorization already used');
      const response=await fetch('https://api.etsy.com/v3/public/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({
        grant_type:'authorization_code',client_id:key(),redirect_uri:CALLBACK,code,code_verifier:verifier
      })});
      if(!response.ok)return res.status(502).send('Etsy token exchange failed. Please restart authorization.');
      const token=await response.json();
      const tokens={...token,expiresAt:Date.now()+Number(token.expires_in||3600)*1000};
      await Config.updateOne({_id:'main'},{$set:{encrypted:encrypt(tokens),updatedAt:new Date()}});
      res.redirect(303,'https://www.fantasymmadness.com/admin?etsy=connected');
    }catch(_){res.status(500).send('Etsy connection failed. Check backend configuration and retry.');}
  });
  app.get('/api/admin/integrations/etsy/orders',verifyAdminToken,async(req,res)=>{
    try {
      const token=await getToken();
      const me=await api('/application/users/me',token);
      const userId=me.user_id;
      if(!userId)return res.status(502).json({ok:false,message:'Could not identify Etsy account'});
      const shops=await api('/application/users/'+encodeURIComponent(userId)+'/shops',token);
      const shop=shops.results?.find(s=>String(s.shop_name||'').toUpperCase()==='FANTASYMMADNESS');
      if(!shop)return res.status(403).json({ok:false,message:'Authorized Etsy account does not own FANTASYMMADNESS'});
      const limit=Math.min(100,Math.max(1,Number(req.query.limit)||50));
      const offset=Math.max(0,Number(req.query.offset)||0);
      const orders=await api('/application/shops/'+shop.shop_id+'/receipts?limit='+limit+'&offset='+offset,token);
      await Config.updateOne({_id:'main'},{$set:{shopId:shop.shop_id}});
      res.json({ok:true,shopName:shop.shop_name,count:orders.count||0,orders:orders.results||[],checkout:'etsy'});
    }catch(err){res.status(502).json({ok:false,message:String(err.message||'Etsy orders unavailable')});}
  });
};
