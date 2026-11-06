'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {MongoClient}=require('mongodb');const {auditApprovalQueue}=require('./growth-approval-queue-audit');
const uri=process.env.GROWTH_TEST_MONGO_URI;
test('emergency recipient hold is isolated, persistent, replay safe and never declares reported death verified',{skip:!/^mongodb:\/\/127\.0\.0\.1/.test(uri||'')},async()=>{
 const client=await new MongoClient(uri).connect(),db=client.db('fmgrowthtest'),drafts=db.collection('preview198_growth_drafts'),leads=db.collection('preview198_affiliate_prospects');
 const id='emergency-audit-fixture-'+Date.now(),leadId=id+'-lead';
 try{
 await drafts.insertOne({id,kind:'affiliate',subject:'Dory Funk Jr. partnership',text:'Hi,',recipient:'test@fixture.invalid',prospectId:leadId,recruitmentSource:'independent_public_partner',status:'needs_owner_review',ownerApproved:true,sendPermitted:true,approvalBlockers:['affiliate_terms_require_owner_review']});await leads.insertOne({id:leadId,name:'Dory Funk Jr.',sourceId:'Q-fixture'});
 const r=await auditApprovalQueue({db});const row=r.rows.find(x=>x.id===id);assert.equal(row.decision,'HOLD');assert.equal(row.recipientStatus,'OWNER_REPORTED_UNSAFE_UNCONFIRMED');assert.ok(row.blockers.includes('owner_reported_recipient_status_requires_verification'));
 const d=await drafts.findOne({id});assert.equal(d.ownerApproved,false);assert.equal(d.sendPermitted,false);assert.equal(d.text,'Hi,');await auditApprovalQueue({db});assert.equal(await db.collection('preview198_growth_audit_log').countDocuments({action:'emergency_recipient_hold',draftId:id}),1);assert.ok(!JSON.stringify(r).includes('test@fixture.invalid'));
 await assert.rejects(()=>auditApprovalQueue({db:client.db('fmgrowthproduction')}),/isolated_queue_database_required/);
 }finally{await drafts.deleteOne({id});await leads.deleteOne({id:leadId});await db.collection('preview198_growth_audit_log').deleteOne({draftId:id});await client.close();}
});
