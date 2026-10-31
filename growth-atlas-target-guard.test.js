'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateIsolatedAtlasTarget}=require('./growth-atlas-target-guard');
test('rejects non-Atlas and alternate database URIs',()=>{
 for(const uri of ['', 'http://example.invalid', 'mongodb://example.invalid', 'mongodb+srv://example.invalid/production','mongodb+srv://example.invalid/admin']){
  assert.throws(()=>validateIsolatedAtlasTarget(uri));
 }
});
test('accepts Atlas default and dedicated database paths',()=>{
 assert.equal(validateIsolatedAtlasTarget('mongodb+srv://example.invalid/'),true);
 assert.equal(validateIsolatedAtlasTarget('mongodb+srv://example.invalid/fmgrowthtest'),true);
});
