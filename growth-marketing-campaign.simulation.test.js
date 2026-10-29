'use strict';
// A full DRY RUN using the existing fight campaign builder. No email, network, social API,
// database writes, production URLs opened, or real fight data. All contacts are fictional.
const assert=require('node:assert/strict');
const core=require('./fan-acquisition-fight-campaigns');
const {isFightOpenForEntry,getFightEntryLockTime}=require('./fight-entry-time');
const {affiliateLeagueFightLink,affiliatePaidFightLink}=require('./affiliate-custom-poster');
const NOW=Date.UTC(2026,10,1,15);
const fight={_id:'6a1b2c3d4e5f6a7b8c9d0e1f',matchFighterA:'Test Red',matchFighterB:'Test Blue',matchName:'SIMULATION ONLY',matchCategory:'boxing',matchStatus:'Scheduled',matchType:'LIVE',matchDate:new Date('2026-11-07T00:00:00Z'),matchDateKey:'2026-11-07',matchTime:'22:00',eventTimeZone:'America/New_York',venue:'Simulation Arena',eventCity:'Test City',fightPosterImage:'https://example.invalid/synthetic-poster.png',matchBy:'admin'};
const result=core.buildFightCampaign({fight,source:'match',isOpen:f=>isFightOpenForEntry(f,NOW),isPublic:f=>core.isPublicFight(f,'match'),getLockTime:getFightEntryLockTime,affiliateLeagueFightLink,affiliatePaidFightLink,now:NOW});
assert.ok(result.campaign,'existing campaign builder must generate a draft');
const campaign=result.campaign;
assert.equal(campaign.state,'draft');
assert.ok(campaign.matchup.includes('Test Red')&&campaign.matchup.includes('Test Blue'));
assert.deepEqual(Object.keys(campaign.channels),['instagram','facebook','x','affiliate_email']);
const prospects=[{id:'synthetic-affiliate-1',type:'fighter',name:'Example Fighter',contact:'example@invalid.test',approved:false},{id:'synthetic-media-1',type:'media',name:'Example Sports Desk',contact:'press@invalid.test',approved:false}];
const outreach=prospects.map(p=>({id:p.id,channel:'email',subject:p.type==='media'?'FANTASY MMADNESS fight engagement story':'Join FANTASY MMADNESS as an affiliate',body:'Hello '+p.name+', we would like to explore a combat-sports partnership around '+campaign.matchup+'.',status:'draft',sent:false}));
const schedule=Object.entries(campaign.channels).filter(([,ch])=>ch.enabled).map(([channel])=>({channel,status:'simulated_queued',published:false}));
const simulatedMetrics={impressions:0,visits:0,signups:0,verifiedPaidEntries:0,actualRevenueCents:0};
assert.equal(outreach.length,2);
assert.ok(outreach.every(x=>!x.sent&&x.status==='draft'));
assert.ok(schedule.every(x=>!x.published));
assert.equal(simulatedMetrics.verifiedPaidEntries,0);
const report={mode:'SIMULATION_ONLY',campaign:{matchup:campaign.matchup,state:campaign.state,channels:Object.keys(campaign.channels)},prospects:prospects.map(({id,type,name})=>({id,type,name})),outreach:outreach.map(({id,status,sent})=>({id,status,sent})),schedule,metrics:simulatedMetrics,externalActions:0};
console.log('SIMULATED MARKETING CAMPAIGN REPORT '+JSON.stringify(report));
