'use strict';
// Private QA collections only. Source drafts are never approved, dispatched or edited.
const crypto=require('node:crypto');
const {launchReview}=require('./growth-launch-review');
const {createDeliveryProvider}=require('./growth-delivery-provider');
const {createSocialPublisher,resolveSocialConfig}=require('./growth-social-publishing');
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function deliveryAcceptance({db,config,fetchImpl=globalThis.fetch}){
 if(db.databaseName!=='fmgrowthtest'||config?.delivery?.provider!=='sandbox-capture'||config?.delivery?.realDelivery===true||config?.social?.provider!=='sandbox')throw Error('isolated_capture_only_required');
 const claims=db.collection('preview198_launch_qa_claims'),mail=db.collection('preview198_launch_qa_mail'),social=db.collection('preview198_launch_qa_social');
 await claims.createIndex({id:1},{unique:true});await mail.createIndex({id:1},{unique:true});
 const before=await launchReview({db}),source=db.collection('preview198_growth_drafts'),ids=before.campaigns.map(c=>c.id);
 const protectedState=()=>source.find({id:{$in:ids}},{projection:{_id:0,id:1,status:1,ownerApproved:1,sendPermitted:1}}).sort({id:1}).toArray();const original=digest(await protectedState());
 const provider=createDeliveryProvider({config,secrets:{},captureCollection:mail});
 const publisher=createSocialPublisher({social:resolveSocialConfig({GROWTH_SOCIAL_PROVIDER:'sandbox'}),sandboxCollection:social,fetchImpl});
 const results=[];
 for(const campaign of before.campaigns){
  if(campaign.decision!=='ELIGIBLE_FOR_OWNER_REVIEW'){results.push({campaignId:campaign.id,decision:'HOLD',blockers:campaign.blockers});continue;}
  const d=await source.findOne({id:campaign.id});
  for(const channel of (d.kind==='pr'?['email']:['facebook','instagram','x','tiktok'])){
   if(channel!=='email'&&d.platformCopy?.[channel]?.ready!==true){results.push({campaignId:d.id,channel,decision:'HOLD',blockers:d.platformCopy?.[channel]?.blockers||['verified_supported_destination_required']});continue;}
   const id='qa-'+digest([d.id,channel,d.subject,d.text,d.posts]).slice(0,32),prior=await claims.findOne({id});
   if(prior){results.push({campaignId:d.id,channel,decision:prior.state==='captured'?'PASS_REPLAY_NO_NEW_CAPTURE':'HOLD',qaId:id,reason:prior.state==='captured'?'idempotent_capture_reused':'prior_qa_attempt_requires_review'});continue;}
   try{await claims.insertOne({id,sourceDraftId:d.id,channel,state:'claimed',synthetic:true,createdAt:new Date().toISOString()});}catch(e){if(e.code!==11000)throw e;results.push({campaignId:d.id,channel,decision:'HOLD',reason:'simultaneous_qa_claim'});continue;}
   let result;
   if(channel==='email'){
    const unsubscribe='https://www.fantasymmadness.com/growth/unsubscribe?token=STAGING_QA_ONLY_NOT_A_REAL_SUBSCRIPTION';
    const copy={...d,id,recipient:'growth-qa@fixture.invalid',status:'approved',ownerApproved:true,sendPermitted:true,listUnsubscribe:unsubscribe,text:String(d.text||'')+'\n\nQA unsubscribe: '+unsubscribe,synthetic:true,approvalAuthority:'explicit_isolated_test_fixture_only'};
    const refused=await provider.send({...copy,ownerApproved:false});if(refused.ok)throw Error('qa_approval_gate_failed');
    result=await provider.send(copy);const replay=await provider.send(copy);if(result.receipt?.providerMessageId!==replay.receipt?.providerMessageId)throw Error('qa_email_idempotency_failed');
   }else{
    const raw=d.poster?.portrait?.url||d.poster?.portrait?.imageUrl||d.contest?.posterUrl;
    const imageUrl=raw?new URL(raw,'https://fantasymmadness-growth-git-585652-kelly-davis-projects-6c108d0b.vercel.app').href:null;
    result=await publisher.publish({id,channel,text:d.posts?.[channel]||d.text,imageUrl,synthetic:true});
   }
   const captured=result.ok===true&&(channel==='email'?result.receipt?.realDelivery===false:result.receipt?.sandbox===true);
   await claims.updateOne({id},{$set:{state:captured?'captured':'held',reason:captured?null:'sandbox_preflight_held',completedAt:new Date().toISOString(),networkDelivery:false}});
   results.push({campaignId:d.id,channel,decision:captured?'PASS_CAPTURE_ONLY':'HOLD',qaId:id,...(!captured?{reason:'sandbox_preflight_held'}:{})});
  }
 }
 return{checkedAt:new Date().toISOString(),database:'fmgrowthtest',collectionPrefix:'preview198_launch_qa_',synthetic:true,results,sourceApprovalFlagsUnchanged:original===digest(await protectedState()),capturedEmails:await mail.countDocuments(),capturedSocial:await social.countDocuments(),realDeliveries:0,realSocialPosts:0,publishingEnabled:false,outboundEnabled:false};
}
module.exports={deliveryAcceptance};
