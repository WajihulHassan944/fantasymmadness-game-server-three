import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const bundle=await readFile(new URL('../.vercel/output/functions/__server.func/index.mjs',import.meta.url),'utf8');
for(const name of ['growthEmergencyQueueAudit','growthRecipientSourceReview'])assert.match(bundle,new RegExp('workflow//[^"\\s]+//'+name),'registered workflow: '+name);
for(const file of ['queue-audit.cjs','recipient-source-review.cjs']){const source=await readFile(new URL('../src/'+file,import.meta.url),'utf8');assert.ok(!source.includes('runtime()'),'audit must not activate a scheduler');assert.ok(source.includes("client.db('fmgrowthtest')"),'explicit isolated database');}
console.log('Both controlled audit workflows are compiled; audit helpers never activate scheduling.');
