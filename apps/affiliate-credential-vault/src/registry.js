'use strict';
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const SECRET_KEYS = /(^|_)(password|token|cookie|secret|datr|machine_id|totp|authorization)s?($|_)/i;
function defaultPath() { return process.env.AFFILIATE_CREDENTIAL_VAULT_REGISTRY || path.join(os.homedir(), '.affiliate-credential-vault', 'registry.json'); }
function sanitizeProvider(v) { const p=String(v||'').trim().toLowerCase(); if(!['facebook','shopee'].includes(p)) throw new Error('Unsupported provider'); return p; }
function sanitizeAccount(v) { const raw=String(v==null?'':v).trim(); if(!raw) throw new Error('Missing account'); const cleaned=raw.replace(/[^A-Za-z0-9._-]/g,'_').slice(0,80); if(!cleaned) throw new Error('Invalid account'); return cleaned; }
function checkSecrets(obj, prefix='') { if(!obj || typeof obj!=='object') return; for(const [k,v] of Object.entries(obj)){ const key=prefix?`${prefix}.${k}`:k; if(SECRET_KEYS.test(k)) throw new Error(`Forbidden registry field: ${key}`); if(v && typeof v==='object') checkSecrets(v,key); } }
function normalizeRecord(input) { checkSecrets(input); const provider=sanitizeProvider(input.provider); const account=sanitizeAccount(input.account); return { provider, account, key:`${provider}:${account.toLowerCase()}`, displayName: String(input.displayName||'').trim()||null, username: String(input.username||'').trim()||null, affiliateId: String(input.affiliateId||'').trim()||null, profileAlias: String(input.profileAlias||'').trim()||account, updatedAt: new Date().toISOString() }; }
async function readRegistry(configPath=defaultPath()) { try { const raw=await fs.readFile(configPath,'utf8'); const data=JSON.parse(raw); checkSecrets(data); return data && typeof data==='object' && data.records ? data : { records:{} }; } catch(e){ if(e.code==='ENOENT') return { records:{} }; throw e; } }
async function writeRegistry(data, configPath=defaultPath()) { checkSecrets(data); await fs.mkdir(path.dirname(configPath),{recursive:true,mode:0o700}); await fs.writeFile(configPath, JSON.stringify(data,null,2), {mode:0o600}); try { await fs.chmod(configPath,0o600); } catch {} }
async function list(configPath) { const data=await readRegistry(configPath); return Object.values(data.records).sort((a,b)=>a.provider.localeCompare(b.provider)||a.account.localeCompare(b.account)); }
async function upsert(input, configPath) { const rec=normalizeRecord(input); const data=await readRegistry(configPath); data.records[rec.key]=rec; await writeRegistry(data,configPath); return rec; }
async function remove(provider, account, configPath) { const p=sanitizeProvider(provider); const a=sanitizeAccount(account); const key=`${p}:${a.toLowerCase()}`; const data=await readRegistry(configPath); const existed=!!data.records[key]; delete data.records[key]; await writeRegistry(data,configPath); return { removed: existed, provider:p, account:a }; }
module.exports={SECRET_KEYS, defaultPath, sanitizeProvider, sanitizeAccount, normalizeRecord, readRegistry, writeRegistry, list, upsert, remove};
