import {sleep, getWorkflowMetadata} from 'workflow';
import {start} from 'workflow/api';
import worker from '../src/runtime.cjs';
export async function sandboxLoop(generation:string,ordinal=0){
 'use workflow';
 for(let i=0;i<96;i++){
  let r;
  try { r=await executeCycle(generation,ordinal+i); }
  catch { r={stop:false}; } // Retry budget exhausted: retain the failure, retry on the next timer.
  if(r.stop)return;
  await sleep(ordinal+i<2?'65s':'15m');
 }
 await start(sandboxLoop,[generation,ordinal+96],{experimental_hook:{token:`growth:${generation}:${ordinal+96}`}});
}
export async function executeCycle(generation:string,ordinal:number){
 'use step';
 return worker.cycle(generation,ordinal,getWorkflowMetadata());
}
executeCycle.maxRetries=3;
