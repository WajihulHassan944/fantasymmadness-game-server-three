import acceptance from '../src/launch-delivery.cjs';
export async function growthLaunchDeliveryAcceptance(){
 'use workflow';
 return await executeLaunchDeliveryAcceptance();
}
export async function executeLaunchDeliveryAcceptance(){
 'use step';
 return acceptance.inspect();
}
executeLaunchDeliveryAcceptance.maxRetries=0;
