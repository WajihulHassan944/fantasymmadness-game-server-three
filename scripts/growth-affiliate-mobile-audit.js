'use strict';
// Observational routing audit only: anonymous GETs, no forms submitted, no tokens,
// no screenshots, no artwork export, and every non-GET request is blocked.
const fs=require('node:fs'),{chromium}=require('playwright');
const manifest=JSON.parse(fs.readFileSync('docs/evidence/growth-affiliate-links-20261105.json','utf8'));
const allowed=new Set(['www.fantasymmadness.com','fantasymmadness.com','fantasymmadness-game-server-three.vercel.app','fantasymmadness-game-server-three-taupe.vercel.app']);
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.GROWTH_TEST_CHROMIUM?{executablePath:process.env.GROWTH_TEST_CHROMIUM}:{}),args:['--no-sandbox']});const observations=[],cache=new Map();let blockedWrites=0;
 try{for(const row of manifest.rows){if(!row.decodedUrl||row.syntheticAffiliate)continue;const u=new URL(row.decodedUrl);if(!['www.fantasymmadness.com','fantasymmadness.com'].includes(u.hostname))continue;
  if(!cache.has(row.decodedUrl)){
   const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
   await context.route('**/*',async route=>{const req=route.request(),host=new URL(req.url()).hostname;if(req.method()!=='GET'){blockedWrites++;return route.abort();}if(!allowed.has(host))return route.abort();return route.continue();});
   const page=await context.newPage();let result;
   try{const response=await page.goto(row.decodedUrl,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(1500);const final=new URL(page.url()),original=new URL(row.decodedUrl);const storage=await page.evaluate(()=>{try{const x=JSON.parse(sessionStorage.getItem('fmm_fan_acquisition_attribution')||'null');return x?{utm_campaign:x.utm_campaign,utm_source:x.utm_source}:null;}catch{return null;}});
    const campaignPreserved=!original.searchParams.has('utm_campaign')||final.searchParams.get('utm_campaign')===original.searchParams.get('utm_campaign')||storage?.utm_campaign===original.searchParams.get('utm_campaign');
    const signupExpected=row.expectedDestination?.includes('signup'),form=signupExpected?await page.getByRole('button',{name:'Apply as an affiliate',exact:true}).isVisible().catch(()=>false):null;
    const chain=[];for(let req=response?.request();req;req=req.redirectedFrom())chain.unshift(req.url());
    result={sourceUrl:row.decodedUrl,observedDestination:final.toString(),httpStatus:response?.status()||null,redirects:chain,campaignPreserved,affiliateSignupFormVisible:form,viewport:{width:390,height:844},readOnly:true,observation:!campaignPreserved?'FAIL':response?.status()>=400?'FAIL':signupExpected&&!form?'HOLD':'PASS',...(signupExpected&&!form?{reason:'affiliate_form_not_visible_without_further_interaction'}:{})};
   }catch{result={sourceUrl:row.decodedUrl,observedDestination:page.url(),readOnly:true,observation:'HOLD',reason:'mobile_destination_navigation_unavailable'};}
   await context.close();cache.set(row.decodedUrl,result);
  }
  observations.push({sourceItem:row.sourceItem,sourceType:row.sourceType,...cache.get(row.decodedUrl)});
 }}finally{await browser.close();}
 console.log(JSON.stringify({audit:'read_only_mobile_destinations',checkedAt:new Date().toISOString(),snapshottedStagingInventoryAt:manifest.checkedAt,observations,blockedWriteRequests:blockedWrites,actualWriteRequestsPermitted:0,paymentRequestsPermitted:0,formSubmissions:0,imagesExported:false,interpretation:'Observational findings, not permission to publish or a claim that every destination passes. Local staging regression tests independently gate the repairs.'}));
})().catch(e=>{console.error('Read-only mobile audit harness failed:',e.name);process.exitCode=1;});
