'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {planWorkstreams,distribute}=require('./growth-global-workstreams');
test('25 unique global workstreams',()=>{const p=planWorkstreams();assert.equal(p.length,25);assert.equal(new Set(p.map(x=>x.id)).size,25);assert.ok(p.every(x=>x.requiresAuthorizedAdapter))});
test('scales beyond fixed agent count',()=>{const p=planWorkstreams({functions:['audience','marketing','public-relations','affiliate-recruitment','performance','research','reporting']});assert.equal(p.length,35);assert.deepEqual(distribute({workers:p,capacity:10}).map(x=>x.length),[10,10,10,5])});
test('duplicate workstream identifiers removed',()=>{assert.equal(planWorkstreams({genres:['boxing','boxing'],functions:['audience']}).length,1)});
test('invalid capacity rejected',()=>assert.throws(()=>distribute({workers:[],capacity:0})));
