'use strict';
// Read-only LIVE public-provider connectivity smoke test in isolated CI.
// Makes GET requests only to public Apple Podcasts and Google News endpoints.
// Never sends email, posts social content, writes a database, or touches production.
const assert=require('node:assert/strict');
const {makeJob,claimDue,settle}=require('./growth-unattended-controller');
const timeout=ms=>AbortSignal.timeout(ms);
async function probe(name,url,validate){
 const response=await fetch(url,{signal:timeout(12000),headers:{'User-Agent':'FANTASYMMADNESS-Research-Connectivity-Test/1.0','Accept':'application/json, application/rss+xml, application/xml, text/xml, */*'}});
 assert.equal(response.ok,true,name+' HTTP '+response.status);
 const body=await response.text();
 assert.ok(body.length>100,name+' empty provider response');
 validate(body);
 return {provider:name,httpStatus:response.status,bytes:body.length};
}
(async()=>{
 const results=[];
 results.push(await probe('Apple Podcasts','https://itunes.apple.com/search?term=boxing%20podcast&media=podcast&entity=podcast&country=US&limit=2',body=>{
  const data=JSON.parse(body);assert.ok(Array.isArray(data.results),'Apple search response lacks results');
 }));
 results.push(await probe('Google News RSS','https://news.google.com/rss/search?q=boxing%20fight&hl=en-US&gl=US&ceid=US%3Aen',body=>{
  assert.match(body,/<rss[\s>]|<feed[\s>]/i,'News feed is not RSS or Atom');
 }));
 const t=Date.UTC(2026,10,1,12);
 const due=makeJob({id:'staging-research-1',type:'discover',dueAt:new Date(t).toISOString()});
 assert.equal(claimDue([due],t).length,1);
 const completed=settle(claimDue([due],t)[0],{success:true,now:t});
 assert.equal(completed.state,'completed');
 assert.equal(claimDue([completed],t+60000).length,0);
 console.log('PASS live public research provider GET probes and isolated scheduler contract '+JSON.stringify({providers:results,scheduledJobsCompleted:1,outboundMessages:0,productionWrites:0}));
})().catch(err=>{console.error('LIVE_PROVIDER_SMOKE_FAILED',err.message);process.exitCode=1;});
