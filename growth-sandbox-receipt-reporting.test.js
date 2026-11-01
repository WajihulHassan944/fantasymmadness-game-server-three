'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {recordSandboxReceipt,sandboxCampaignReport,evaluateSandboxFollowup}=require('./growth-sandbox-receipt-reporting');
test('sandbox receipt is counted without claiming real delivery',()=>{
 const draft={id:'d1',genre:'boxing',category:'media',ownerApproved:true};
 const delivery={ok:true,receipt:{draftId:'d1',sandbox:true,realDelivery:false,providerMessageId:'local-1'}};
 const record=recordSandboxReceipt({draft,delivery,now:'2026-10-30T20:00:00Z'});
 assert.equal(record.sandboxDelivered,true);assert.equal(record.sent,false);assert.equal(record.deliveryVerified,false);
 const report=sandboxCampaignReport([record]);
 assert.equal(report.sandboxReceipts,1);assert.equal(report.sent,0);assert.equal(report.delivered,0);assert.equal(report.realMessagesSent,0);
 assert.equal(evaluateSandboxFollowup(record).action,'hold');
});
test('forged or mismatched receipts are rejected',()=>{
 const draft={id:'d1'};
 assert.throws(()=>recordSandboxReceipt({draft,delivery:{ok:true,receipt:{draftId:'d2',sandbox:true,realDelivery:false,providerMessageId:'x'}}}),/receipt/);
 assert.throws(()=>recordSandboxReceipt({draft,delivery:{ok:true,receipt:{draftId:'d1',sandbox:false,realDelivery:true,providerMessageId:'x'}}}),/receipt/);
});
