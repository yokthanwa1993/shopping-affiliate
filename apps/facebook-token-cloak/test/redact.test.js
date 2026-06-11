'use strict';
const {test}=require('node:test'); const assert=require('node:assert/strict'); const {redactToken,sanitizeUrlSecrets,redactObjectSecrets}=require('../src/redact');
test('redacts tokens and nested secrets',()=>{assert.equal(redactToken('EAAB123456'),'EAAB12…[REDACTED]'); assert.ok(!sanitizeUrlSecrets('https://x/#access_token=EAABSECRET').includes('EAABSECRET')); assert.equal(redactObjectSecrets({password:'pw',nested:{access_token:'tok'}}).nested.access_token,'[REDACTED]');});
