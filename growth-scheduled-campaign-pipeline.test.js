'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runScheduledSandboxCampaign}=require('./growth-scheduled-campaign-pipeline');
const {planWorkstreams}=require('./growth-global-workstreams');
test('one isolated scheduled tick persists research and reports approved localhost delivery',async()=>{
 const saved=[],messages=[];
 const collection={createIndex:async()=>{},updateOne:async(key,update)=>saved.push({key,update})};
 const draft={id:'d1',genre:'boxing',category:'media',recipient:'recipient@localhost',subject:'FANTASY MMADNESS test',text:'Sandbox',status:'approved',ownerApproved:true,sendPermitted:true};
 const r=await runScheduledSandboxCampaign({
  collection,testMode:true,clock:()=>new Date('2026-10-31T12:00:00Z'),
  workstreams:planWorkstreams().slice(0,1),adapters:{audience:async()=>({found:1})},
  transport:{sendMail:async msg=>{messages.push(msg);return {messageId:'sandbox-1'}}},
  approvedDrafts:[draft,{...draft,id:'d2',recipient:'outside@example.org'}]
 });
 assert.equal(r.execution.completed,1);assert.equal(saved.length,1);
 assert.equal(r.receipts.length,1);assert.equal(r.blocked.length,1);
 assert.equal(r.report.sandboxReceipts,1);assert.equal(r.report.sent,0);
 assert.equal(r.realMessagesSent,0);assert.equal(messages.length,1);
});
test('nonisolated execution is rejected',async()=>{
 await assert.rejects(()=>runScheduledSandboxCampaign({testMode:false}),/Isolated/);
});
