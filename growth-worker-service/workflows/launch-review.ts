import review from '../src/launch-review.cjs';
export async function growthLaunchReview(){
 'use workflow';
 return await inspectLaunchReview();
}
export async function inspectLaunchReview(){
 'use step';
 return review.inspect();
}
inspectLaunchReview.maxRetries=0;
