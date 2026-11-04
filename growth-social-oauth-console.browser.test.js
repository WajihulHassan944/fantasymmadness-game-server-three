'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('crypto');
const {chromium}=require('playwright');const express=require('express');const {MongoClient}=require('mongodb');
const {installGrowthSocialOAuth}=require('./growth-social-oauth-isolated');
const uri=process.env.GROWTH_TEST_MONGO_URI;
test('administrator-only social connection UI',{skip:!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri||'')},async()=>{
 const client=await new MongoClient(uri).connect(),db=client.db('fmgrowthtest');await db.dropDatabase();
 const salt=crypto.randomBytes(16),password='browser-fixture-password',stored=`scrypt$${salt.toString('base64')}$${crypto.scryptSync(password,salt,64).toString('base64')}`;
 const origin='https://growth-preview.example.test';const env={GROWTH_SOCIAL_PUBLIC_ORIGIN:origin,GROWTH_SOCIAL_TOKEN_KEY:crypto.randomBytes(32).toString('base64'),GROWTH_TIKTOK_CLIENT_KEY:'browser-fixture-client',GROWTH_TIKTOK_CLIENT_SECRET:'browser-fixture-secret',GROWTH_ADMIN_PASSWORD_HASH:stored};
 const app=express();app.use(express.json());const router=express.Router();installGrowthSocialOAuth({router,env,db,adminSecret:crypto.randomBytes(48).toString('hex'),fetchImpl:async()=>{throw Error('external calls forbidden in UI test');}});app.use('/api/growth',router);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({headless:true,...(process.env.GROWTH_TEST_CHROMIUM?{executablePath:process.env.GROWTH_TEST_CHROMIUM}:{}),args:['--no-sandbox']});
 try{
  const context=await browser.newContext(),page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!==base)return route.fulfill({contentType:'text/plain',body:'Provider navigation intercepted by test; no authorization performed.'});return route.continue({headers:{...route.request().headers(),origin}});});
  await page.goto(base+'/api/growth/console');
  assert.equal(await page.getByRole('button',{name:'Connect TikTok',exact:true}).isVisible(),false);
  await page.getByLabel('Growth administrator password').fill('wrong');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForFunction(()=>document.getElementById('message').textContent==='invalid_login');
  await page.getByLabel('Growth administrator password').fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('button',{name:'Connect TikTok',exact:true}).waitFor({state:'visible'});
  assert.equal(await page.getByRole('button',{name:'Connect TikTok',exact:true}).isEnabled(),true);assert.equal(await page.getByRole('button',{name:'Connect X',exact:true}).isDisabled(),true);
  assert.match(await page.locator('body').innerText(),/Publishing disabled/);
  const popup=await Promise.all([context.waitForEvent('page'),page.getByRole('button',{name:'Connect TikTok',exact:true}).click()]).then(r=>r[0]);await popup.waitForURL('https://www.tiktok.com/**');const u=new URL(popup.url());assert.equal(u.searchParams.get('scope'),'user.info.basic');assert.equal(u.searchParams.get('redirect_uri'),origin+'/api/growth/social/tiktok/callback');await popup.close();
  // UI confirmation behavior uses provider-verified metadata fixtures; API security is tested separately against MongoDB.
  let confirmed=false;
  await page.route('**/api/growth/social/connections',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,providers:[{provider:'tiktok',configured:true,blockers:[],callbackUrl:origin+'/api/growth/social/tiktok/callback'}],connections:confirmed?[{provider:'tiktok',identity:'verified_open_id',displayName:'Verified Account',status:'connected'}]:[],pending:confirmed?[]:[{candidateId:'verified-candidate',provider:'tiktok',identity:'verified_open_id',displayName:'<img src=x onerror=alert(1)>'}]})}));
  await page.route('**/api/growth/social/tiktok/confirm',r=>{const b=r.request().postDataJSON();assert.equal(b.identity,'verified_open_id');assert.equal(b.candidateId,'verified-candidate');confirmed=true;return r.fulfill({contentType:'application/json',body:'{"ok":true,"publishingEnabled":false}'});});
  await page.getByRole('button',{name:'Refresh status',exact:true}).click();await page.getByRole('button',{name:'Confirm TikTok account',exact:true}).waitFor({state:'visible'});assert.equal(await page.locator('#providers img').count(),0);
  await page.getByRole('button',{name:'Confirm TikTok account',exact:true}).click();await page.waitForFunction(()=>document.getElementById('providers').textContent.includes('Status: connected'));assert.equal(confirmed,true);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await db.dropDatabase();await client.close();}
});
