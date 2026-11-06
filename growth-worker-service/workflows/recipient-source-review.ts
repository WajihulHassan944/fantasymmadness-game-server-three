import review from '../src/recipient-source-review.cjs';
export async function growthRecipientSourceReview(){
 'use workflow';
 return await inspectRecipientSources();
}
export async function inspectRecipientSources(){
 'use step';
 return review.inspect();
}
inspectRecipientSources.maxRetries=0;
