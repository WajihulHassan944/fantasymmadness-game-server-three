import audit from '../src/queue-audit.cjs';
export async function growthEmergencyQueueAudit(){
 'use workflow';
 return await inspectQueue();
}
export async function inspectQueue(){
 'use step';
 return audit.inspect();
}
inspectQueue.maxRetries=0;
