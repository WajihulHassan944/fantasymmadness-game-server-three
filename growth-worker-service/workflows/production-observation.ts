import observer from '../src/production-observation.cjs';
export async function productionReadOnlyObservation(){
 'use workflow';
 return await inspectProductionPreparationHolds();
}
export async function inspectProductionPreparationHolds(){
 'use step';
 return observer.inspect();
}
inspectProductionPreparationHolds.maxRetries=0;
