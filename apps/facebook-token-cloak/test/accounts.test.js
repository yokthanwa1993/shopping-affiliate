'use strict';
const {test}=require('node:test'); const assert=require('node:assert/strict'); const {sanitizeAccount}=require('../src/accounts');
test('sanitizeAccount normalizes and rejects unsafe input',()=>{
  assert.deepEqual(sanitizeAccount(' Chearb-1 '),{key:'chearb-1',display:'CHEARB-1'});
  for(const v of ['',null,undefined,'../x','a/b','a\\b','bad\n']) assert.throws(()=>sanitizeAccount(v));
});
