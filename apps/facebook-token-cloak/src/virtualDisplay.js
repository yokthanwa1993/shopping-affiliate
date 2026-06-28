'use strict';

// Virtual Display targeting for the Cloud Browser (remote browser) feature.
//
// WHY THIS EXISTS: Facebook must see a REAL display (the browser stays HEADFUL), but the operator does
// not want that window to land on the Mac's main/remote desktop. The chosen approach is a macOS VIRTUAL
// display (e.g. created by BetterDisplay): the headful Chromium window is positioned onto the virtual
// display's bounds so only Pubilo streams/controls its viewport — no noVNC, no full-desktop capture.
//
// This module is PURE + testable. It NEVER shells out to BetterDisplay or any CLI from the request path
// (the Dev Lead provisions the virtual display + bounds as an external ops step). It only:
//   * parses operator-configured bounds/size from env,
//   * decides the display target (virtual vs main fallback),
//   * builds the Chromium window-placement launch args.
// It carries NO secrets — bounds/size are plain geometry.

// A virtual display is real estate, not megapixels — keep dimensions in a sane range so a typo can't
// spawn a 1px or a 100k-px window. (8K-ish ceiling leaves headroom for stacked virtual displays.)
const MIN_DIMENSION = 100;
const MAX_DIMENSION = 16384;
// A virtual display may be placed left of / above the main display, so origins can be negative; still
// bound them so a garbage value can't fling the window into nowhere.
const MAX_ORIGIN = 100000;
const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 800;

function isSaneDimension(n) {
  return Number.isInteger(n) && n >= MIN_DIMENSION && n <= MAX_DIMENSION;
}
function isSaneOrigin(n) {
  return Number.isInteger(n) && Math.abs(n) <= MAX_ORIGIN;
}

// parseBounds("x,y,width,height") → { x, y, width, height } | null.
// Accepts a comma-separated quad of finite integers; width/height must be reasonable display sizes and
// x/y reasonable origins. Returns null (never throws) on any malformed/empty/out-of-range input so the
// caller can fall back safely instead of crashing the request path.
function parseBounds(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const parts = text.split(',').map((s) => s.trim());
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (p === '' ? NaN : Number(p)));
  if (!nums.every((n) => Number.isFinite(n) && Number.isInteger(n))) return null;
  const [x, y, width, height] = nums;
  if (!isSaneOrigin(x) || !isSaneOrigin(y)) return null;
  if (!isSaneDimension(width) || !isSaneDimension(height)) return null;
  return { x, y, width, height };
}

// parseWindowSize("WxH" | "W,H") → { width, height } | null. Used only when bounds are absent.
function parseWindowSize(value) {
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  if (!text) return null;
  const parts = text.split(/[x,]/).map((s) => s.trim());
  if (parts.length !== 2) return null;
  const nums = parts.map((p) => (p === '' ? NaN : Number(p)));
  if (!nums.every((n) => Number.isFinite(n) && Number.isInteger(n))) return null;
  const [width, height] = nums;
  if (!isSaneDimension(width) || !isSaneDimension(height)) return null;
  return { width, height };
}

// Window size priority: the virtual display's bounds (fill it exactly) → an explicit WINDOW_SIZE
// override → a sane default. A window with no virtual display still gets a deterministic size.
function resolveWindowSize(bounds, rawWindowSize) {
  if (bounds) return { width: bounds.width, height: bounds.height };
  const fromEnv = parseWindowSize(rawWindowSize);
  if (fromEnv) return fromEnv;
  return { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT };
}

function boundsToString(bounds) {
  return bounds ? `${bounds.x},${bounds.y},${bounds.width},${bounds.height}` : null;
}

// buildVirtualDisplayLaunchOptions(config) → Chromium args array.
//   --window-position=<x>,<y>   place the window onto the virtual display origin (only when bounds set)
//   --window-size=<w>,<h>       size the window (fills the virtual display, or the configured size)
//   --start-windowed            never start maximized/fullscreen on the wrong display
// Intentionally does NOT emit --no-first-run / --no-default-browser-check — browser.js already supplies
// those anti-automation/launch args and merges by flag name, so duplicating here would be wasteful.
function buildVirtualDisplayLaunchOptions(config = {}) {
  const bounds = config.bounds || null;
  const windowSize =
    config.windowSize ||
    (bounds ? { width: bounds.width, height: bounds.height } : { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT });
  const args = [];
  if (bounds) args.push(`--window-position=${bounds.x},${bounds.y}`);
  args.push(`--window-size=${windowSize.width},${windowSize.height}`);
  args.push('--start-windowed');
  return args;
}

// readVirtualDisplayConfig(env) — resolve the operator's Cloud Browser display intent.
//   ACCOUNTS_BRIDGE_REMOTE_BROWSER_DISPLAY    main | virtual   (default: virtual — remote-browser only)
//   ACCOUNTS_BRIDGE_VIRTUAL_DISPLAY_BOUNDS    "x,y,width,height" of the virtual display
//   ACCOUNTS_BRIDGE_REMOTE_BROWSER_WINDOW_SIZE  "WxH" fallback size when no bounds
//
// Returns { target, mode, bounds, configured, placementApplied, reason, windowSize, launchArgs, metadata }.
//   target            'virtual' when a virtual display is configured + reachable, else 'main'
//   configured        true only when virtual mode AND bounds parsed successfully
//   placementApplied  true when launchArgs include a --window-position (i.e. we really placed it)
//   reason            non-null when we could NOT honor virtual mode — e.g. 'virtual_display_bounds_missing'
//                     or 'display_mode_main'. We never lie: missing bounds → main target + this reason.
//   metadata          secret-free, dashboard-safe projection (displayTarget/displayBounds/...).
function readVirtualDisplayConfig(env = process.env) {
  const source = env || {};
  const rawMode = String(source.ACCOUNTS_BRIDGE_REMOTE_BROWSER_DISPLAY || '').trim().toLowerCase();
  // Default to virtual for the remote-browser path (the whole point of this feature), only opting out of
  // placement when the operator explicitly asks for 'main'.
  const mode = rawMode === 'main' ? 'main' : 'virtual';
  const bounds = parseBounds(source.ACCOUNTS_BRIDGE_VIRTUAL_DISPLAY_BOUNDS);
  const windowSize = resolveWindowSize(bounds, source.ACCOUNTS_BRIDGE_REMOTE_BROWSER_WINDOW_SIZE);

  let target;
  let configured;
  let reason;
  if (mode === 'main') {
    // Operator opted out of the virtual display — size the window but never reposition it.
    target = 'main';
    configured = false;
    reason = 'display_mode_main';
  } else if (!bounds) {
    // Virtual mode requested but no bounds to place onto — fall back to the main display HONESTLY.
    target = 'main';
    configured = false;
    reason = 'virtual_display_bounds_missing';
  } else {
    target = 'virtual';
    configured = true;
    reason = null;
  }

  const placedBounds = target === 'virtual' ? bounds : null;
  const launchArgs = buildVirtualDisplayLaunchOptions({ bounds: placedBounds, windowSize });
  const placementApplied = !!placedBounds;

  return {
    target,
    mode,
    bounds: placedBounds,
    configured,
    placementApplied,
    reason,
    windowSize,
    launchArgs,
    metadata: {
      displayTarget: target,
      displayMode: mode,
      displayBounds: boundsToString(placedBounds),
      displayConfigured: configured,
      placementApplied,
      windowSize: `${windowSize.width}x${windowSize.height}`,
      reason: reason || null,
    },
  };
}

module.exports = {
  parseBounds,
  parseWindowSize,
  resolveWindowSize,
  readVirtualDisplayConfig,
  buildVirtualDisplayLaunchOptions,
  DEFAULT_WINDOW_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
};
