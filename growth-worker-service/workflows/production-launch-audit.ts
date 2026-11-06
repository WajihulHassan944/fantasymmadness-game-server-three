import audit from '../src/production-launch-audit.cjs';
export async function productionLaunchAudit(){
 'use workflow';
 return await inspectProductionReadiness();
}
export async function inspectProductionReadiness(){
 'use step';
 return audit.inspect();
}
inspectProductionReadiness.maxRetries=0;
