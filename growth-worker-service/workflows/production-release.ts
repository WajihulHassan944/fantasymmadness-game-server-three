import {start} from 'workflow/api';
import preparation from '../src/production-preparation.cjs';
import {productionPreparationLoop} from './production-preparation';
export async function activateVerifiedProductionPreparation(){
 'use workflow';
 const initial=await activateProductionPreparation();
 const run=await start(productionPreparationLoop,[initial.scheduler.generation,0],{experimental_hook:{token:`production-preparation:${initial.scheduler.generation}:0`}});
 return {environment:'production',database:initial.database,preparationWorkflowRunId:run.runId,publishingEnabled:false,outboundEnabled:false};
}
export async function activateProductionPreparation(){
 'use step';
 const c=await preparation.context();
 const before=await preparation.inspectDeployed();if(before.operations.realDeliveriesObserved||before.operations.liveSocialPostsObserved)throw Error('existing_external_delivery_requires_review');
 await c.activate({deploymentId:process.env.VERCEL_DEPLOYMENT_ID,confirmation:'ACTIVATE PRODUCTION PREPARATION ONLY'});
 return c.status();
}
activateProductionPreparation.maxRetries=0;
export async function stopProductionPreparation(){
 'use workflow';
 return await emergencyStopProductionPreparation();
}
export async function emergencyStopProductionPreparation(){
 'use step';
 const c=await preparation.context();await c.stop();return c.status();
}
emergencyStopProductionPreparation.maxRetries=0;
export async function inspectProductionPreparation(){
 'use workflow';
 return await inspectProductionPreparationState();
}
export async function inspectProductionPreparationState(){
 'use step';
 return preparation.inspectDeployed();
}
inspectProductionPreparationState.maxRetries=0;
