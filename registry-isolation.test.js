'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),jwt=require('jsonwebtoken');
const {verifyGameAdministrator,isGrowthAuthority}=require('./game-admin-authority');
const {registerUfcEventDiscovery,_private}=require('./ufc-event-discovery');
const secret='local-registry-incident-fixture-only-secret',id='66c349883bf54a4de465893f';
test('actual game administrator guard rejects Growth credentials even with a shared signing key',()=>{
 const source=fs.readFileSync('server.js','utf8'),start=source.indexOf('const verifyAdminToken ='),end=source.indexOf('\n};',start)+3,context={verifyGameAdministrator,process:{env:{JWT_SECRET_ADMIN:secret}}};vm.createContext(context);vm.runInContext(source.slice(start,end)+';this.guard=verifyAdminToken',context);
 let mutations=0;const call=token=>{let code=200;const res={status(n){code=n;return this;},json(){return this;}};context.guard({headers:{authorization:'Bearer '+token}},res,()=>mutations++);return code;};
 for(const claims of [{scope:'growth',id,email:'owner@fixture.invalid'},{scope:'growth',email:'owner@fixture.invalid',iss:'fmm-growth'},{id,email:'owner@fixture.invalid',aud:'growth'}])assert.equal(call(jwt.sign(claims,secret)),401);
 assert.equal(mutations,0);assert.equal(call(jwt.sign({id,email:'owner@fixture.invalid'},secret,{expiresIn:'1h'})),200);assert.equal(mutations,1);assert.equal(call(jwt.sign({id,email:'owner@fixture.invalid'},secret,{expiresIn:-1})),401);
 assert.ok(!/jwt\.verify\([^)]*JWT_SECRET_ADMIN/.test(source),'No alternate administrator path may bypass scope separation');
});
test('scheduled, startup and manual discovery cannot create/update fights or notify anyone',async()=>{
 const unchanged={id:'existing-fight',score:44,entries:2,payment:'sentinel'},before=JSON.stringify(unchanged);let writes=0;function Match(){writes++;throw Error('registry_write_forbidden');}Match.findOne=()=>{throw Error('discovery_must_not_access_registry_models');};
 const parser={parseURL:async()=>({items:[{title:'Report: Jacqueline Cavalcanti vs. Michelle Montague postponed to UFC 335 on Dec. 12, 2026',contentSnippet:'Jacqueline Cavalcanti vs Michelle Montague postponed to UFC 335 on December 12, 2026',link:'https://news.google.com/rss/incident-fixture',isoDate:'2026-11-02T03:18:13Z'}]})};
 const proposals=new Map();const proposalQueue={async updateOne(filter,update,options){assert.equal(options.upsert,true);if(!proposals.has(filter._id))proposals.set(filter._id,{...update.$setOnInsert});Object.assign(proposals.get(filter._id),update.$set);}};
 const runtime=registerUfcEventDiscovery({proposalQueue,app:{get(){},post(){}},parser,Match,fetch:undefined,Notification:function(){writes++;},triggerUpcomingEventAutomationForMatch:()=>{writes++;}});
 for(const reason of ['cron-http-endpoint','scheduled-cron','server-startup','admin-manual-refresh']){const r=await runtime.runRefresh({dryRun:false,reason});assert.equal(r.createdCount,0);assert.equal(r.updatedCount,0);assert.equal(r.registryWritesEnabled,false);assert.equal(r.skipped.find(x=>x.candidate).candidate.fighterB,'Michelle Montague');assert.ok(r.skipped.some(x=>x.reason==='owner-registry-approval-required'));}
 assert.equal(writes,0);assert.equal(JSON.stringify(unchanged),before);assert.equal(proposals.size,1);assert.equal([...proposals.values()][0].status,"needs_owner_review");assert.equal([...proposals.values()][0].registryMatchId,null);
});
test('actual mixed administrator/affiliate creation guard rejects Growth and player scope without breaking affiliate access',()=>{
 const source=fs.readFileSync('server.js','utf8'),start=source.indexOf('const verifyAdminOrAffiliateToken ='),end=source.indexOf('\n};',start)+3,context={verifyGameAdministrator,isGrowthAuthority,jwt,TOKEN_SCOPES:{AFFILIATE:'affiliate'},process:{env:{JWT_SECRET_ADMIN:secret,JWT_SECRET:secret}}};vm.createContext(context);vm.runInContext(source.slice(start,end)+';this.guard=verifyAdminOrAffiliateToken',context);
 let writes=0;const call=claims=>{let status=200;const req={headers:{authorization:'Bearer '+jwt.sign(claims,secret)}},res={status(n){status=n;return this;},json(){return this;}};context.guard(req,res,()=>writes++);return{status,role:req.actorRole};};
 for(const scope of ['growth','user','player'])assert.notEqual(call({id,email:'qa@fixture.invalid',scope}).status,200);assert.notEqual(call({id,email:'qa@fixture.invalid',iss:'growth-admin'}).status,200);assert.notEqual(call({id,email:'qa@fixture.invalid',aud:'growth'}).status,200);assert.equal(writes,0);assert.equal(call({id,email:'owner@fixture.invalid'}).role,'admin');assert.equal(call({id,email:'partner@fixture.invalid',scope:'affiliate'}).role,'affiliate');assert.equal(writes,2);
});
