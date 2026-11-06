'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const baseline=require('./docs/evidence/issue203/nov5-presentation-parity.json').filter(x=>x.file.startsWith('growth-console/'));
test('approved November 5 dashboard assets stay byte-identical during worker and campaign repairs',()=>{assert.equal(baseline.length,3);for(const f of baseline)assert.equal(crypto.createHash('sha256').update(fs.readFileSync(f.file)).digest('hex'),f.sha256,f.file);});
