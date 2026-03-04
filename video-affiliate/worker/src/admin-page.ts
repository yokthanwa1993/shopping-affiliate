export const ADMIN_HTML = `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Admin Control</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root {
    --bg: #f2f4f8;
    --card: #ffffff;
    --text: #0f172a;
    --muted: #94a3b8;
    --line: #e2e8f0;
    --blue: #2563eb;
    --blue-soft: #eff6ff;
    --green: #16a34a;
    --green-soft: #f0fdf4;
    --orange: #ea580c;
    --orange-soft: #fff7ed;
    --danger: #ef4444;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Sukhumvit Set', 'Kanit', sans-serif;
    background: radial-gradient(circle at top right, #dbeafe 0%, #f2f4f8 35%), var(--bg);
    color: var(--text);
    min-height: 100%;
    padding-top: max(env(safe-area-inset-top), 52px);
    padding-bottom: env(safe-area-inset-bottom);
  }

  .hidden { display: none !important; }

  #login-screen {
    position: fixed;
    inset: 0;
    background: linear-gradient(180deg, #ffffff 0%, #eff6ff 100%);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: max(env(safe-area-inset-top), 52px) 28px 28px;
    z-index: 60;
  }

  .login-logo {
    width: 74px;
    height: 74px;
    border-radius: 24px;
    background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
    box-shadow: 0 14px 36px rgba(37, 99, 235, 0.32);
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 16px;
  }

  .login-logo svg { width: 36px; height: 36px; }

  #login-screen h2 {
    font-size: 28px;
    font-weight: 900;
    letter-spacing: -0.02em;
    margin-bottom: 4px;
  }

  #login-screen p {
    font-size: 13px;
    color: #64748b;
    margin-bottom: 24px;
  }

  .login-input {
    width: 100%;
    max-width: 360px;
    border: 1.5px solid #dbe3f1;
    border-radius: 16px;
    padding: 14px 16px;
    font-size: 18px;
    outline: none;
    letter-spacing: 4px;
    text-align: center;
    background: #ffffff;
    transition: border-color .15s ease;
  }

  .login-input:focus { border-color: #3b82f6; }

  .login-btn {
    width: 100%;
    max-width: 360px;
    border: none;
    border-radius: 16px;
    padding: 14px;
    margin-top: 10px;
    font-size: 15px;
    font-weight: 800;
    color: #fff;
    background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
    box-shadow: 0 10px 24px rgba(37, 99, 235, 0.30);
    cursor: pointer;
  }

  .login-btn:disabled { opacity: .5; cursor: not-allowed; }

  .login-err {
    min-height: 18px;
    margin-top: 10px;
    font-size: 13px;
    color: var(--danger);
    text-align: center;
  }

  #main {
    display: none;
    height: calc(100dvh - max(env(safe-area-inset-top), 52px));
    position: relative;
  }

  .topbar {
    position: fixed;
    top: max(env(safe-area-inset-top), 52px);
    left: 0;
    right: 0;
    z-index: 40;
    background: rgba(242, 244, 248, .88);
    backdrop-filter: blur(14px);
    border-bottom: 1px solid rgba(148, 163, 184, .16);
  }

  .topbar-inner {
    max-width: 560px;
    margin: 0 auto;
    padding: 10px 16px 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .brand-dot {
    width: 34px;
    height: 34px;
    border-radius: 11px;
    background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: 900;
    flex-shrink: 0;
  }

  .brand h1 {
    font-size: 18px;
    font-weight: 900;
    line-height: 1.05;
  }

  .brand p {
    font-size: 11px;
    color: #64748b;
    margin-top: 3px;
  }

  .top-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .icon-btn {
    width: 34px;
    height: 34px;
    border-radius: 11px;
    border: 1px solid #dbe3f1;
    background: #fff;
    color: #64748b;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }

  .icon-btn svg { width: 16px; height: 16px; }

  .logout-btn {
    border: none;
    border-radius: 11px;
    background: #fee2e2;
    color: #b91c1c;
    font-size: 12px;
    font-weight: 800;
    padding: 9px 12px;
    cursor: pointer;
  }

  .app {
    max-width: 560px;
    margin: 0 auto;
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .content {
    flex: 1;
    overflow: auto;
    padding: 86px 16px calc(108px + env(safe-area-inset-bottom));
  }

  .view { display: block; }

  .hero-card {
    background: linear-gradient(145deg, #1d4ed8 0%, #2563eb 55%, #3b82f6 100%);
    border-radius: 24px;
    padding: 16px;
    color: #fff;
    box-shadow: 0 16px 34px rgba(37, 99, 235, .28);
    margin-bottom: 14px;
  }

  .hero-title { font-size: 12px; opacity: .85; }
  .hero-value { font-size: 26px; font-weight: 900; margin-top: 6px; letter-spacing: -0.02em; }
  .hero-sub { font-size: 12px; opacity: .9; margin-top: 3px; }

  .grid-2 {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 14px;
  }

  .metric {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 12px;
  }

  .metric .label { font-size: 11px; color: var(--muted); }
  .metric .value { margin-top: 6px; font-size: 22px; font-weight: 900; line-height: 1; }
  .metric .hint { margin-top: 6px; font-size: 11px; color: #64748b; }

  .panel {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 20px;
    margin-bottom: 14px;
    overflow: hidden;
  }

  .panel-head {
    padding: 14px 14px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .panel-head h3 { font-size: 16px; font-weight: 900; }
  .panel-head p { font-size: 12px; color: var(--muted); margin-top: 2px; }

  .badge {
    font-size: 11px;
    font-weight: 700;
    color: #475569;
    background: #f1f5f9;
    border-radius: 999px;
    padding: 4px 10px;
    white-space: nowrap;
  }

  .list-empty {
    padding: 28px 14px;
    font-size: 13px;
    color: #94a3b8;
    text-align: center;
  }

  .ns-item {
    padding: 11px 14px;
    border-top: 1px solid #f1f5f9;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .ns-id {
    font-size: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-weight: 700;
    color: #334155;
  }

  .ns-meta {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 11px;
    color: #64748b;
  }

  .pill {
    border-radius: 8px;
    padding: 2px 7px;
    font-size: 10px;
    font-weight: 700;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #f1f5f9;
    color: #475569;
  }

  .pill.ok { background: var(--green-soft); color: var(--green); }
  .pill.warn { background: var(--orange-soft); color: var(--orange); }

  .team-item {
    padding: 13px 14px;
    border-top: 1px solid #f1f5f9;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .avatar {
    width: 36px;
    height: 36px;
    border-radius: 12px;
    background: #f1f5f9;
    color: #64748b;
    font-size: 14px;
    font-weight: 900;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .team-info { flex: 1; min-width: 0; }
  .team-email {
    font-size: 16px;
    font-weight: 800;
    letter-spacing: -0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .team-sub {
    margin-top: 4px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .icon-del {
    width: 30px;
    height: 30px;
    border: none;
    border-radius: 10px;
    background: #fff;
    color: #cbd5e1;
    cursor: pointer;
    flex-shrink: 0;
  }

  .icon-del:hover { background: #fef2f2; color: #ef4444; }

  .confirm-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .btn-mini {
    border: none;
    border-radius: 9px;
    padding: 5px 9px;
    font-size: 11px;
    font-weight: 800;
    cursor: pointer;
  }

  .btn-mini.ok { background: #ef4444; color: #fff; }
  .btn-mini.gray { background: #e2e8f0; color: #475569; }

  .add-wrap {
    padding: 12px 14px 14px;
    border-top: 1px solid #f1f5f9;
    display: flex;
    gap: 8px;
  }

  .add-input {
    flex: 1;
    border: 1.5px solid #e2e8f0;
    border-radius: 12px;
    background: #f8fafc;
    color: #0f172a;
    padding: 10px 12px;
    font-size: 14px;
    outline: none;
  }

  .add-input:focus { border-color: #3b82f6; background: #fff; }

  .btn-add {
    border: none;
    border-radius: 12px;
    background: #0f172a;
    color: #fff;
    font-size: 14px;
    font-weight: 800;
    padding: 10px 13px;
    cursor: pointer;
    white-space: nowrap;
  }

  .btn-add:disabled { opacity: .45; cursor: not-allowed; }

  .admin-note {
    padding: 14px;
    border-top: 1px solid #f1f5f9;
    font-size: 13px;
    color: #64748b;
    line-height: 1.55;
  }

  .admin-actions {
    display: flex;
    gap: 10px;
    padding: 0 14px 14px;
  }

  .admin-actions button {
    flex: 1;
    border: none;
    border-radius: 12px;
    font-size: 13px;
    font-weight: 800;
    padding: 11px;
    cursor: pointer;
  }

  .btn-outline { background: #f8fafc; color: #334155; border: 1px solid #e2e8f0; }
  .btn-danger { background: #fee2e2; color: #b91c1c; }

  .bottom-nav {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 45;
    background: rgba(255,255,255,.92);
    backdrop-filter: blur(18px);
    border-top: 1px solid #e2e8f0;
    padding-bottom: env(safe-area-inset-bottom);
  }

  .bottom-nav-inner {
    max-width: 560px;
    margin: 0 auto;
    height: 74px;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .nav-btn {
    border: none;
    background: transparent;
    color: #94a3b8;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    position: relative;
  }

  .nav-btn svg { width: 20px; height: 20px; }

  .nav-btn.active { color: var(--blue); }
  .nav-btn.active::after {
    content: '';
    position: absolute;
    top: 0;
    width: 32px;
    height: 3px;
    border-radius: 99px;
    background: var(--blue);
  }

  .toast {
    position: fixed;
    left: 50%;
    bottom: calc(92px + env(safe-area-inset-bottom));
    transform: translateX(-50%) translateY(70px);
    background: #0f172a;
    color: #fff;
    padding: 10px 16px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 700;
    opacity: 0;
    transition: all .25s ease;
    z-index: 70;
    white-space: nowrap;
  }

  .toast.show {
    transform: translateX(-50%) translateY(0);
    opacity: 1;
  }
</style>
</head>
<body>

<div id="login-screen">
  <div class="login-logo">
    <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 10.5V8a6 6 0 1112 0v2.5"/>
      <rect x="4" y="10" width="16" height="10" rx="3"/>
      <path d="M12 14.5v2"/>
    </svg>
  </div>
  <h2>Admin Control</h2>
  <p>เฉพาะผู้ดูแลระบบเท่านั้น</p>
  <input class="login-input" id="pw-input" type="password" placeholder="••••••••" autocomplete="off" />
  <button class="login-btn" id="pw-btn" onclick="doLogin()">เข้าสู่ระบบ</button>
  <div class="login-err" id="pw-err"></div>
</div>

<div id="main">
  <div class="topbar">
    <div class="topbar-inner">
      <div class="brand">
        <div class="brand-dot">A</div>
        <div>
          <h1>Admin</h1>
          <p>Dashboard สำหรับแอดมิน</p>
        </div>
      </div>
      <div class="top-actions">
        <button class="icon-btn" id="refresh-btn" title="รีเฟรช">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 12a9 9 0 11-2.64-6.36" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M21 3v6h-6" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button class="logout-btn" onclick="logout()">ออก</button>
      </div>
    </div>
  </div>

  <div class="app">
    <div class="content">
      <section id="view-dashboard" class="view">
        <div class="hero-card">
          <div class="hero-title">ภาพรวมระบบ</div>
          <div class="hero-value" id="hero-owners">0</div>
          <div class="hero-sub">Owner ทั้งหมด <span id="hero-active">0</span> active • อัปเดต <span id="last-updated">--:--</span></div>
        </div>

        <div class="grid-2">
          <div class="metric">
            <div class="label">Namespaces</div>
            <div class="value" id="m-ns">0</div>
            <div class="hint">Workspace แยกทั้งหมด</div>
          </div>
          <div class="metric">
            <div class="label">Pages</div>
            <div class="value" id="m-pages">0</div>
            <div class="hint"><span id="m-pages-active">0</span> เปิดใช้งาน</div>
          </div>
          <div class="metric">
            <div class="label">Posts Today</div>
            <div class="value" id="m-posts-today">0</div>
            <div class="hint">โพสต์วันนี้</div>
          </div>
          <div class="metric">
            <div class="label">Posts Total</div>
            <div class="value" id="m-posts-total">0</div>
            <div class="hint">success + posting</div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <div>
              <h3>Namespace Overview</h3>
              <p>เพจ/โพสต์ ต่อ namespace</p>
            </div>
            <span class="badge" id="ns-count">0</span>
          </div>
          <div id="namespace-list"><div class="list-empty">กำลังโหลด...</div></div>
        </div>
      </section>

      <section id="view-teams" class="view hidden">
        <div class="panel">
          <div class="panel-head">
            <div>
              <h3>Teams</h3>
              <p>รายชื่อ owner ที่เข้าใช้งานได้</p>
            </div>
            <span class="badge" id="team-count">0</span>
          </div>
          <div id="team-list"><div class="list-empty">กำลังโหลด...</div></div>
          <div class="add-wrap">
            <input class="add-input" type="email" id="email-input" placeholder="email@example.com" />
            <button class="btn-add" id="email-add-btn" onclick="addEmail()">เพิ่มทีม</button>
          </div>
        </div>
      </section>

      <section id="view-security" class="view hidden">
        <div class="panel">
          <div class="panel-head">
            <div>
              <h3>Admin Only</h3>
              <p>หน้านี้เข้าถึงได้ด้วยรหัสผ่านแอดมินเท่านั้น</p>
            </div>
            <span class="badge">Secure</span>
          </div>
          <div class="admin-note">
            หากพบการใช้งานผิดปกติ ให้เปลี่ยนรหัสผ่านแอดมินในตาราง settings ทันที และบังคับให้ผู้ใช้เข้าใหม่โดย logout session ที่เกี่ยวข้อง
          </div>
          <div class="admin-actions">
            <button class="btn-outline" id="reload-btn">รีเฟรชข้อมูล</button>
            <button class="btn-danger" onclick="logout()">ออกจากระบบ</button>
          </div>
        </div>
      </section>
    </div>
  </div>

  <div class="bottom-nav">
    <div class="bottom-nav-inner">
      <button class="nav-btn active" data-tab="dashboard">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">
          <rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="10" width="8" height="11" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/>
        </svg>
        <span>Dashboard</span>
      </button>
      <button class="nav-btn" data-tab="teams">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">
          <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
        </svg>
        <span>Teams</span>
      </button>
      <button class="nav-btn" data-tab="security">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">
          <path d="M12 2l8 4v6c0 5-3.5 9.5-8 10-4.5-.5-8-5-8-10V6l8-4z"/><path d="M9.5 12.5l1.8 1.8 3.2-3.3"/>
        </svg>
        <span>Admin</span>
      </button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const API = '/admin/api';
const urlToken = new URLSearchParams(window.location.search).get('t') || '';
let adminToken = urlToken || sessionStorage.getItem('admin_token') || '';
if (urlToken) sessionStorage.setItem('admin_token', urlToken);
let pendingDelete = null;
let currentTab = 'dashboard';
let data = { teams: [], dashboard: {} };

function el(id) { return document.getElementById(id); }

async function doLogin() {
  const pw = el('pw-input').value.trim();
  if (!pw) return;
  const btn = el('pw-btn');
  btn.disabled = true;
  btn.textContent = 'กำลังตรวจสอบ...';

  try {
    const r = await fetch(API + '/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    });

    if (r.ok) {
      adminToken = pw;
      sessionStorage.setItem('admin_token', pw);
      el('login-screen').style.display = 'none';
      el('main').style.display = 'block';
      setTab('dashboard');
      await load();
      return;
    }

    el('pw-err').textContent = 'รหัสผ่านไม่ถูกต้อง';
    el('pw-input').value = '';
    el('pw-input').focus();
  } catch (e) {
    el('pw-err').textContent = 'เชื่อมต่อไม่สำเร็จ';
  } finally {
    btn.disabled = false;
    btn.textContent = 'เข้าสู่ระบบ';
  }
}

function logout() {
  sessionStorage.removeItem('admin_token');
  adminToken = '';
  pendingDelete = null;
  currentTab = 'dashboard';
  el('main').style.display = 'none';
  el('login-screen').style.display = 'flex';
  el('pw-input').value = '';
  el('pw-err').textContent = '';
}

function showMain() {
  el('login-screen').style.display = 'none';
  el('main').style.display = 'block';
  setTab('dashboard');
}

function showTelegramReauthScreen() {
  const wrap = el('login-screen');
  wrap.innerHTML = '<div class="login-logo">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M6 10.5V8a6 6 0 1112 0v2.5"/>' +
    '<rect x="4" y="10" width="16" height="10" rx="3"/>' +
    '<path d="M12 14.5v2"/>' +
    '</svg>' +
    '</div>' +
    '<h2>Admin Control</h2>' +
    '<p>สิทธิ์หมดอายุ กลับไปที่แชตแล้วพิมพ์ /admin ใหม่</p>' +
    '<button class="login-btn" id="reauth-btn">ปิด</button>';
  wrap.style.display = 'flex';
  const btn = document.getElementById('reauth-btn');
  if (btn) {
    btn.addEventListener('click', () => {
      try { window.Telegram.WebApp.close(); } catch (e) { window.location.reload(); }
    });
  }
}

async function apiFetch(path, opts) {
  const options = opts || {};
  const sep = path.includes('?') ? '&' : '?';
  return fetch(API + path + sep + 't=' + encodeURIComponent(adminToken), {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
}

async function validateCurrentToken() {
  if (!adminToken) return false;
  try {
    const r = await apiFetch('/data');
    if (!r.ok) {
      sessionStorage.removeItem('admin_token');
      adminToken = '';
      return false;
    }
    return true;
  } catch (e) {
    sessionStorage.removeItem('admin_token');
    adminToken = '';
    return false;
  }
}

async function tryTelegramAutoAuth() {
  if (!(window.Telegram && window.Telegram.WebApp)) return false;

  const tg = window.Telegram.WebApp;
  const chatId = tg?.initDataUnsafe?.user?.id || tg?.initDataUnsafe?.chat?.id;
  if (!chatId) return false;

  try {
    const r = await fetch(API + '/auto-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId) }),
    });
    if (!r.ok) return false;

    const payload = await r.json();
    const token = String(payload?.token || '').trim();
    if (!token) return false;

    adminToken = token;
    sessionStorage.setItem('admin_token', token);
    return true;
  } catch (e) {
    return false;
  }
}

function setTab(tab) {
  currentTab = tab;
  const views = ['dashboard', 'teams', 'security'];
  for (const name of views) {
    const view = el('view-' + name);
    if (!view) continue;
    if (name === tab) view.classList.remove('hidden');
    else view.classList.add('hidden');
  }

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    if (btn.dataset.tab === tab) btn.classList.add('active');
    else btn.classList.remove('active');
  });
}

function escAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function askDel(type, key) {
  pendingDelete = { type, key };
  renderTeams();
}

function cancelDel() {
  pendingDelete = null;
  renderTeams();
}

async function confirmDel() {
  if (!pendingDelete) return;
  const key = pendingDelete.key;
  pendingDelete = null;
  await apiFetch('/users/' + encodeURIComponent(key), { method: 'DELETE' });
  toast('ลบ ' + key + ' แล้ว');
  await load();
}

function delBtn(type, key) {
  const isConfirming = pendingDelete && pendingDelete.type === type && pendingDelete.key === key;
  if (isConfirming) {
    return '<div class="confirm-wrap"><button class="btn-mini ok" onclick="confirmDel()">ลบ</button><button class="btn-mini gray" onclick="cancelDel()">ยกเลิก</button></div>';
  }
  return '<button class="icon-del" data-type="' + escAttr(type) + '" data-key="' + escAttr(key) + '" onclick="askDel(this.dataset.type,this.dataset.key)">' +
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 18L18 6M6 6l12 12"/></svg>' +
    '</button>';
}

function computeFallbackDashboard(teams) {
  const owners = teams.length;
  const active = teams.filter((t) => Number(t.active_session) === 1).length;
  const nsSet = new Set();
  for (const t of teams) {
    const ns = String(t.namespace_id || '').trim();
    if (ns) nsSet.add(ns);
  }
  return {
    owners_total: owners,
    owners_active: active,
    namespaces_total: nsSet.size,
    pages_total: 0,
    pages_active: 0,
    posts_total: 0,
    posts_today: 0,
    latest_post_at: null,
    namespace_stats: []
  };
}

function renderDashboard() {
  const fallback = computeFallbackDashboard(data.teams || []);
  const d = { ...fallback, ...(data.dashboard || {}) };

  el('hero-owners').textContent = String(d.owners_total || 0);
  el('hero-active').textContent = String(d.owners_active || 0);

  el('m-ns').textContent = String(d.namespaces_total || 0);
  el('m-pages').textContent = String(d.pages_total || 0);
  el('m-pages-active').textContent = String(d.pages_active || 0);
  el('m-posts-today').textContent = String(d.posts_today || 0);
  el('m-posts-total').textContent = String(d.posts_total || 0);

  const nsStats = Array.isArray(d.namespace_stats) ? d.namespace_stats : [];
  el('ns-count').textContent = String(nsStats.length);

  if (!nsStats.length) {
    el('namespace-list').innerHTML = '<div class="list-empty">ยังไม่มี namespace ที่ผูกกับเพจ</div>';
  } else {
    el('namespace-list').innerHTML = nsStats.map((item) => {
      const ns = String(item.namespace_id || '-');
      const pgs = Number(item.pages_count || 0);
      const posts = Number(item.posts_count || 0);
      return '<div class="ns-item">' +
        '<div class="ns-id">' + ns + '</div>' +
        '<div class="ns-meta"><span class="pill">pages ' + pgs + '</span><span class="pill ok">posts ' + posts + '</span></div>' +
      '</div>';
    }).join('');
  }
}

function renderTeams() {
  const teams = data.teams || [];
  el('team-count').textContent = String(teams.length);

  if (!teams.length) {
    el('team-list').innerHTML = '<div class="list-empty">ยังไม่มีทีม</div>';
    return;
  }

  el('team-list').innerHTML = teams.map((t) => {
    const active = Number(t.active_session) === 1;
    const initial = (t.email || '?').charAt(0).toUpperCase();
    const ns = t.namespace_id || '-';

    return '<div class="team-item">' +
      '<div class="avatar">' + initial + '</div>' +
      '<div class="team-info">' +
        '<div class="team-email">' + t.email + '</div>' +
        '<div class="team-sub">' +
          '<span class="pill">' + ns + '</span>' +
          (active ? '<span class="pill ok">active</span>' : '<span class="pill warn">pending</span>') +
        '</div>' +
      '</div>' +
      delBtn('team', t.email) +
    '</div>';
  }).join('');
}

function renderMetaTime() {
  const stamp = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  el('last-updated').textContent = stamp;
}

function renderAll() {
  renderMetaTime();
  renderDashboard();
  renderTeams();
}

async function load() {
  try {
    const r = await apiFetch('/data');
    if (r.status === 401) { logout(); return; }
    if (!r.ok) {
      toast('โหลดข้อมูลไม่สำเร็จ', true);
      return;
    }
    data = await r.json();
    renderAll();
  } catch (e) {
    toast('โหลดข้อมูลไม่สำเร็จ', true);
  }
}

async function addEmail() {
  const input = el('email-input');
  const email = String(input.value || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    toast('ใส่ email ให้ถูกต้อง', true);
    return;
  }

  const btn = el('email-add-btn');
  btn.disabled = true;
  try {
    const r = await apiFetch('/emails', {
      method: 'POST',
      body: JSON.stringify({ email })
    });

    if (r.ok) {
      input.value = '';
      toast('เพิ่ม ' + email + ' แล้ว');
      await load();
    } else {
      toast('เพิ่มทีมไม่สำเร็จ', true);
    }
  } finally {
    btn.disabled = false;
  }
}

function toast(msg, err) {
  const t = el('toast');
  t.textContent = (err ? '✕ ' : '✓ ') + msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}

el('pw-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
el('email-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addEmail(); });
el('refresh-btn').addEventListener('click', () => load());
el('reload-btn').addEventListener('click', () => load());

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    if (!tab) return;
    setTab(tab);
  });
});

if (window.Telegram && window.Telegram.WebApp) {
  const tg = window.Telegram.WebApp;
  try { tg.ready(); } catch (e) {}
  try { tg.expand(); } catch (e) {}
  try { if (typeof tg.requestFullscreen === 'function') tg.requestFullscreen(); } catch (e) {}
  try { if (typeof tg.disableVerticalSwipes === 'function') tg.disableVerticalSwipes(); } catch (e) {}
  try { if (typeof tg.setHeaderColor === 'function') tg.setHeaderColor('#f2f4f8'); } catch (e) {}
  try { if (typeof tg.setBackgroundColor === 'function') tg.setBackgroundColor('#f2f4f8'); } catch (e) {}
  try { if (typeof tg.setBottomBarColor === 'function') tg.setBottomBarColor('#ffffff'); } catch (e) {}
}

async function boot() {
  const isTelegramWebApp = !!(window.Telegram && window.Telegram.WebApp);
  el('login-screen').style.display = 'none';
  el('main').style.display = 'none';

  if (await validateCurrentToken()) {
    showMain();
    await load();
    return;
  }

  const autoAuthOk = await tryTelegramAutoAuth();
  if (autoAuthOk && await validateCurrentToken()) {
    showMain();
    await load();
    return;
  }

  if (isTelegramWebApp) {
    showTelegramReauthScreen();
    return;
  }

  el('login-screen').style.display = 'flex';
}

boot();
</script>
</body>
</html>`
