'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),{chromium}=require('playwright');
test('visible approval and rejection controls retain source holds and actual delivery receipts',async()=>{
 const browser=await chromium.launch({executablePath:process.env.GROWTH_TEST_CHROMIUM||'/usr/bin/chromium',args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1200,height:720}}),origin='https://engine.example.test',site='https://www.fantasymmadness.com';let decisions=[];
 const draft={id:'pending',kind:'marketing',headline:'Owner campaign',text:'Long caption\n'.repeat(150),status:'needs_owner_review',review:{state:'eligible',version:'a'.repeat(64),blockers:[]}};
 const held={...draft,id:'held',headline:'Held fight',contest:{fighterA:'A',fighterB:'B',sport:'boxing',dateKey:'2026-11-09',contestUrl:'https://example.invalid'},review:{state:'held',version:'b'.repeat(64),blockers:['registry_public_entry_state_conflict']}};
 const sent={...draft,id:'sent',headline:'Approved campaign',status:'approved',deliveries:[{channel:'facebook',destinationId:'128043637053328',status:'published',receipt:{providerPostId:'fixture-only-post',publicPermalink:'https://www.facebook.com/fixture-only-post'}}]};
 await page.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url());
  if(u.origin===site)return route.fulfill({contentType:'text/html',body:'<iframe src="'+origin+'/api/growth/console?embed=1" width="1150" height="650"></iframe>'});
  if(u.pathname.startsWith('/api/growth/console')){const file=u.pathname.endsWith('app.js')?'app.js':u.pathname.endsWith('app.css')?'app.css':'index.html';return route.fulfill({contentType:file==='index.html'?'text/html':file==='app.js'?'application/javascript':'text/css',body:fs.readFileSync('growth-production-console/'+file,'utf8')});}
  let body={ok:true};
  if(u.pathname.endsWith('/health'))body={ok:true,console:{embedOrigins:[site]},scheduler:{enabled:true}};
  else if(u.pathname.endsWith('/session'))body={ok:true,expiresAt:Date.now()+3600000};
  else if(u.pathname.endsWith('/drafts'))body={ok:true,drafts:[draft,held,sent]};
  else if(u.pathname.endsWith('/approve')||u.pathname.endsWith('/reject')){decisions.push({path:u.pathname,body:req.postDataJSON()});draft.status=u.pathname.endsWith('/approve')?'approved':'rejected';}
  else if(u.pathname.endsWith('/connections'))body={ok:true,connections:{}};
  else if(u.pathname.endsWith('/overview'))body={ok:true,overview:{drafts:{},jobs:{},social:{}}};
  return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
 });
 try{
  page.setDefaultTimeout(5000);await page.goto(site);const frame=page.frameLocator('iframe');await frame.getByText('Waiting for your existing administrator session.').waitFor();
  await page.evaluate(origin=>document.querySelector('iframe').contentWindow.postMessage({type:'fmm-growth-session',token:'fixture-session'},origin),origin);
  await frame.locator('body').evaluate(()=>{location.hash='#/approvals?review=all';});
  const card=frame.locator('[data-draft-id=pending]');await card.getByTestId('btn-approve').waitFor();
  assert.ok((await card.getByTestId('btn-approve').boundingBox()).y<(await card.getByTestId('draft-text').boundingBox()).y);
  assert.ok((await card.getByTestId('btn-reject').boundingBox()).y<650);
  const heldCard=frame.locator('[data-draft-id=held]');assert.equal(await heldCard.getByTestId('btn-approve').isDisabled(),true);assert.match(await heldCard.getByTestId('fight-facts').innerText(),/HOLD/);assert.doesNotMatch(await heldCard.getByTestId('fight-facts').innerText(),/Verified contest/);
  assert.match(await frame.locator('[data-draft-id=sent]').getByTestId('campaign-deliveries').innerText(),/fixture-only-post/);
  await card.getByTestId('btn-approve').click();await frame.getByTestId('modal-confirm').click();await card.getByTestId('btn-withdraw').waitFor();assert.equal(decisions[0].body.version,'a'.repeat(64));
  await card.getByTestId('btn-withdraw').click();await frame.getByTestId('modal-confirm').click();assert.equal(decisions[1].path.endsWith('/reject'),true);
 }finally{await browser.close();}
});
