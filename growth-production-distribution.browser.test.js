'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),{chromium}=require('playwright');
test('owner browser can resume verified distribution and authorize only a displayed exact message and schedule',{timeout:30000},async()=>{
 const browser=await chromium.launch({executablePath:process.env.GROWTH_TEST_CHROMIUM||'/usr/bin/chromium',args:['--no-sandbox']});const page=await browser.newPage();const requests=[];let paused=true;
 const origin='https://engine.example.test',site='https://www.fantasymmadness.com';const draft={id:'owner-approved-pr',kind:'pr',headline:'Owner approved PR draft',subject:'Exact subject',text:'Exact message',html:'<p>Exact message</p>',recipient:'recipient@example.invalid',status:'approved',ownerApproved:true,review:{state:'eligible',version:'a'.repeat(64),blockers:[]}};
 const readiness=()=>({ok:true,enabled:true,policy:{paused},email:{ready:true,sender:'contact@fantasymmadnesscom.com'},channels:{facebook:{ready:true,destinationId:'128043637053328',name:'Fantasy MMAdness'}},deliveries:[]});
 await page.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());
  if(u.origin===site)return route.fulfill({contentType:'text/html',body:'<iframe src="'+origin+'/api/growth/console?embed=1" width="1200" height="1000"></iframe>'});
  if(u.pathname.startsWith('/api/growth/console')){const file=u.pathname.endsWith('app.js')?'app.js':u.pathname.endsWith('app.css')?'app.css':'index.html';return route.fulfill({contentType:file==='index.html'?'text/html':file==='app.js'?'application/javascript':'text/css',body:fs.readFileSync('growth-production-console/'+file,'utf8')});}
  let body={ok:true};const p=u.pathname;
  if(p.endsWith('/health'))body={ok:true,console:{embedOrigins:[site]},scheduler:{enabled:true},database:'fmgrowthproduction'};
  else if(p.endsWith('/session'))body={ok:true,admin:{email:'owner@example.invalid'},expiresAt:Date.now()+3600000};
  else if(p.endsWith('/admin/social'))body={ok:true,paused:{paused:true},channels:{},posts:[]};
  else if(p.endsWith('/admin/distribution'))body=readiness();
  else if(p.endsWith('/admin/distribution/pause')){requests.push({path:p,body:req.postDataJSON()});paused=req.postDataJSON().paused;body={ok:true,paused};}
  else if(p.endsWith('/preview')){assert.equal(req.method(),'GET');assert.equal(req.postData(),null);assert.equal(u.searchParams.get('channel'),'email');body={ok:true,version:'a'.repeat(64),payloadHash:'b'.repeat(64),payload:{channel:'email',subject:'Exact subject',text:'Exact message\n\nUnsubscribe: https://engine.example.test/optout'},providerReady:true};}
  else if(p.endsWith('/authorize')){requests.push({path:p,body:req.postDataJSON()});body={ok:true};}
  else if(p.endsWith('/drafts'))body={ok:true,drafts:[draft]};
  else if(p.endsWith('/overview'))body={ok:true,overview:{drafts:{},jobs:{},social:{}}};
  else if(p.endsWith('/status'))body={ok:true,scheduler:{},delivery:{realDelivery:false}};
  return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
 });
 try{page.setDefaultTimeout(5000);page.on('pageerror',e=>console.log('browser-error',e.message));await page.goto(site);await page.frameLocator('iframe').getByText('Waiting for your existing administrator session.').waitFor();await page.evaluate(({origin})=>document.querySelector('iframe').contentWindow.postMessage({type:'fmm-growth-session',token:'fixture-session'},origin),{origin});const frame=page.frameLocator('iframe');await frame.locator('body').evaluate(()=>{location.hash='#/publishing';});await frame.getByTestId('btn-toggle-pause').waitFor();assert.equal(await frame.getByTestId('btn-toggle-pause').isEnabled(),true);await frame.getByTestId('btn-toggle-pause').click();await frame.getByRole('button',{name:'Resume',exact:true}).click();await page.waitForTimeout(100);assert.equal(requests[0].body.paused,false);
 await frame.locator('body').evaluate(()=>{location.hash='#/approvals?status=approved';});await frame.getByTestId('btn-authorize-delivery').click();await frame.getByTestId('exact-delivery-preview').filter({hasText:'Unsubscribe:'}).waitFor();await frame.getByTestId('delivery-time').fill('2026-11-09T10:00');await frame.getByTestId('delivery-specific-approval').check();await frame.getByRole('button',{name:'Authorize delivery',exact:true}).click();await page.waitForTimeout(100);const approved=requests.find(x=>x.path.endsWith('/authorize'));assert.equal(approved.body.recipient,draft.recipient);assert.equal(approved.body.payloadHash,'b'.repeat(64));assert.equal(approved.body.confirmation,'AUTHORIZE THIS EXACT DELIVERY');
 }finally{await browser.close();}
});
