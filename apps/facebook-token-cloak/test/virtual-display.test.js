'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseBounds,
  parseWindowSize,
  resolveWindowSize,
  readVirtualDisplayConfig,
  buildVirtualDisplayLaunchOptions,
} = require('../src/virtualDisplay');

// ── parseBounds ─────────────────────────────────────────────────────────────────────────────────

test('parseBounds accepts a valid "x,y,width,height" quad', () => {
  assert.deepEqual(parseBounds('3840,0,1280,800'), { x: 3840, y: 0, width: 1280, height: 800 });
  assert.deepEqual(parseBounds(' 100 , 200 , 1024 , 768 '), { x: 100, y: 200, width: 1024, height: 768 });
});

test('parseBounds allows negative origins (virtual display left/above main)', () => {
  assert.deepEqual(parseBounds('-1920,-1080,1920,1080'), { x: -1920, y: -1080, width: 1920, height: 1080 });
});

test('parseBounds rejects malformed / out-of-range input (returns null, never throws)', () => {
  assert.equal(parseBounds(''), null);
  assert.equal(parseBounds(null), null);
  assert.equal(parseBounds(undefined), null);
  assert.equal(parseBounds('1,2,3'), null); // too few
  assert.equal(parseBounds('1,2,3,4,5'), null); // too many
  assert.equal(parseBounds('a,b,c,d'), null); // non-numeric
  assert.equal(parseBounds('0,0,10.5,800'), null); // non-integer
  assert.equal(parseBounds('0,0,1,800'), null); // width below MIN_DIMENSION
  assert.equal(parseBounds('0,0,1280,99999'), null); // height above MAX_DIMENSION
  assert.equal(parseBounds('999999,0,1280,800'), null); // origin out of range
});

// ── parseWindowSize / resolveWindowSize ───────────────────────────────────────────────────────────

test('parseWindowSize accepts WxH and W,H', () => {
  assert.deepEqual(parseWindowSize('1440x900'), { width: 1440, height: 900 });
  assert.deepEqual(parseWindowSize('1440,900'), { width: 1440, height: 900 });
  assert.equal(parseWindowSize('garbage'), null);
  assert.equal(parseWindowSize('1440'), null);
});

test('resolveWindowSize prefers bounds, then WINDOW_SIZE env, then default', () => {
  assert.deepEqual(resolveWindowSize({ x: 0, y: 0, width: 1280, height: 800 }, '1440x900'), { width: 1280, height: 800 });
  assert.deepEqual(resolveWindowSize(null, '1440x900'), { width: 1440, height: 900 });
  assert.deepEqual(resolveWindowSize(null, null), { width: 1280, height: 800 });
});

// ── buildVirtualDisplayLaunchOptions ──────────────────────────────────────────────────────────────

test('buildVirtualDisplayLaunchOptions emits window-position + window-size + start-windowed for bounds', () => {
  const args = buildVirtualDisplayLaunchOptions({ bounds: { x: 3840, y: 0, width: 1280, height: 800 } });
  assert.ok(args.includes('--window-position=3840,0'));
  assert.ok(args.includes('--window-size=1280,800'));
  assert.ok(args.includes('--start-windowed'));
  // Must NOT duplicate the launch args browser.js already provides.
  assert.ok(!args.some((a) => a.startsWith('--no-first-run')));
});

test('buildVirtualDisplayLaunchOptions omits window-position when no bounds (main fallback)', () => {
  const args = buildVirtualDisplayLaunchOptions({ windowSize: { width: 1024, height: 768 } });
  assert.ok(!args.some((a) => a.startsWith('--window-position')));
  assert.ok(args.includes('--window-size=1024,768'));
  assert.ok(args.includes('--start-windowed'));
});

// ── readVirtualDisplayConfig ──────────────────────────────────────────────────────────────────────

test('readVirtualDisplayConfig: virtual is the default and uses configured bounds', () => {
  const cfg = readVirtualDisplayConfig({ ACCOUNTS_BRIDGE_VIRTUAL_DISPLAY_BOUNDS: '3840,0,1280,800' });
  assert.equal(cfg.target, 'virtual');
  assert.equal(cfg.mode, 'virtual');
  assert.equal(cfg.configured, true);
  assert.equal(cfg.placementApplied, true);
  assert.equal(cfg.reason, null);
  assert.ok(cfg.launchArgs.includes('--window-position=3840,0'));
  assert.equal(cfg.metadata.displayTarget, 'virtual');
  assert.equal(cfg.metadata.displayBounds, '3840,0,1280,800');
  assert.equal(cfg.metadata.displayConfigured, true);
  assert.equal(cfg.metadata.placementApplied, true);
});

test('readVirtualDisplayConfig: missing bounds falls back to main HONESTLY with a reason', () => {
  const cfg = readVirtualDisplayConfig({});
  assert.equal(cfg.target, 'main');
  assert.equal(cfg.configured, false);
  assert.equal(cfg.placementApplied, false);
  assert.equal(cfg.reason, 'virtual_display_bounds_missing');
  assert.ok(!cfg.launchArgs.some((a) => a.startsWith('--window-position')));
  assert.equal(cfg.metadata.displayTarget, 'main');
  assert.equal(cfg.metadata.displayBounds, null);
});

test('readVirtualDisplayConfig: explicit main mode never places the window even with bounds', () => {
  const cfg = readVirtualDisplayConfig({
    ACCOUNTS_BRIDGE_REMOTE_BROWSER_DISPLAY: 'main',
    ACCOUNTS_BRIDGE_VIRTUAL_DISPLAY_BOUNDS: '3840,0,1280,800',
  });
  assert.equal(cfg.target, 'main');
  assert.equal(cfg.configured, false);
  assert.equal(cfg.placementApplied, false);
  assert.equal(cfg.reason, 'display_mode_main');
  assert.ok(!cfg.launchArgs.some((a) => a.startsWith('--window-position')));
});

test('readVirtualDisplayConfig metadata carries no secret-shaped keys', () => {
  const cfg = readVirtualDisplayConfig({ ACCOUNTS_BRIDGE_VIRTUAL_DISPLAY_BOUNDS: '3840,0,1280,800' });
  assert.ok(!/cookie|token|password|datr|dtsg|secret/i.test(JSON.stringify(cfg.metadata)));
});
