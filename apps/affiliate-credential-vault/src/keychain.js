'use strict';
const childProcess = require('child_process');
const SERVICE_PREFIX = 'com.affiliate.credential-vault';
function isSupported() { return process.platform === 'darwin'; }
function safePart(v) { return String(v == null ? '' : v).trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0,80) || 'default'; }
function service(provider, account, kind) { return `${SERVICE_PREFIX}.${safePart(provider)}.${safePart(account)}.${safePart(kind)}`; }
function runSecurity(args, input) { return new Promise((resolve,reject)=>{ const p=childProcess.spawn('/usr/bin/security', args, {stdio:['pipe','pipe','pipe']}); let out='',err=''; p.stdout.on('data',d=>out+=d); p.stderr.on('data',d=>err+=d); p.on('error',reject); p.on('close',code=> code===0 ? resolve(out) : reject(Object.assign(new Error(err.trim()||`security exited ${code}`),{code,stderr:err}))); if(input!=null) p.stdin.end(input); else p.stdin.end(); }); }
async function saveSecret(provider, account, kind, value) { if(!isSupported()) return { saved:false, status:'keychain_unsupported' }; const v=String(value==null?'':value); if(!v) return { saved:false, status:'empty_secret_skipped' }; const svc=service(provider,account,kind); const acct=safePart(account); await runSecurity(['delete-generic-password','-s',svc,'-a',acct]).catch(()=>{}); await runSecurity(['add-generic-password','-U','-s',svc,'-a',acct,'-w',v]); return { saved:true, status:'secret_saved' }; }
async function deleteSecret(provider, account, kind) { if(!isSupported()) return { deleted:false, status:'keychain_unsupported' }; await runSecurity(['delete-generic-password','-s',service(provider,account,kind),'-a',safePart(account)]).catch(()=>{}); return { deleted:true }; }
async function hasSecret(provider, account, kind) { if(!isSupported()) return false; try { await runSecurity(['find-generic-password','-s',service(provider,account,kind),'-a',safePart(account)]); return true; } catch { return false; } }
async function status(provider, account) { return { passwordPresent: await hasSecret(provider,account,'password'), totpPresent: await hasSecret(provider,account,'totp') }; }
async function purge(provider, account) { await deleteSecret(provider,account,'password'); await deleteSecret(provider,account,'totp'); }
module.exports = { SERVICE_PREFIX, isSupported, saveSecret, deleteSecret, hasSecret, status, purge, service };
