'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {WORKERS,GENRES,runDiscovery}=require('./growth-ten-agent-discovery');
test('ten workers cover five genres and two focuses',()=>{assert.equal(WORKERS.length,10);assert.equal(GENRES.length,5);for(const genre of GENRES){assert.deepEqual(WORKERS.filter(x=>x.genre===genre).map(x=>x.focus),['fans','partners'])}});
test('discovery deduplicates cross-genre prospects and never sends',async()=>{const calls=[];const out=await runDiscovery({discover:async w=>{calls.push(w.id);return [{name:'Combat creator',url:'https://example.org/creator',source:'fixture'}]}});assert.equal(calls.length,10);assert.equal(out.uniqueProspects,1);assert.equal(out.outboundEnabled,false);assert.equal(out.errors.length,0)});
test('unsafe and malformed records rejected',async()=>{const out=await runDiscovery({discover:async()=>[{name:'Bad',url:'javascript:alert(1)'},{name:'Valid',url:'https://example.org/valid'}]});assert.equal(out.uniqueProspects,1)});
test('one failing worker does not halt remaining workers',async()=>{const out=await runDiscovery({discover:async w=>{if(w.id==='discovery-1')throw Error('fixture outage');return []}});assert.equal(out.errors.length,1);assert.equal(out.workersConfigured,10)});
test('source adapter is mandatory',async()=>{await assert.rejects(runDiscovery(),/adapter required/)});
