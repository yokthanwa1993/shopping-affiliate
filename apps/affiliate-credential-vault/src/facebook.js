'use strict';
const http = require('http');
const BRIDGE = process.env.AFFILIATE_CREDENTIAL_VAULT_FACEBOOK_BRIDGE || 'http://127.0.0.1:8820';
function fetchHealth(timeoutMs=5000){ return new Promise(resolve=>{ const req=http.get(`${BRIDGE}/health`,{timeout:timeoutMs},res=>{let raw='';res.on('data',d=>raw+=d);res.on('end',()=>resolve({ok:res.statusCode>=200&&res.statusCode<300,statusCode:res.statusCode,raw:raw.slice(0,300)}));}); req.on('timeout',()=>req.destroy(new Error('timeout'))); req.on('error',e=>resolve({ok:false,statusCode:0,error:e.message})); }); }
function loginUrl(account){ const a=encodeURIComponent(String(account||'').trim()||'default'); return `${BRIDGE}/login?account=${a}&visible=1&autofill=1&submit=0`; }
module.exports={BRIDGE, fetchHealth, loginUrl};
