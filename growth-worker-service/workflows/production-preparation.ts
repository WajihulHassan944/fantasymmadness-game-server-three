import {sleep,getWorkflowMetadata} from 'workflow';
import {start} from 'workflow/api';
import preparation from '../src/production-preparation.cjs';
export async function productionPreparationLoop(generation:string,ordinal=0){
 'use workflow';
 for(let i=0;i<96;i++){
  let result;try{result=await executeProductionPreparation(generation,ordinal+i);}catch{result={stop:false};}
  if(result.stop)return;
  await sleep('15m');
 }
 await start(productionPreparationLoop,[generation,ordinal+96],{experimental_hook:{token:`production-preparation:${generation}:${ordinal+96}`}});
}
export async function executeProductionPreparation(generation:string,ordinal:number){
 'use step';
 return preparation.cycle(generation,ordinal,getWorkflowMetadata());
}
executeProductionPreparation.maxRetries=3;
