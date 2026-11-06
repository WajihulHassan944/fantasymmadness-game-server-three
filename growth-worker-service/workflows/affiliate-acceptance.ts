import acceptance from '../src/affiliate-acceptance.cjs';
export async function affiliateStagingAcceptance(){
 'use workflow';
 return await executeAffiliateAcceptance();
}
export async function executeAffiliateAcceptance(){
 'use step';
 return acceptance.inspect();
}
executeAffiliateAcceptance.maxRetries=0;
