import {cpSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {defineNitroConfig} from 'nitro/config';
export default defineNitroConfig({preset:'vercel',hooks:{compiled(nitro){cpSync(resolve('../growth-assets'),join(nitro.options.output.serverDir,'growth-assets'),{recursive:true});cpSync(resolve('../growth-production-console'),join(nitro.options.output.serverDir,'growth-production-console'),{recursive:true});}},modules:['workflow/nitro'],vercel:{entryFormat:'node'},routes:{'/**':{handler:'./src/index.ts',format:'node'}}});
