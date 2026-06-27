'use strict';
const path=require('path'); const os=require('os'); const crypto=require('crypto'); const {sanitizeAccount}=require('./accounts');

const TWO_FACTOR_SELECTORS=[
  'input[name="approvals_code"]',
  'input#approvals_code',
  'input[autocomplete="one-time-code"]',
  'input[name="code"]',
  // Thai authenticator-code step renders a single input labelled "รหัส" that may have no name=code.
  'input[aria-label*="รหัส" i]',
  'input[placeholder*="รหัส" i]'
];
const TWO_FACTOR_SUBMIT_SELECTORS=[
  '#checkpointSubmitButton',
  'button[name="submit[Continue]"]',
  'button[type="submit"]',
  '[type="submit"]',
  'div[role="button"][aria-label*="Continue" i]'
];
const PROFILE_ROOT=process.env.FACEBOOK_TOKEN_CLOAK_PROFILE_ROOT||path.join(os.homedir(),'.facebook-token-cloak','profiles');
// Test seam: inject a fake browser backend so the reuse/launch logic can be exercised without a
// real Chromium. Never used in production (override stays null unless setBrowserBackend is called).
let _backendOverride=null;
function setBrowserBackend(launcher,backend='mock'){ _backendOverride=launcher?{backend,launcher}:null; }
async function loadBrowserBackend(){
  if(_backendOverride) return _backendOverride;
  const chromeExecutable=String(process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_EXECUTABLE||process.env.FACEBOOK_TOKEN_CLOAK_CHROME_EXECUTABLE||process.env.CHROME_EXECUTABLE_PATH||'').trim();
  if(chromeExecutable){
    try{
      const {chromium}=require('playwright-core');
      return {
        backend:'browser-executable',
        executablePath:chromeExecutable,
        launcher:{
          launchPersistentContext:(profileDir,options={})=>chromium.launchPersistentContext(profileDir,{...options,executablePath:chromeExecutable})
        }
      };
    }catch{}
  }
  try{const cloak=require('cloakbrowser'); if(cloak&&typeof cloak.launchPersistentContext==='function') return {backend:'cloakbrowser',launcher:cloak};}catch{}
  try{const {chromium}=require('playwright-core'); return {backend:'playwright-core',launcher:chromium};}catch{}
  throw Object.assign(new Error('No browser backend found. Install cloakbrowser or playwright-core.'),{code:'browser_backend_missing'});
}
function profileDirFor(accountKey){return path.join(PROFILE_ROOT,accountKey)}

function pidExists(pid){
  const n=Number(pid);
  if(!Number.isInteger(n)||n<=0) return false;
  try{ process.kill(n,0); return true; }
  catch(e){ return e&&e.code==='EPERM'; }
}
function singletonLockPid(profileDir){
  try{
    const fs=require('fs');
    const lock=path.join(profileDir,'SingletonLock');
    const target=fs.readlinkSync(lock);
    const m=String(target||'').match(/-(\d+)$/);
    return m?Number(m[1]):0;
  }catch{ return 0; }
}
function clearStaleProfileSingletons(profileDir){
  const fs=require('fs');
  const pid=singletonLockPid(profileDir);
  if(pid&&pidExists(pid)) return false;
  let removed=false;
  for(const name of ['SingletonLock','SingletonCookie','SingletonSocket']){
    const f=path.join(profileDir,name);
    try{ fs.rmSync(f,{force:true}); removed=true; }catch{}
  }
  return removed;
}

// ── Per-account persistent-context reuse ───────────────────────────────────────────────────────
// A persistent profile dir can only be opened by ONE Chromium at a time — Chromium guards it with a
// SingletonLock. The visible login flow used to call launchPersistentContext on every /login, so a
// second open of an account whose window was already up threw the lock error and surfaced as a
// generic HTTP 500 ("old session disappeared"). We now keep the live context this process owns per
// account and reuse it instead of launching twice. Scoped to this server process.
const _accountContexts=new Map();   // key -> { backend, profileDir, context }
const _accountContextLaunches=new Map(); // key -> in-flight launch promise (dedupe concurrent opens)
function resetAccountContexts(){ _accountContexts.clear(); _accountContextLaunches.clear(); }
// Liveness probe. A persistent context exposes browser().isConnected(); when it is unavailable
// (mock/unknown backend) we optimistically treat the cached context as usable.
function isContextAlive(context){
  if(!context) return false;
  try{
    if(typeof context.browser==='function'){
      const b=context.browser();
      if(b&&typeof b.isConnected==='function') return !!b.isConnected();
    }
  }catch{ return false; }
  return true;
}
function forgetAccountContext(key,context){ const cur=_accountContexts.get(key); if(cur&&(!context||cur.context===context)) _accountContexts.delete(key); }
// Non-launching peek at the live cached context this process already owns for the account (the one a
// visible /login left open). Returns the entry only when it is still alive; evicts and returns null
// when it has since closed. NEVER launches a new persistent context — this is what posting's
// session-token resolution uses to decide whether an operator-visible session is reusable, so it can
// avoid a second SingletonLock-locked launch on the same profile dir without keeping a window open.
function peekAccountContext(rawAccount){
  const {key}=sanitizeAccount(rawAccount);
  const existing=_accountContexts.get(key);
  if(existing&&isContextAlive(existing.context)) return {backend:existing.backend,profileDir:existing.profileDir,context:existing.context};
  if(existing) _accountContexts.delete(key);
  return null;
}
// Patterns for a launchPersistentContext failure caused by the profile dir already being open in
// another (often orphaned/external) Chromium holding the SingletonLock. Mapped to a stable, non-
// secret code so the route can answer profile_already_open instead of a generic 500.
const PROFILE_LOCK_PATTERNS=/ProcessSingleton|SingletonLock|Singleton|user data directory is already in use|profile (?:is )?(?:in use|locked|already)|already (?:in use|running|open)|cannot create|being used by another|lock(?:ed|file)?/i;
function classifyLaunchError(error,profileDir){
  const msg=String((error&&(error.message||error.code))||'');
  if(PROFILE_LOCK_PATTERNS.test(msg)){
    return Object.assign(new Error('Profile is already open in another browser process'),{code:'profile_already_open',profileDir});
  }
  return error;
}
async function launchPersistentContext(rawAccount,options={}){
  const {key}=sanitizeAccount(rawAccount);
  const {backend,launcher}=await loadBrowserBackend();
  const profileDir=profileDirFor(key);
  clearStaleProfileSingletons(profileDir);
  let context;
  try{
    context=await launcher.launchPersistentContext(profileDir,{headless:options.visible===false,args:['--disable-blink-features=AutomationControlled','--no-first-run','--no-default-browser-check'],...options.launchOptions});
  }catch(e){
    clearStaleProfileSingletons(profileDir);
    throw classifyLaunchError(e,profileDir);
  }
  return {backend,profileDir,context};
}
// Reuse the live context this process already holds for the account (preserving its cookies/session
// and avoiding a second SingletonLock-locked launch); only launch when there is none or it closed.
// Concurrent opens for the same account share one launch. The 'close' event evicts the entry so a
// later call relaunches a fresh window instead of handing back a dead context.
async function acquireAccountContext(rawAccount,options={}){
  const {key}=sanitizeAccount(rawAccount);
  const existing=_accountContexts.get(key);
  if(existing&&isContextAlive(existing.context)) return {...existing,reused:true};
  if(existing) _accountContexts.delete(key);
  if(_accountContextLaunches.has(key)){ const entry=await _accountContextLaunches.get(key); return {...entry,reused:true}; }
  const launchPromise=(async()=>{
    const launched=await launchPersistentContext(rawAccount,options);
    try{ if(launched.context&&typeof launched.context.on==='function') launched.context.on('close',()=>forgetAccountContext(key,launched.context)); }catch{}
    const entry={backend:launched.backend,profileDir:launched.profileDir,context:launched.context};
    _accountContexts.set(key,entry);
    return entry;
  })();
  _accountContextLaunches.set(key,launchPromise);
  try{ const entry=await launchPromise; return {...entry,reused:false}; }
  finally{ _accountContextLaunches.delete(key); }
}
// openPage with three modes (the returned object always carries a `reused` boolean so the caller can
// decide whether closeSession should close the context):
//   reuse:true          interactive /login — reuse-or-launch-and-CACHE the per-account context so a
//                       second /login navigates the same window instead of locking the profile dir.
//   reuseIfPresent:true posting/session-token resolution — REUSE the live cached context an operator's
//                       visible /login already left open (reused:true, never closed by closeSession),
//                       but when there is none, launch a FRESH one-off context (reused:false, NOT
//                       cached) that closeSession closes after the request. This is the fix for the
//                       no_session bug: it never launches a second locked persistent context on a
//                       profile whose window is already up.
//   default             posting's original ephemeral open→closeSession lifecycle — a fresh one-off
//                       context (reused:false), unchanged.
async function openPage(rawAccount,url,options={}){
  let launched; let reused=false;
  if(options.reuse){
    launched=await acquireAccountContext(rawAccount,options);
    reused=!!launched.reused;
  }else if(options.reuseIfPresent){
    const existing=peekAccountContext(rawAccount);
    if(existing){ launched=existing; reused=true; }
    else { launched=await launchPersistentContext(rawAccount,options); reused=false; }
  }else{
    launched=await launchPersistentContext(rawAccount,options);
    reused=false;
  }
  const page=(launched.context.pages&&launched.context.pages()[0])||await launched.context.newPage();
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:options.timeoutMs||60000});
  return {backend:launched.backend,profileDir:launched.profileDir,context:launched.context,reused,page};
}
// Locator-based presence check; best-effort, never throws.
async function firstPresentSelector(page,selectors){
  if(typeof page.locator!=='function') return null;
  for(const sel of selectors){ try{ if(await page.locator(sel).first().count()) return sel; }catch{} }
  return null;
}
// Click the first visible match and return the selector that was clicked (or null). Returning the
// selector lets callers report a precise submitMethod instead of a generic label.
async function clickFirstPresent(page,selectors){
  if(typeof page.locator!=='function') return null;
  for(const sel of selectors){
    try{
      const locator=page.locator(sel);
      const count=await locator.count();
      for(let i=0;i<count;i++){
        const candidate=locator.nth(i);
        const visible=await candidate.isVisible({timeout:1000}).catch(()=>false);
        if(!visible) continue;
        await candidate.scrollIntoViewIfNeeded({timeout:2000}).catch(()=>{});
        await candidate.click({timeout:5000});
        return sel;
      }
    }catch{}
  }
  return null;
}
async function waitForLoginSettled(page){
  await Promise.race([
    page.waitForLoadState('networkidle',{timeout:12000}).catch(()=>{}),
    page.waitForURL(u=>!/\/login(?:\?|$)/.test(String(u)),{timeout:12000}).catch(()=>{}),
    page.waitForTimeout(12000)
  ]).catch(()=>{});
}
async function clickTextLike(page,patterns){
  if(typeof page.locator!=='function') return false;
  for(const pattern of patterns){
    try{
      const locator=page.getByText ? page.getByText(pattern,{exact:false}) : page.locator(`text=${pattern}`);
      const count=await locator.count();
      for(let i=0;i<count;i++){
        const candidate=locator.nth(i);
        if(!(await candidate.isVisible({timeout:1000}).catch(()=>false))) continue;
        await candidate.scrollIntoViewIfNeeded({timeout:2000}).catch(()=>{});
        await candidate.click({timeout:5000});
        return true;
      }
    }catch{}
  }
  return false;
}
// Text patterns for the Meta 2FA method chooser (Thai + English). "Try another way" opens the
// chooser; the authenticator patterns cover both Thai spellings แอพ/แอป; Continue confirms it.
const TRY_ANOTHER_WAY_PATTERNS=[
  /try another way/i,
  /choose another way/i,
  /use another method/i,
  /other ways to/i,
  /ลองวิธีอื่น/i,
  /เลือกวิธีอื่น/i,
  /ใช้วิธีอื่น/i,
  /วิธีอื่น/i
];
const AUTHENTICATOR_METHOD_PATTERNS=[
  /authentication app/i,
  /authenticator app/i,
  /code generator/i,
  /login code/i,
  /security code/i,
  /รหัสยืนยัน/i,
  /แอพยืนยันตัวตน/i,   // Thai spelling with พ
  /แอปยืนยันตัวตน/i,   // Thai spelling with ป
  /แอ(?:พ|ป).*ยืนยัน/i,
  /ตัวสร้างรหัส/i
];
const CONTINUE_PATTERNS=[
  /^continue$/i,
  /continue/i,
  /^next$/i,
  /^submit$/i,
  /ดำเนินการต่อ/i,
  /ถัดไป/i,
  /ต่อไป/i
];
// True when the URL looks like a 2FA/checkpoint/passkey screen — used to decide whether to drive
// the method chooser when no code input is visible yet.
function looksLikeTwoFactorUrl(url){
  return /two_step_verification|two_factor|two-factor|checkpoint|auth_platform|passkey|webauthn|security_key|2fa/i.test(String(url||''));
}
function currentUrlOf(page){ return typeof page.url==='function'?String(page.url()||''):''; }
// Walk the Meta security-key/passkey screen to the authenticator-app code method:
//   1) dismiss the browser's native WebAuthn/security-key prompt (Escape)
//   2) "Try another way" / "ลองวิธีอื่น" to open the method chooser
//   3) select the authenticator-app / code-generator method (Thai แอพ/แอป or English)
//   4) "Continue" / "ดำเนินการต่อ" to confirm, revealing the 6-digit code input
// Returns redacted boolean flags describing what was actioned (no secrets).
async function chooseTwoFactorCodeMethod(page){
  const outcome={webauthnDismissed:false,switchedMethod:false,selectedAuthenticatorApp:false,confirmedMethod:false};
  try{ await page.keyboard.press('Escape'); outcome.webauthnDismissed=true; }catch{}
  await page.waitForTimeout(500).catch(()=>{});
  outcome.switchedMethod=await clickTextLike(page,TRY_ANOTHER_WAY_PATTERNS);
  await page.waitForTimeout(1000).catch(()=>{});
  outcome.selectedAuthenticatorApp=await clickTextLike(page,AUTHENTICATOR_METHOD_PATTERNS);
  await page.waitForTimeout(500).catch(()=>{});
  // Only a method chooser shows a Continue/ดำเนินการต่อ confirm; click it to reach the code input.
  if(outcome.selectedAuthenticatorApp||outcome.switchedMethod){
    outcome.confirmedMethod=await clickTextLike(page,CONTINUE_PATTERNS);
    await page.waitForTimeout(1000).catch(()=>{});
  }
  return outcome;
}

// After a successful TOTP, Meta shows /two_factor/remember_browser ("คุณเข้าสู่ระบบแล้ว
// เชื่อถืออุปกรณ์นี้หรือไม่"). Clicking the primary trust button keeps the session trusted so future
// logins skip 2FA. Thai + English variants; best-effort, never throws.
const TRUST_DEVICE_PATTERNS=[
  /trust this device/i,
  /trust this browser/i,
  /trust device/i,
  /^trust$/i,
  /save browser/i,
  /remember (?:this )?(?:device|browser)/i,
  /เชื่อถืออุปกรณ์นี้/i,
  /เชื่อถืออุปกรณ์/i,
  /จดจำอุปกรณ์/i,
  /บันทึกเบราว์เซอร์/i
];
async function handleTrustDevicePage(page){
  return await clickTextLike(page,TRUST_DEVICE_PATTERNS);
}

// On Home, Facebook may surface a "จดจำรหัสผ่าน" (Save password) modal with ตกลง / ไม่ใช่ตอนนี้.
// Credentials live in the macOS Keychain, so dismiss it via "Not now"/"ไม่ใช่ตอนนี้"/Skip — never OK.
const SAVE_PASSWORD_DISMISS_PATTERNS=[
  /not now/i,
  /^skip$/i,
  /maybe later/i,
  /ไม่ใช่ตอนนี้/i,
  /ไว้ภายหลัง/i,
  /ภายหลัง/i,
  /ข้าม/i
];
async function dismissSavePasswordPrompt(page){
  return await clickTextLike(page,SAVE_PASSWORD_DISMISS_PATTERNS);
}

// RFC 6238 TOTP — derive the 6-digit 2FA code from the base32 seed stored in the Keychain.
function parseTotpSecret(secret){ const s=String(secret||'').trim(); if(!s) return null; const m=s.match(/[?&]secret=([^&]+)/i); return m?decodeURIComponent(m[1]):s; }
function base32Decode(input){ const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; const clean=String(input||'').toUpperCase().replace(/[^A-Z2-7]/g,''); let bits=0,value=0; const out=[]; for(const ch of clean){ const idx=alphabet.indexOf(ch); if(idx===-1) continue; value=(value<<5)|idx; bits+=5; if(bits>=8){ bits-=8; out.push((value>>>bits)&0xff); } } return Buffer.from(out); }
function generateTotpCode(secret,opts={}){
  const raw=parseTotpSecret(secret); if(!raw) return null;
  const key=base32Decode(raw); if(!key.length) return null;
  const step=opts.step||30; const digits=opts.digits||6;
  const now=typeof opts.time==='number'?opts.time:Math.floor(Date.now()/1000);
  let counter=Math.floor(now/step);
  const buf=Buffer.alloc(8); for(let i=7;i>=0;i--){ buf[i]=counter&0xff; counter=Math.floor(counter/256); }
  const hmac=crypto.createHmac('sha1',key).update(buf).digest();
  const offset=hmac[hmac.length-1]&0x0f;
  const bin=((hmac[offset]&0x7f)<<24)|((hmac[offset+1]&0xff)<<16)|((hmac[offset+2]&0xff)<<8)|(hmac[offset+3]&0xff);
  return (bin%10**digits).toString().padStart(digits,'0');
}

// Read the facebook.com `datr` cookie from a persistent context so the caller can stash it in the
// Keychain. Returns the raw value or null; the value is never logged here.
async function readDatrCookie(context){
  if(!context||typeof context.cookies!=='function') return null;
  let cookies=[];
  try{ cookies=await context.cookies(['https://www.facebook.com','https://facebook.com']); }
  catch{ try{ cookies=await context.cookies(); }catch{ return null; } }
  const hit=(cookies||[]).find(c=>c&&c.name==='datr'&&/(^|\.)facebook\.com$/.test(String(c.domain||'').replace(/^\./,'')));
  return hit&&hit.value?String(hit.value):null;
}

// Fill the FB login form and (when submit) robustly submit it. When a 2FA/TOTP prompt appears it is
// auto-completed from the Keychain seed via totpProvider; if no seed (or it fails) the form is left
// at the 2FA step and twoFactorRequired stays true so the caller can surface two_factor_required.
// Returns only redacted status flags — no credential and no 2FA code.
//   submit        click Login (multi-selector + Enter fallback) and wait for the page to settle
//   totpProvider  async () => seed | null; only invoked if a 2FA field actually appears
async function fillFacebookLogin(page,credential,{submit=false,totpProvider=null}={}){
  const result={autofilled:false,submitted:false,submitMethod:null,twoFactorRequired:false,twoFactorHandled:false,trustedDeviceHandled:false,savePasswordPromptHandled:false,savePasswordDismissed:false,loggedIn:false};
  if(!credential||!credential.username||!credential.password) return result;
  await page.waitForSelector('input[name="email"], input#email',{timeout:15000}).catch(()=>{});
  await page.fill('input[name="email"], input#email',credential.username).catch(()=>{});
  await page.fill('input[name="pass"], input#pass',credential.password).catch(()=>{});
  result.autofilled=true;
  if(!submit) return result;

  const selectors=[
    'button[name="login"]',
    'input[name="login"]',
    'button[type="submit"]',
    '[type="submit"]',
    'div[role="button"][aria-label*="Log in" i]',
    'div[role="button"]:has-text("Log in")'
  ];
  const clickedLogin=await clickFirstPresent(page,selectors);
  if(clickedLogin){
    result.submitted=true;
    result.submitMethod='click:'+clickedLogin;
  }
  if(!result.submitted){
    try{
      await page.press('input[name="pass"], input#pass','Enter',{timeout:5000});
      result.submitted=true;
      result.submitMethod='enter:password';
    }catch{}
  }
  if(result.submitted) await waitForLoginSettled(page);

  // 2FA / TOTP. Any failure leaves twoFactorRequired=true but never throws — the caller still
  // captures the datr cookie and returns a safe two_factor_required state.
  try{
    // No code input visible yet but the URL looks like a passkey/checkpoint screen → drive the
    // method chooser (Escape native prompt → Try another way → authenticator app → Continue).
    let twoFactorSelector=await firstPresentSelector(page,TWO_FACTOR_SELECTORS);
    if(!twoFactorSelector && looksLikeTwoFactorUrl(currentUrlOf(page))){
      await chooseTwoFactorCodeMethod(page);
      twoFactorSelector=await firstPresentSelector(page,TWO_FACTOR_SELECTORS);
    }
    if(twoFactorSelector){
      result.twoFactorRequired=true;
      let seed=null;
      if(typeof totpProvider==='function'){ try{ seed=await totpProvider(); }catch{} }
      const code=seed?generateTotpCode(seed):null;
      if(code){
        await page.fill(twoFactorSelector,code).catch(()=>{});
        let submitted2fa=await clickFirstPresent(page,TWO_FACTOR_SUBMIT_SELECTORS);
        if(!submitted2fa){ try{ await page.press(twoFactorSelector,'Enter',{timeout:5000}); submitted2fa=true; }catch{} }
        await waitForLoginSettled(page);
        const stillPrompting=await firstPresentSelector(page,TWO_FACTOR_SELECTORS);
        result.twoFactorHandled=Boolean(submitted2fa)&&!stillPrompting;
      }
    }
  }catch{}

  // Post-login interstitials: trust this device, then dismiss any Save-password modal. Both are
  // best-effort and gated on the prompt actually being present, so they no-op on a clean home page.
  if(result.submitted){
    try{ result.trustedDeviceHandled=await handleTrustDevicePage(page); await waitForLoginSettled(page); }catch{}
    try{
      result.savePasswordPromptHandled=await dismissSavePasswordPrompt(page);
      result.savePasswordDismissed=result.savePasswordPromptHandled;
    }catch{}
  }

  const currentUrl=typeof page.url==='function'?String(page.url()||''):'';
  const onAuthWall=!currentUrl||/\/login|checkpoint|two_factor|two-factor|recover/i.test(currentUrl);
  result.loggedIn=result.submitted&&!onAuthWall&&(!result.twoFactorRequired||result.twoFactorHandled);
  return result;
}
module.exports={PROFILE_ROOT,loadBrowserBackend,setBrowserBackend,profileDirFor,launchPersistentContext,acquireAccountContext,peekAccountContext,openPage,isContextAlive,classifyLaunchError,clearStaleProfileSingletons,resetAccountContexts,fillFacebookLogin,readDatrCookie,generateTotpCode,chooseTwoFactorCodeMethod,handleTrustDevicePage,dismissSavePasswordPrompt,looksLikeTwoFactorUrl};
