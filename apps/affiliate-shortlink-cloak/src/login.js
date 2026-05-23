'use strict';

const {
  SHOPEE_ROUTE_NOT_FOUND_REASON,
  currentPageUrl,
  isShopeeRouteNotFoundUrl,
} = require('./shopee-route');

const SHOPEE_USERNAME_SELECTORS = [
  'input[name="loginKey"]',
  'input[name="username"]',
  'input[name="email"]',
  'input[name="phone"]',
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[autocomplete="tel"]',
  'input[type="email"]',
  'input[type="tel"]',
  'input[placeholder*="หมายเลข"]',
  'input[placeholder*="โทรศัพท์"]',
  'input[placeholder*="ผู้ใช้"]',
  'input[placeholder*="อีเมล"]',
  'input[placeholder*="Email"]',
  'input[placeholder*="Phone"]',
  'input[placeholder*="Username"]',
  'input[placeholder*="Login"]',
  'form input[type="text"]:not([type="hidden"])',
  'input:not([type])',
  'input[type="text"]',
];

const LAZADA_USERNAME_SELECTORS = [
  'input[name="account"]',
  'input[name="loginName"]',
  'input[name="username"]',
  'input[name="email"]',
  'input[autocomplete="username"]',
  'input[placeholder*="อีเมล"]',
  'input[placeholder*="โทรศัพท์"]',
  'input[placeholder*="Email"]',
  'input[placeholder*="Phone"]',
  'form input[type="text"]:not([type="hidden"])',
];

const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[autocomplete="current-password"]',
];

const SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'form button:not([type="button"])',
  'button.btn-login',
  'button.login-btn',
  'button[data-spm="loginbtn"]',
  'button:has-text("Log In")',
  'button:has-text("Login")',
  'button:has-text("เข้าสู่ระบบ")',
];

const PASSWORD_LOGIN_SELECTORS = [
  'button:has-text("Log in with password")',
  'button:has-text("Log In with Password")',
  'button:has-text("Login with Password")',
  'button:has-text("Sign in with password")',
  'button:has-text("Sign In with Password")',
  'button:has-text("Password")',
  'a:has-text("Password")',
  '[role="button"]:has-text("Password")',
  '[role="tab"]:has-text("Password")',
  'button:has-text("รหัสผ่าน")',
  'a:has-text("รหัสผ่าน")',
  '[role="button"]:has-text("รหัสผ่าน")',
  '[role="tab"]:has-text("รหัสผ่าน")',
];

const CAPTCHA_MARKER_REGEX = /captcha|recaptcha|hcaptcha|geetest|nc-container|baxia|slider-?verify|puzzle|verifycode|otp|รหัสยืนยัน/i;
const FIELD_EXCLUDE_REGEX = /captcha|recaptcha|hcaptcha|otp|one[-_\s]?time|verification|verify|verifycode|2fa|mfa|code|search|query|coupon|voucher|pin|รหัสยืนยัน|ยืนยัน|ค้นหา/i;

const FILL_ACTION = 'fill-login-input';
const CLICK_PASSWORD_LOGIN_ACTION = 'click-password-login';
const CAPTURE_LOGIN_DIAGNOSTICS_ACTION = 'capture-login-diagnostics';
const MAX_DIAGNOSTIC_FRAMES = 8;
const MAX_DIAGNOSTIC_INPUTS_PER_FRAME = 24;
const MAX_DIAGNOSTIC_SNIPPETS_PER_FRAME = 8;
const MAX_DIAGNOSTIC_TEXT_CHARS = 180;

function usernameSelectorsFor(platform) {
  if (platform === 'shopee') return SHOPEE_USERNAME_SELECTORS;
  if (platform === 'lazada') return LAZADA_USERNAME_SELECTORS;
  return [];
}

function redactSecrets(value, secrets = []) {
  let out = String(value == null ? '' : value);
  for (const secret of secrets) {
    const needle = String(secret == null ? '' : secret);
    if (!needle) continue;
    try {
      out = out.split(needle).join('[REDACTED]');
    } catch {
      out = out.replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[REDACTED]');
    }
  }
  out = out.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]');
  out = out.replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, '[REDACTED_PHONE]');
  return out;
}

function normalizeDiagnosticText(value, secrets = [], maxChars = MAX_DIAGNOSTIC_TEXT_CHARS) {
  const text = redactSecrets(value, secrets)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)).trim() + '…';
}

function sanitizeUrlForDiagnostic(rawUrl, secrets = []) {
  const input = redactSecrets(rawUrl, secrets).trim();
  if (!input) return '';
  try {
    const parsed = new URL(input);
    const out = new URL(parsed.origin + parsed.pathname);
    for (const [key, value] of parsed.searchParams.entries()) {
      out.searchParams.append(key, value ? '[REDACTED]' : '[empty]');
    }
    if (parsed.hash) out.hash = '#[REDACTED]';
    return out.toString();
  } catch {
    return normalizeDiagnosticText(input, secrets, 220);
  }
}

function domainForDiagnostic(rawUrl) {
  try {
    return new URL(String(rawUrl || '')).hostname;
  } catch {
    return '';
  }
}

function sanitizeInputDescriptor(input, secrets = []) {
  const out = {};
  const allowed = [
    'index',
    'tag',
    'type',
    'name',
    'id',
    'autocomplete',
    'placeholder',
    'ariaLabel',
    'inputMode',
    'role',
    'title',
    'contentEditable',
    'dataTestId',
    'visible',
    'disabled',
    'readOnly',
    'candidate',
    'excluded',
    'marker',
  ];
  for (const key of allowed) {
    if (!(key in (input || {}))) continue;
    const value = input[key];
    out[key] = typeof value === 'string'
      ? normalizeDiagnosticText(value, secrets, key === 'marker' ? 220 : 120)
      : value;
  }
  if (input && input.rect && typeof input.rect === 'object') {
    out.rect = {
      x: Number(input.rect.x) || 0,
      y: Number(input.rect.y) || 0,
      width: Number(input.rect.width) || 0,
      height: Number(input.rect.height) || 0,
    };
  }
  return out;
}

function sanitizeFrameDiagnostic(frame, secrets = []) {
  const rawUrl = String((frame && frame.url) || '');
  const inputCount = Number((frame && frame.inputCount) || 0);
  const inputs = Array.isArray(frame && frame.inputs) ? frame.inputs : [];
  const textSnippets = Array.isArray(frame && frame.textSnippets) ? frame.textSnippets : [];
  const blockerMarkers = Array.isArray(frame && frame.blockerMarkers) ? frame.blockerMarkers : [];
  return {
    index: Number((frame && frame.index) || 0),
    kind: normalizeDiagnosticText((frame && frame.kind) || 'frame', secrets, 40),
    isMain: !!(frame && frame.isMain),
    url: sanitizeUrlForDiagnostic(rawUrl, secrets),
    domain: domainForDiagnostic(rawUrl),
    title: normalizeDiagnosticText(frame && frame.title, secrets, 140),
    inputCount,
    inputs: inputs.slice(0, MAX_DIAGNOSTIC_INPUTS_PER_FRAME).map((input) => sanitizeInputDescriptor(input, secrets)),
    textSnippets: textSnippets
      .map((snippet) => normalizeDiagnosticText(snippet, secrets, MAX_DIAGNOSTIC_TEXT_CHARS))
      .filter(Boolean)
      .slice(0, MAX_DIAGNOSTIC_SNIPPETS_PER_FRAME),
    blockerMarkers: blockerMarkers
      .map((marker) => normalizeDiagnosticText(marker, secrets, 80))
      .filter(Boolean)
      .slice(0, 12),
    collectionError: frame && frame.collectionError
      ? normalizeDiagnosticText(frame.collectionError, secrets, 140)
      : undefined,
  };
}

function sanitizeLoginDiagnostic(raw, secrets = []) {
  const rawUrl = String((raw && raw.url) || '');
  const frames = Array.isArray(raw && raw.frames) ? raw.frames : [];
  const sanitizedFrames = frames.slice(0, MAX_DIAGNOSTIC_FRAMES).map((frame) => sanitizeFrameDiagnostic(frame, secrets));
  const allMarkers = [];
  for (const frame of sanitizedFrames) {
    for (const marker of frame.blockerMarkers || []) {
      if (!allMarkers.includes(marker)) allMarkers.push(marker);
    }
  }
  return {
    capturedAt: new Date().toISOString(),
    platform: normalizeDiagnosticText(raw && raw.platform, secrets, 40),
    reason: normalizeDiagnosticText(raw && raw.reason, secrets, 80),
    url: sanitizeUrlForDiagnostic(rawUrl, secrets),
    domain: domainForDiagnostic(rawUrl),
    title: normalizeDiagnosticText(raw && raw.title, secrets, 140),
    frameCount: Number((raw && raw.frameCount) || sanitizedFrames.length || 0),
    framesCaptured: sanitizedFrames.length,
    blockerMarkers: allMarkers.slice(0, 12),
    frames: sanitizedFrames,
  };
}

async function collectFrameDiagnostic(target, frameMeta) {
  if (!target || typeof target.evaluate !== 'function') {
    return Object.assign({}, frameMeta, {
      title: '',
      inputCount: 0,
      inputs: [],
      textSnippets: [],
      blockerMarkers: [],
      collectionError: 'target_has_no_evaluate',
    });
  }
  try {
    const captured = await target.evaluate(({ action, meta, limits }) => {
      if (action !== 'capture-login-diagnostics') return null;
      const excludeRe = /captcha|recaptcha|hcaptcha|otp|one[-_\s]?time|verification|verify|verifycode|2fa|mfa|code|search|query|coupon|voucher|pin|รหัสยืนยัน|ยืนยัน|ค้นหา/i;
      const usernameRe = /login|log[-_\s]?in|username|user|email|e-?mail|phone|mobile|tel|account|identifier|loginKey|หมายเลข|โทรศัพท์|ผู้ใช้|ชื่อผู้ใช้|อีเมล|อีเมล์/i;
      const passwordRe = /password|passwd|current-password|รหัสผ่าน/i;
      const blockerPatterns = [
        ['captcha', /captcha|recaptcha|hcaptcha|geetest|nc-container|baxia|slider-?verify|puzzle/i],
        ['otp_or_2fa', /otp|one[-_\s]?time|2fa|mfa|verification code|verifycode|รหัสยืนยัน|ยืนยันตัวตน/i],
        ['qr_login', /qr\s*code|scan\s*(to|with)|สแกน|คิวอาร์/i],
        ['password_login_option', /log\s*in\s*with\s*password|login\s*with\s*password|sign\s*in\s*with\s*password|ด้วยรหัสผ่าน|รหัสผ่าน/i],
        ['security_check', /security\s*check|unusual\s*activity|verify\s*it'?s\s*you|ตรวจสอบความปลอดภัย/i],
      ];

      function queryAllDeep(selector) {
        const out = [];
        const seen = new Set();
        const roots = [document];
        for (let i = 0; i < roots.length; i++) {
          const root = roots[i];
          if (!root || typeof root.querySelectorAll !== 'function') continue;
          let matches = [];
          try { matches = Array.from(root.querySelectorAll(selector)); } catch { matches = []; }
          for (const el of matches) {
            if (seen.has(el)) continue;
            seen.add(el);
            out.push(el);
          }
          let all = [];
          try { all = Array.from(root.querySelectorAll('*')); } catch { all = []; }
          for (const el of all) {
            if (el && el.shadowRoot && !seen.has(el.shadowRoot)) {
              seen.add(el.shadowRoot);
              roots.push(el.shadowRoot);
            }
          }
        }
        return out;
      }

      function rootFor(el) {
        try {
          const root = el && typeof el.getRootNode === 'function' ? el.getRootNode() : null;
          return root && typeof root.querySelectorAll === 'function' ? root : document;
        } catch {
          return document;
        }
      }

      function textById(root, id) {
        if (!id) return '';
        try {
          const fromRoot = root && typeof root.getElementById === 'function' ? root.getElementById(id) : null;
          if (fromRoot) return fromRoot.innerText || fromRoot.textContent || '';
        } catch {}
        try {
          const fromDocument = document.getElementById(id);
          if (fromDocument) return fromDocument.innerText || fromDocument.textContent || '';
        } catch {}
        return '';
      }

      function labelText(el) {
        const parts = [];
        const root = rootFor(el);
        try {
          const own = el.closest && el.closest('label');
          if (own && own.innerText) parts.push(own.innerText);
        } catch {}
        const id = el.getAttribute('id');
        if (id) {
          try {
            const labels = Array.from(root.querySelectorAll('label'));
            for (const label of labels) {
              if (label.getAttribute('for') === id && label.innerText) parts.push(label.innerText);
            }
          } catch {}
        }
        const labelledBy = String(el.getAttribute('aria-labelledby') || '').trim();
        if (labelledBy) {
          for (const refId of labelledBy.split(/\s+/)) {
            const text = textById(root, refId);
            if (text) parts.push(text);
          }
        }
        const describedBy = String(el.getAttribute('aria-describedby') || '').trim();
        if (describedBy) {
          for (const refId of describedBy.split(/\s+/)) {
            const text = textById(root, refId);
            if (text) parts.push(text);
          }
        }
        return parts.join(' ');
      }

      function isVisible(el) {
        if (!el || !(el instanceof Element)) return false;
        const style = window.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const vw = window.innerWidth || document.documentElement.clientWidth || 0;
        const vh = window.innerHeight || document.documentElement.clientHeight || 0;
        if (vw && rect.right < -20) return false;
        if (vh && rect.bottom < -20) return false;
        if (vw && rect.left > vw + 200) return false;
        if (vh && rect.top > vh + 400) return false;
        return true;
      }

      function attr(el, name) {
        try { return el.getAttribute(name) || ''; } catch { return ''; }
      }

      function markerFor(el) {
        return [
          attr(el, 'type'),
          attr(el, 'name'),
          attr(el, 'id'),
          attr(el, 'autocomplete'),
          attr(el, 'placeholder'),
          attr(el, 'aria-label'),
          attr(el, 'inputmode'),
          attr(el, 'class'),
          attr(el, 'role'),
          attr(el, 'title'),
          attr(el, 'contenteditable'),
          attr(el, 'data-testid'),
          attr(el, 'data-test'),
          labelText(el),
        ].join(' ');
      }

      function describeInput(el, index) {
        const rect = (() => {
          try {
            const r = el.getBoundingClientRect();
            return {
              x: Math.round(r.x || r.left || 0),
              y: Math.round(r.y || r.top || 0),
              width: Math.round(r.width || 0),
              height: Math.round(r.height || 0),
            };
          } catch {
            return { x: 0, y: 0, width: 0, height: 0 };
          }
        })();
        const marker = markerFor(el);
        const visible = isVisible(el);
        const disabled = !!el.disabled;
        const readOnly = !!el.readOnly;
        const type = String(attr(el, 'type') || '').toLowerCase();
        let candidate = '';
        if (type === 'password' || passwordRe.test(marker)) candidate = 'password';
        else if (usernameRe.test(marker)) candidate = 'username';
        else if (el.isContentEditable || attr(el, 'role') === 'textbox') candidate = 'textbox';
        else if (!type || type === 'text' || type === 'email' || type === 'tel') candidate = 'generic_text';
        const excluded = excludeRe.test(marker)
          ? 'excluded_by_login_field_filter'
          : (!visible ? 'not_visible' : (disabled ? 'disabled' : (readOnly ? 'read_only' : '')));
        return {
          index,
          tag: String(el.tagName || '').toLowerCase(),
          type: type || 'text',
          name: attr(el, 'name'),
          id: attr(el, 'id'),
          autocomplete: attr(el, 'autocomplete'),
          placeholder: attr(el, 'placeholder'),
          ariaLabel: attr(el, 'aria-label'),
          inputMode: attr(el, 'inputmode'),
          role: attr(el, 'role'),
          title: attr(el, 'title'),
          contentEditable: attr(el, 'contenteditable'),
          dataTestId: attr(el, 'data-testid') || attr(el, 'data-test'),
          visible,
          disabled,
          readOnly,
          rect,
          candidate,
          excluded,
          marker,
        };
      }

      const text = String((document.body && (document.body.innerText || document.body.textContent)) || '');
      const html = String((document.documentElement && document.documentElement.outerHTML) || '');
      const markerHaystack = `${text}\n${html}`;
      const blockerMarkers = [];
      for (const [name, pattern] of blockerPatterns) {
        if (pattern.test(markerHaystack)) blockerMarkers.push(name);
      }
      const snippets = [];
      const seenSnippets = new Set();
      for (const rawLine of text.split(/\n+/)) {
        const line = String(rawLine || '').replace(/\s+/g, ' ').trim();
        if (!line || line.length < 3 || seenSnippets.has(line)) continue;
        seenSnippets.add(line);
        snippets.push(line);
        if (snippets.length >= limits.maxSnippets) break;
      }
      const inputs = queryAllDeep('input,textarea,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"]');
      return Object.assign({}, meta, {
        title: String(document.title || ''),
        inputCount: inputs.length,
        inputs: inputs.slice(0, limits.maxInputs).map(describeInput),
        textSnippets: snippets,
        blockerMarkers,
      });
    }, {
      action: CAPTURE_LOGIN_DIAGNOSTICS_ACTION,
      meta: frameMeta,
      limits: {
        maxInputs: MAX_DIAGNOSTIC_INPUTS_PER_FRAME,
        maxSnippets: MAX_DIAGNOSTIC_SNIPPETS_PER_FRAME,
      },
    });
    return captured || Object.assign({}, frameMeta, {
      title: '',
      inputCount: 0,
      inputs: [],
      textSnippets: [],
      blockerMarkers: [],
      collectionError: 'empty_capture_result',
    });
  } catch (err) {
    return Object.assign({}, frameMeta, {
      title: '',
      inputCount: 0,
      inputs: [],
      textSnippets: [],
      blockerMarkers: [],
      collectionError: err && err.message ? err.message : String(err),
    });
  }
}

async function captureLoginDiagnostics(page, platform, reason, secrets = []) {
  const targets = fillTargets(page).slice(0, MAX_DIAGNOSTIC_FRAMES);
  const frameCount = (() => {
    try {
      const frames = typeof page.frames === 'function' ? page.frames() : [];
      return frames.length || targets.length;
    } catch {
      return targets.length;
    }
  })();
  const rawUrl = (() => {
    try { return page && typeof page.url === 'function' ? page.url() || '' : ''; } catch { return ''; }
  })();
  const raw = {
    platform,
    reason,
    url: rawUrl,
    title: '',
    frameCount,
    frames: [],
  };
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];
    const url = (() => {
      try { return target && typeof target.url === 'function' ? target.url() || rawUrl : rawUrl; } catch { return rawUrl; }
    })();
    const frame = await collectFrameDiagnostic(target, {
      index,
      kind: index === 0 ? 'page' : 'frame',
      isMain: index === 0,
      url,
    });
    if (index === 0 && frame && frame.title) raw.title = frame.title;
    raw.frames.push(frame);
  }
  return sanitizeLoginDiagnostic(raw, secrets);
}

async function detectManualBlocker(page) {
  const targets = fillTargets(page);
  for (const target of targets) {
    try {
      if (typeof target.content !== 'function') continue;
      const html = await target.content();
      if (html && CAPTCHA_MARKER_REGEX.test(html)) return 'captcha_or_otp_detected';
    } catch {}
  }
  return '';
}

function fillTargets(page) {
  const targets = [page];
  try {
    const main = typeof page.mainFrame === 'function' ? page.mainFrame() : null;
    const frames = typeof page.frames === 'function' ? page.frames() : [];
    for (const frame of frames) {
      if (frame && frame !== main && !targets.includes(frame)) targets.push(frame);
    }
  } catch {}
  return targets;
}

async function clickPasswordLoginIfPresent(page, opts = {}) {
  const maxAttempts = Number.isFinite(opts.maxAttempts) ? Math.max(1, opts.maxAttempts) : 4;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const targets = fillTargets(page);
    for (const target of targets) {
      for (const sel of PASSWORD_LOGIN_SELECTORS) {
        const clicked = await clickSelectorIfVisible(target, sel);
        if (clicked) {
          await page.waitForTimeout(700).catch(() => {});
          return clicked;
        }
      }
      const fallback = await clickPasswordLoginFallback(target);
      if (fallback) {
        await page.waitForTimeout(700).catch(() => {});
        return fallback;
      }
    }
    await page.waitForTimeout(450).catch(() => {});
  }
  return '';
}

async function clickSelectorIfVisible(target, sel) {
  try {
    if (typeof target.locator === 'function') {
      const raw = target.locator(sel);
      const locator = raw && typeof raw.first === 'function' ? raw.first() : raw;
      if (locator && typeof locator.isVisible === 'function') {
        const visible = await locator.isVisible({ timeout: 250 });
        if (!visible) return '';
      }
      if (locator && typeof locator.click === 'function') {
        await locator.click({ timeout: 800 });
        return sel;
      }
    }
  } catch {}
  try {
    await target.click(sel, { timeout: 500 });
    return sel;
  } catch {}
  return '';
}

async function clickPasswordLoginFallback(target) {
  if (!target || typeof target.evaluate !== 'function') return '';
  try {
    const result = await target.evaluate(({ action }) => {
      if (action !== 'click-password-login') return '';
      const passwordTextRe = /(log\s*in|login|sign\s*in|continue|เข้าสู่ระบบ)[\s\S]{0,80}(password|รหัสผ่าน)|(password|รหัสผ่าน)[\s\S]{0,80}(log\s*in|login|sign\s*in|continue|เข้าสู่ระบบ)|ด้วยรหัสผ่าน|password|รหัสผ่าน/i;

      function queryAllDeep(selector) {
        const out = [];
        const seen = new Set();
        const roots = [document];
        for (let i = 0; i < roots.length; i++) {
          const root = roots[i];
          if (!root || typeof root.querySelectorAll !== 'function') continue;
          let matches = [];
          try { matches = Array.from(root.querySelectorAll(selector)); } catch { matches = []; }
          for (const el of matches) {
            if (seen.has(el)) continue;
            seen.add(el);
            out.push(el);
          }
          let all = [];
          try { all = Array.from(root.querySelectorAll('*')); } catch { all = []; }
          for (const el of all) {
            if (el && el.shadowRoot && !seen.has(el.shadowRoot)) {
              seen.add(el.shadowRoot);
              roots.push(el.shadowRoot);
            }
          }
        }
        return out;
      }

      function isVisible(el) {
        if (!el || !(el instanceof Element)) return false;
        const style = window.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      function isClickable(el) {
        if (!el) return false;
        const tag = String(el.tagName || '').toLowerCase();
        if (tag === 'button' || tag === 'a') return true;
        const role = el.getAttribute('role');
        if (role === 'button' || role === 'tab' || role === 'menuitem' || role === 'link') return true;
        if (el.hasAttribute('tabindex')) return true;
        const style = window.getComputedStyle(el);
        return !!(style && style.cursor === 'pointer');
      }

      const candidates = queryAllDeep('button,a,[role="button"],[role="tab"],[role="menuitem"],[role="link"],[tabindex],div,span');
      for (const el of candidates) {
        if (!isVisible(el) || !isClickable(el)) continue;
        const text = String((el.innerText || el.textContent || '')).replace(/\s+/g, ' ').trim();
        if (!text || text.length > 140 || !passwordTextRe.test(text)) continue;
        try {
          el.click();
          return 'dom:password-login';
        } catch {}
      }
      return '';
    }, { action: CLICK_PASSWORD_LOGIN_ACTION });
    return result ? String(result) : '';
  } catch {}
  return '';
}

async function fillBySelector(target, sel, value) {
  try {
    if (typeof target.locator === 'function') {
      const raw = target.locator(sel);
      const locator = raw && typeof raw.first === 'function' ? raw.first() : raw;
      if (locator && typeof locator.isVisible === 'function') {
        const visible = await locator.isVisible({ timeout: 250 });
        if (!visible) return '';
      }
      if (locator && typeof locator.fill === 'function') {
        await locator.fill(value, { timeout: 1000 });
        return sel;
      }
    }
  } catch {}
  try {
    await target.fill(sel, value, { timeout: 700 });
    return sel;
  } catch {}
  return '';
}

async function locatorMarker(locator) {
  if (!locator || typeof locator.evaluate !== 'function') return '';
  try {
    return await locator.evaluate((el) => {
      if (!el) return '';
      const attrs = [
        'type',
        'name',
        'id',
        'autocomplete',
        'placeholder',
        'aria-label',
        'inputmode',
        'class',
      ];
      return attrs.map((name) => el.getAttribute(name) || '').join(' ');
    });
  } catch {}
  return '';
}

async function fillVisibleInputFallback(target, value, kind) {
  const selector = kind === 'password'
    ? 'input[type="password"]'
    : 'input:not([type="hidden"]):not([type="password"]):not([disabled])';
  try {
    const locators = await target.locator(selector).all();
    for (const locator of locators) {
      try {
        if (!(await locator.isVisible({ timeout: 500 }))) continue;
        const marker = await locatorMarker(locator);
        if (marker && FIELD_EXCLUDE_REGEX.test(marker)) continue;
        await locator.fill(value, { timeout: 1000 });
        return `${selector}:visible`;
      } catch {}
    }
  } catch {}
  return '';
}

async function fillBestVisibleInput(target, value, kind) {
  if (!target || typeof target.evaluate !== 'function') return '';
  try {
    const result = await target.evaluate(({ action, kind, value }) => {
      if (action !== 'fill-login-input') return '';

      const excludeRe = /captcha|recaptcha|hcaptcha|otp|one[-_\s]?time|verification|verify|verifycode|2fa|mfa|code|search|query|coupon|voucher|pin|รหัสยืนยัน|ยืนยัน|ค้นหา/i;
      const usernameRe = /login|log[-_\s]?in|username|user|email|e-?mail|phone|mobile|tel|account|identifier|loginKey|หมายเลข|โทรศัพท์|ผู้ใช้|ชื่อผู้ใช้|อีเมล|อีเมล์/i;
      const passwordRe = /password|passwd|current-password|รหัสผ่าน/i;
      const badTypes = new Set(['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color', 'date', 'month', 'week', 'time']);

      function queryAllDeep(selector) {
        const out = [];
        const seen = new Set();
        const roots = [document];
        for (let i = 0; i < roots.length; i++) {
          const root = roots[i];
          if (!root || typeof root.querySelectorAll !== 'function') continue;
          let matches = [];
          try { matches = Array.from(root.querySelectorAll(selector)); } catch { matches = []; }
          for (const el of matches) {
            if (seen.has(el)) continue;
            seen.add(el);
            out.push(el);
          }
          let all = [];
          try { all = Array.from(root.querySelectorAll('*')); } catch { all = []; }
          for (const el of all) {
            if (el && el.shadowRoot && !seen.has(el.shadowRoot)) {
              seen.add(el.shadowRoot);
              roots.push(el.shadowRoot);
            }
          }
        }
        return out;
      }

      function rootFor(el) {
        try {
          const root = el && typeof el.getRootNode === 'function' ? el.getRootNode() : null;
          return root && typeof root.querySelectorAll === 'function' ? root : document;
        } catch {
          return document;
        }
      }

      function textById(root, id) {
        if (!id) return '';
        try {
          const fromRoot = root && typeof root.getElementById === 'function' ? root.getElementById(id) : null;
          if (fromRoot) return fromRoot.innerText || fromRoot.textContent || '';
        } catch {}
        try {
          const fromDocument = document.getElementById(id);
          if (fromDocument) return fromDocument.innerText || fromDocument.textContent || '';
        } catch {}
        return '';
      }

      function isVisible(el) {
        if (!el || !(el instanceof Element)) return false;
        const style = window.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const vw = window.innerWidth || document.documentElement.clientWidth || 0;
        const vh = window.innerHeight || document.documentElement.clientHeight || 0;
        if (vw && rect.right < -20) return false;
        if (vh && rect.bottom < -20) return false;
        if (vw && rect.left > vw + 200) return false;
        if (vh && rect.top > vh + 400) return false;
        return true;
      }

      function labelText(el) {
        const parts = [];
        const root = rootFor(el);
        try {
          const own = el.closest && el.closest('label');
          if (own && own.innerText) parts.push(own.innerText);
        } catch {}
        const id = el.getAttribute('id');
        if (id) {
          try {
            const labels = Array.from(root.querySelectorAll('label'));
            for (const label of labels) {
              if (label.getAttribute('for') === id && label.innerText) parts.push(label.innerText);
            }
          } catch {}
        }
        const labelledBy = String(el.getAttribute('aria-labelledby') || '').trim();
        if (labelledBy) {
          for (const refId of labelledBy.split(/\s+/)) {
            const text = textById(root, refId);
            if (text) parts.push(text);
          }
        }
        const describedBy = String(el.getAttribute('aria-describedby') || '').trim();
        if (describedBy) {
          for (const refId of describedBy.split(/\s+/)) {
            const text = textById(root, refId);
            if (text) parts.push(text);
          }
        }
        return parts.join(' ');
      }

      function marker(el) {
        const attrs = [
          'type',
          'name',
          'id',
          'autocomplete',
          'placeholder',
          'aria-label',
          'inputmode',
          'class',
          'role',
          'title',
          'contenteditable',
          'data-testid',
          'data-test',
        ];
        const parts = attrs.map((name) => el.getAttribute(name) || '');
        parts.push(labelText(el));
        return parts.join(' ');
      }

      function describe(el, index) {
        const name = el.getAttribute('name');
        if (name) return 'dom:input[name="' + name + '"]';
        const id = el.getAttribute('id');
        if (id) return 'dom:input#' + id;
        const role = el.getAttribute('role');
        if (role) return 'dom:' + role + ':' + index;
        if (el.isContentEditable || String(el.getAttribute('contenteditable') || '').toLowerCase() === 'true') {
          return 'dom:contenteditable:' + index;
        }
        const type = el.getAttribute('type');
        if (type) return 'dom:input[type="' + type + '"]';
        return 'dom:input:' + index;
      }

      function setNativeValue(el, nextValue) {
        el.focus();
        const tag = String(el.tagName || '').toLowerCase();
        if (tag !== 'input' && tag !== 'textarea') {
          el.textContent = nextValue;
          try {
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
          } catch {
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
        const proto = tag === 'textarea'
          ? window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement && window.HTMLInputElement.prototype;
        const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
        if (desc && typeof desc.set === 'function') desc.set.call(el, nextValue);
        else el.value = nextValue;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      const allInputs = queryAllDeep('input,textarea,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"]')
        .filter((el) => isVisible(el) && !el.disabled && !el.readOnly);
      const passwordInputs = allInputs.filter((el) => {
        if (el.isContentEditable) return passwordRe.test(marker(el));
        const type = String(el.getAttribute('type') || '').toLowerCase();
        return type === 'password' || passwordRe.test(marker(el));
      });
      const firstPassword = passwordInputs[0] || null;

      const candidates = allInputs.map((el, index) => {
        const tag = String(el.tagName || '').toLowerCase();
        const editable = !!(el.isContentEditable || String(el.getAttribute('contenteditable') || '').toLowerCase() === 'true' || String(el.getAttribute('contenteditable') || '').toLowerCase() === 'plaintext-only' || el.getAttribute('role') === 'textbox');
        const type = editable && tag !== 'input' && tag !== 'textarea'
          ? 'text'
          : String(el.getAttribute('type') || 'text').toLowerCase();
        const text = marker(el);
        if (badTypes.has(type)) return null;
        if (excludeRe.test(text)) return null;
        if (kind === 'password') {
          let score = 0;
          if (type === 'password') score += 100;
          if (passwordRe.test(text)) score += 50;
          if (/current-password/i.test(text)) score += 20;
          if (score <= 0) return null;
          return { el, index, score };
        }
        if (type === 'password') return null;
        let score = 0;
        if (usernameRe.test(text)) score += 80;
        if (type === 'email' || type === 'tel') score += 45;
        if (editable) score += 18;
        if (/username|email|tel/i.test(el.getAttribute('autocomplete') || '')) score += 35;
        if (!type || type === 'text') score += 12;
        if (firstPassword) {
          if (el.form && firstPassword.form && el.form === firstPassword.form) score += 30;
          try {
            if (el.compareDocumentPosition(firstPassword) & Node.DOCUMENT_POSITION_FOLLOWING) score += 25;
          } catch {}
          const r1 = el.getBoundingClientRect();
          const r2 = firstPassword.getBoundingClientRect();
          const verticalGap = Math.abs(r1.top - r2.top);
          if (verticalGap < 260) score += Math.max(0, 20 - (verticalGap / 20));
        }
        if (allInputs.length === 1) score += 20;
        if (score <= 0) return null;
        return { el, index, score: score - (index / 100) };
      }).filter(Boolean);

      candidates.sort((a, b) => b.score - a.score);
      const picked = candidates[0];
      if (!picked) return '';
      setNativeValue(picked.el, value);
      return describe(picked.el, picked.index);
    }, { action: FILL_ACTION, kind, value });
    return result ? String(result) : '';
  } catch {}
  return '';
}

async function tryFill(page, selectors, value, kind = 'text', opts = {}) {
  const maxAttempts = Number.isFinite(opts.maxAttempts)
    ? Math.max(1, opts.maxAttempts)
    : (kind === 'password' ? 18 : 32);
  const beforeAttempt = typeof opts.beforeAttempt === 'function' ? opts.beforeAttempt : null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (beforeAttempt) await beforeAttempt(attempt).catch(() => {});
    const targets = fillTargets(page);
    for (const target of targets) {
      const ranked = await fillBestVisibleInput(target, value, kind);
      if (ranked) return ranked;
      for (const sel of selectors) {
        const filled = await fillBySelector(target, sel, value);
        if (filled) return filled;
      }
      const fallback = await fillVisibleInputFallback(target, value, kind);
      if (fallback) return fallback;
    }
    await page.waitForTimeout(650).catch(() => {});
  }
  return '';
}

async function trySubmit(page) {
  const targets = fillTargets(page);
  for (const target of targets) {
    for (const sel of SUBMIT_SELECTORS) {
      try {
        await target.click(sel, { timeout: 1500 });
        return sel;
      } catch {}
    }
  }
  try {
    await page.keyboard.press('Enter');
    return 'keyboard:Enter';
  } catch {}
  return '';
}

async function attemptLogin(page, platform, username, password, opts = {}) {
  const { submit = true } = opts;
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1200).catch(() => {});
  } catch {}

  if (platform === 'shopee' && isShopeeRouteNotFoundUrl(currentPageUrl(page))) {
    const diagnostic = await captureLoginDiagnostics(page, platform, SHOPEE_ROUTE_NOT_FOUND_REASON, [username, password]);
    return {
      filled: false,
      submitted: false,
      needsManual: true,
      reason: SHOPEE_ROUTE_NOT_FOUND_REASON,
      diagnostic,
    };
  }

  const preBlocker = await detectManualBlocker(page);
  if (preBlocker) {
    const diagnostic = await captureLoginDiagnostics(page, platform, preBlocker, [username, password]);
    return { filled: false, submitted: false, needsManual: true, reason: preBlocker, diagnostic };
  }

  await clickPasswordLoginIfPresent(page, { maxAttempts: 4 }).catch(() => {});

  const userSel = await tryFill(page, usernameSelectorsFor(platform), username, 'text', {
    beforeAttempt: async (attempt) => {
      if (platform === 'shopee' && attempt % 3 === 0) {
        await clickPasswordLoginIfPresent(page, { maxAttempts: 1 });
      }
    },
  });
  if (!userSel) {
    const blocker = await detectManualBlocker(page);
    const reason = blocker || 'username_field_not_found';
    const diagnostic = await captureLoginDiagnostics(page, platform, reason, [username, password]);
    return { filled: false, submitted: false, needsManual: true, reason, diagnostic };
  }

  const passSel = await tryFill(page, PASSWORD_SELECTORS, password, 'password', {
    beforeAttempt: async (attempt) => {
      if (platform === 'shopee' && attempt % 4 === 0) {
        await clickPasswordLoginIfPresent(page, { maxAttempts: 1 });
      }
    },
  });
  if (!passSel) {
    const blocker = await detectManualBlocker(page);
    const reason = blocker || 'password_field_not_found';
    const diagnostic = await captureLoginDiagnostics(page, platform, reason, [username, password]);
    return { filled: false, submitted: false, needsManual: true, reason, diagnostic };
  }

  if (!submit) {
    return { filled: true, submitted: false, needsManual: false, reason: '' };
  }

  const submitSel = await trySubmit(page);
  if (!submitSel) {
    const diagnostic = await captureLoginDiagnostics(page, platform, 'submit_failed', [username, password]);
    return { filled: true, submitted: false, needsManual: true, reason: 'submit_failed', diagnostic };
  }

  try {
    await page.waitForTimeout(2500).catch(() => {});
  } catch {}

  const postBlocker = await detectManualBlocker(page);
  if (postBlocker) {
    const diagnostic = await captureLoginDiagnostics(page, platform, postBlocker, [username, password]);
    return { filled: true, submitted: true, needsManual: true, reason: postBlocker, diagnostic };
  }

  return { filled: true, submitted: true, needsManual: false, reason: '' };
}

module.exports = {
  attemptLogin,
  captureLoginDiagnostics,
  detectManualBlocker,
  usernameSelectorsFor,
  PASSWORD_SELECTORS,
  SUBMIT_SELECTORS,
};
