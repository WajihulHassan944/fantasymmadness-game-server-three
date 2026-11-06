import audit from '../src/link-audit.cjs';
export async function affiliateLinkAudit(){
 'use workflow';
 return await inspectAffiliateLinks();
}
export async function inspectAffiliateLinks(){
 'use step';
 return audit.inspect();
}
inspectAffiliateLinks.maxRetries=1;
