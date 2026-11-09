'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {createApprovedBrandPublication,ID,grant}=require('./growth-approved-brand-publication');
const image=fs.readFileSync(require('node:path').join(__dirname,'tests/fixtures/approved-brand-logo.jpg'));
function fixture({outcome={ok:true,receipt:{providerPostId:'fixture',publicPermalink:'https://www.facebook.com/fixture',sandbox:true}},imageBytes=image,ready=true,paused=false}={}){
 const rows=new Map(),calls=[],events=[];
 const settings={findOne:async q=>rows.get(q._id)||null,updateOne:async(q,u,o)=>{const r=rows.get(q._id);if(!r&&o?.upsert){rows.set(q._id,{_id:q._id,...u.$setOnInsert});return{upsertedCount:1};}if(r&&(!q.state||r.state===q.state)){Object.assign(r,u.$set);return{upsertedCount:0,modifiedCount:1};}return{upsertedCount:0,modifiedCount:0};}};
 const meta={readiness:async()=>Object.fromEntries(Object.entries(grant.destinations).map(([c,id])=>[c,{ready,destinationId:id}])),publish:async p=>{calls.push(p);return outcome;}};
 const service=createApprovedBrandPublication({settings,audit:{insertOne:async e=>events.push(e)},meta,canSend:async()=>!paused,fetchImpl:async()=>({ok:true,headers:new Headers({'content-type':'image/jpeg'}),arrayBuffer:async()=>imageBytes})});
 return{service,rows,calls,events};
}
test('concurrent and recurring cron runs publish the approved bytes and accounts once each',async()=>{
 const f=fixture();await Promise.all([f.service.publish(ID),f.service.publish(ID)]);await f.service.publish(ID);
 assert.equal(f.calls.length,2);for(const p of f.calls){assert.equal(p.text,grant.text);assert.equal(p.imageUrl,grant.imageUrl);assert.equal(p.destinationId,grant.destinations[p.channel]);}
 assert.deepEqual(Object.values(await f.service.status()).map(r=>r.state),['published','published']);
});
test('ambiguous provider outcomes remain held across future cron invocations',async()=>{
 const f=fixture({outcome:{ok:false,uncertain:true,reason:'timeout'}});await f.service.publish(ID);await f.service.publish(ID);assert.equal(f.calls.length,2);assert.ok(Object.values(await f.service.status()).every(r=>r.state==='needs_check'));
});
test('changed artwork, unavailable scopes, pause and absent exact grant cannot publish',async()=>{
 for(const options of [{imageBytes:Buffer.from('changed')},{ready:false},{paused:true}]){const f=fixture(options);await f.service.publish(ID);assert.equal(f.calls.length,0);}
 const f=fixture();await f.service.publish('another-campaign');assert.equal(f.calls.length,0);
});
test('definite failures are recorded without silently repeating the owner one-time authorization',async()=>{
 const f=fixture({outcome:{ok:false,reason:'permission_denied'}});await f.service.publish(ID);await f.service.publish(ID);assert.equal(f.calls.length,2);assert.ok(Object.values(await f.service.status()).every(r=>r.state==='failed'));
});
