'use strict';
const path=require('path'); const os=require('os'); const crypto=require('crypto'); const {sanitizeAccount}=require('./accounts');
const stealthBrowser=require('./stealthBrowser');

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
// real browser. Never used in production (override stays null unless setBrowserBackend is called).
let _backendOverride=null;
function setBrowserBackend(launcher,backend='mock'){ _backendOverride=launcher?{backend,launcher}:null; }
async function loadBrowserBackend(){
  if(_backendOverride) return _backendOverride;
  // OPT-IN Stealth Browser (nodriver / Stealth Browser MCP) backend, selected only when an env var
  // explicitly asks for it. Default (unset/unknown) stays cloakbrowser so production 8820 is untouched.
  if(stealthBrowser.isStealthBackendSelected(process.env)) return stealthBrowser.loadStealthBackend();
  let cloakModule;
  try{
    cloakModule=await import('cloakbrowser');
  }catch(e){
    throw Object.assign(new Error('Accounts Bridge requires CloakBrowser; refusing Chrome/Playwright fallback'),{code:'cloakbrowser_required',cause:e});
  }
  const cloak=cloakModule&&cloakModule.default&&typeof cloakModule.default.launchPersistentContext==='function'
    ? cloakModule.default
    : cloakModule;
  if(!cloak||typeof cloak.launchPersistentContext!=='function'){
    throw Object.assign(new Error('CloakBrowser launchPersistentContext is unavailable'),{code:'cloakbrowser_backend_missing'});
  }
  return {
    backend:'cloakbrowser',
    launcher:{
      launchPersistentContext:(profileDir,options={})=>cloak.launchPersistentContext({userDataDir:profileDir,humanize:true,...options})
    }
  };
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
// Full argv of a live pid via `ps`. Returns '' when the pid is gone/unreadable. Used ONLY to decide
// whether a SingletonLock holder is a STALE bridge-spawned HEADLESS Chromium on the exact profile dir
// — never to act on an operator's visible/external browser.
function processCommandLine(pid){
  const n=Number(pid);
  if(!Number.isInteger(n)||n<=0) return '';
  try{
    const {execFileSync}=require('child_process');
    return String(execFileSync('ps',['-o','command=','-p',String(n)],{encoding:'utf8',timeout:2000})||'').trim();
  }catch{ return ''; }
}
// True only when a command line is a HEADLESS Chromium launched on EXACTLY this profile dir. Requires
// BOTH a --headless flag AND the exact profile path, so an operator's visible browser (no --headless)
// or a Chromium on a different profile is NEVER matched. This is the safety gate that keeps us from
// killing non-headless/external windows.
function isHeadlessProfileProcess(commandLine,profileDir){
  const cmd=String(commandLine||'');
  const dir=String(profileDir||'');
  if(!cmd||!dir) return false;
  if(!/(?:^|\s)--headless(?:=\S*)?(?=\s|$)/.test(cmd)) return false;
  return cmd.includes('--user-data-dir='+dir)||cmd.includes('--user-data-dir "'+dir+'"')||cmd.includes('--user-data-dir='+dir+'/');
}
// When the operator clicks Open Profile (visible) but this profile's SingletonLock is held by a STALE
// bridge-spawned HEADLESS Chromium on the exact profile dir, terminate ONLY that headless process so
// the visible relaunch can take the lock. A non-headless/external/visible browser is left untouched
// (its lock survives and the launch still surfaces profile_already_open). NEVER deletes profile/cookies.
// Deps (readCommandLine/kill/sleep) are injectable so the behavior can be tested without real processes.
async function terminateStaleHeadlessProfileLock(profileDir,deps={}){
  const readCommandLine=deps.readCommandLine||processCommandLine;
  const kill=deps.kill||((pid,sig)=>{ try{ process.kill(pid,sig); return true; }catch{ return false; } });
  const sleep=deps.sleep||(ms=>new Promise(r=>setTimeout(r,ms)));
  const waitMs=Number.isFinite(deps.waitMs)?deps.waitMs:1500;
  const stepMs=Number.isFinite(deps.stepMs)?deps.stepMs:100;
  const pid=singletonLockPid(profileDir);
  if(!pid||!pidExists(pid)) return {terminated:false,reason:'no_live_lock'};
  if(!isHeadlessProfileProcess(readCommandLine(pid),profileDir)) return {terminated:false,reason:'not_headless_profile_process',pid};
  kill(pid,'SIGTERM');
  // Wait briefly for the killed process to drop the SingletonLock before the caller relaunches.
  let waited=0;
  while(waited<waitMs){
    const cur=singletonLockPid(profileDir);
    if(!cur||!pidExists(cur)) break;
    await sleep(stepMs); waited+=stepMs;
  }
  const survivor=singletonLockPid(profileDir);
  if(survivor&&pidExists(survivor)&&isHeadlessProfileProcess(readCommandLine(survivor),profileDir)) kill(survivor,'SIGKILL');
  clearStaleProfileSingletons(profileDir);
  return {terminated:true,pid};
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
  // Only an operator-visible context is safe to reuse for posting/session-token resolution.
  // A cached headless/non-visible context would make the Open Browser button look broken and
  // closeSession would skip closing it because it is marked reused.
  if(existing&&isContextAlive(existing.context)&&existing.visible===true) return {backend:existing.backend,profileDir:existing.profileDir,context:existing.context,visible:true};
  if(existing&&!isContextAlive(existing.context)) _accountContexts.delete(key);
  return null;
}
// Non-launching inspection of the live cached context this server process owns for the account.
// Unlike peekAccountContext (visible-only, used for posting reuse), this reports ANY live bridge-
// owned context plus whether it is the operator-visible window — so the native profile-manager UI
// can show "Running (bridge)" vs "Running (visible)". NEVER launches; evicts a dead cached entry.
function inspectAccountContext(rawAccount){
  const {key}=sanitizeAccount(rawAccount);
  const existing=_accountContexts.get(key);
  if(existing&&isContextAlive(existing.context)) return {bridgeOwned:true,visible:existing.visible===true};
  if(existing&&!isContextAlive(existing.context)) _accountContexts.delete(key);
  return {bridgeOwned:false,visible:false};
}
// Patterns for a launchPersistentContext failure caused by the profile dir already being open in
// another (often orphaned/external) Chromium holding the SingletonLock. Mapped to a stable, non-
// secret code so the route can answer profile_already_open instead of a generic 500.
const PROFILE_LOCK_PATTERNS=/ProcessSingleton|SingletonLock|SingletonCookie|SingletonSocket|user data directory is already in use|profile (?:is )?(?:in use|locked|already open)|already (?:in use|running|open)|being used by another|\block(?:ed|file)?\b/i;
function classifyLaunchError(error,profileDir){
  const msg=String((error&&(error.message||error.code))||'');
  if(PROFILE_LOCK_PATTERNS.test(msg)){
    return Object.assign(new Error('Profile is already open in another browser process'),{code:'profile_already_open',profileDir});
  }
  return error;
}
// Merge Chromium launch-arg groups by FLAG NAME (the part before `=`), first-wins. This lets a caller
// pass extra args (e.g. virtual-display --window-position/--window-size from virtualDisplay.js) WITHOUT
// dropping the base anti-automation args, and without emitting a duplicate flag if the caller repeats
// one. Base args are listed first so they always win over a caller override of the same flag.
function mergeBrowserArgs(...groups){
  const out=[]; const seen=new Set();
  for(const group of groups){
    if(!Array.isArray(group)) continue;
    for(const raw of group){
      const arg=String(raw==null?'':raw).trim();
      if(!arg) continue;
      const flag=arg.split('=')[0];
      if(seen.has(flag)) continue;
      seen.add(flag); out.push(arg);
    }
  }
  return out;
}
async function launchPersistentContext(rawAccount,options={}){
  const {key}=sanitizeAccount(rawAccount);
  const {backend,launcher}=await loadBrowserBackend();
  const profileDir=profileDirFor(key);
  clearStaleProfileSingletons(profileDir);
  // Base anti-automation/launch args ALWAYS apply; caller-supplied args (options.args and
  // options.launchOptions.args) are merged on top by flag name without clobbering the base set.
  const launchOptions=(options.launchOptions&&typeof options.launchOptions==='object')?options.launchOptions:{};
  const mergedArgs=mergeBrowserArgs(
    ['--disable-blink-features=AutomationControlled','--no-first-run','--no-default-browser-check'],
    options.args,
    launchOptions.args
  );
  let context;
  try{
    // Spread launchOptions FIRST, then force the merged args last so a launchOptions.args can never
    // silently replace the merged set (it has already been folded into mergedArgs above).
    context=await launcher.launchPersistentContext(profileDir,{headless:options.visible===false,...launchOptions,args:mergedArgs});
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
  const wantsVisible=options.visible===true;
  const existing=_accountContexts.get(key);
  if(existing&&isContextAlive(existing.context)){
    if(!wantsVisible||existing.visible===true) return {...existing,reused:true};
    // The operator explicitly asked to SEE the browser, but the cached context is headless/non-visible.
    // Close only this bridge-owned context and relaunch visible; do not delete the profile/cookies.
    try{ if(existing.context&&typeof existing.context.close==='function') await existing.context.close(); }catch{}
    _accountContexts.delete(key);
  }
  if(existing) _accountContexts.delete(key);
  // Operator clicked Open Profile (visible) but this process holds no live bridge context. If a STALE
  // bridge-spawned HEADLESS Chromium still holds the profile's SingletonLock, terminate ONLY that
  // headless process so the visible relaunch can take the lock instead of failing profile_already_open.
  // External/visible/non-headless browsers are left untouched. Never deletes profile/cookies.
  if(wantsVisible){ try{ await terminateStaleHeadlessProfileLock(profileDirFor(key),options.lockClearDeps||{}); }catch{} }
  if(_accountContextLaunches.has(key)){ const entry=await _accountContextLaunches.get(key); return {...entry,reused:true}; }
  const launchPromise=(async()=>{
    const launched=await launchPersistentContext(rawAccount,options);
    try{ if(launched.context&&typeof launched.context.on==='function') launched.context.on('close',()=>forgetAccountContext(key,launched.context)); }catch{}
    const entry={backend:launched.backend,profileDir:launched.profileDir,context:launched.context,visible:options.visible===true};
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
async function closeAccountContext(rawAccount){
  const {key}=sanitizeAccount(rawAccount);
  const existing=_accountContexts.get(key);
  if(!existing) return {closed:false, state:'not_open'};
  _accountContexts.delete(key);
  try{
    if(existing.context&&typeof existing.context.close==='function') await existing.context.close();
    return {closed:true, state:'closed'};
  }catch(e){
    return {closed:false, state:'close_failed', reason:String((e&&(e.code||e.message))||'close_failed')};
  }
}

// Token-free, side-effect-free profile/session status for the native Accounts Bridge profile
// manager. It NEVER launches a browser, mints/refreshes a token, reads a credential, or returns any
// secret. It only inspects the in-memory context map + the on-disk profile dir and reports:
//   account/key       sanitized display + lowercased key (the directory basename)
//   profileDir        the profile directory BASENAME only (never the full home path — no leakage)
//   profileExists     whether the persistent profile dir exists on disk
//   running           a browser is using this profile right now: a live bridge-owned context OR an
//                     external Chromium still holding the profile's SingletonLock
//   bridgeSession     this server process owns a live context for the account
//   visibleSession    that bridge-owned context is the operator-visible window (Open Profile result)
//   lockPidPresent    a live SingletonLock pid is held (a browser has the profile open)
//   pidCount          0/1 — count only of the live lock pid (loopback-safe; never the raw pid value)
function profileStatus(rawAccount){
  const {key,display}=sanitizeAccount(rawAccount);
  const profileDir=profileDirFor(key);
  let profileExists=false;
  try{ const fs=require('fs'); profileExists=fs.statSync(profileDir).isDirectory(); }catch{}
  const ctx=inspectAccountContext(rawAccount);
  const lockPid=singletonLockPid(profileDir);
  const lockAlive=!!lockPid&&pidExists(lockPid);
  return {
    account:display,
    key,
    profileDir:key,            // basename only — never the absolute filesystem path
    profileExists,
    running:ctx.bridgeOwned||lockAlive,
    bridgeSession:ctx.bridgeOwned,
    visibleSession:ctx.visible,
    lockPidPresent:lockAlive,
    pidCount:lockAlive?1:0
  };
}

async function openPage(rawAccount,url,options={}){
  let launched; let reused=false;
  if(options.reuse){
    launched=await acquireAccountContext(rawAccount,options);
    reused=!!launched.reused;
  }else if(options.reuseIfPresent){
    const existing=peekAccountContext(rawAccount);
    if(existing){
      const err=new Error('Operator-visible browser session is open; automation must not navigate it');
      err.code='operator_visible_session_open';
      err.profileDir=existing.profileDir;
      throw err;
    }
    launched=await launchPersistentContext(rawAccount,options); reused=false;
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
module.exports={PROFILE_ROOT,loadBrowserBackend,setBrowserBackend,profileDirFor,mergeBrowserArgs,launchPersistentContext,acquireAccountContext,peekAccountContext,inspectAccountContext,profileStatus,closeAccountContext,openPage,isContextAlive,classifyLaunchError,clearStaleProfileSingletons,isHeadlessProfileProcess,terminateStaleHeadlessProfileLock,resetAccountContexts,fillFacebookLogin,readDatrCookie,generateTotpCode,chooseTwoFactorCodeMethod,handleTrustDevicePage,dismissSavePasswordPrompt,looksLikeTwoFactorUrl};
