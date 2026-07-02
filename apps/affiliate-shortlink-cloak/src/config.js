'use strict';

const path = require('path');
const os = require('os');

const DEFAULT_PORT = Number(process.env.AFFILIATE_CLOAK_PORT || 8810);
const DEFAULT_HOST = process.env.AFFILIATE_CLOAK_HOST || '127.0.0.1';

const PROFILE_ROOT = process.env.AFFILIATE_CLOAK_PROFILE_DIR
  || path.join(os.homedir(), '.affiliate-shortlink-cloak', 'profiles');

const SHOPEE_AFFILIATE_HOME_URL = 'https://affiliate.shopee.co.th/';
const SHOPEE_LEGACY_CUSTOM_LINK_URL = 'https://affiliate.shopee.co.th/offer/custom_link';
const SHOPEE_URL = SHOPEE_AFFILIATE_HOME_URL;
const SHOPEE_LOGIN_URL = 'https://shopee.co.th/buyer/login?next=' + encodeURIComponent(SHOPEE_AFFILIATE_HOME_URL);
const SHOPEE_CUSTOM_LINK_ROUTE_CANDIDATES = [
  SHOPEE_AFFILIATE_HOME_URL,
];
const LAZADA_URL = 'https://www.lazada.co.th';
const LAZADA_LOGIN_URL = 'https://member.lazada.co.th/user/login';

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const DEFAULT_ACCOUNT = 'default';

const SHORTEN_TIMEOUT_MS = 25000;
const MAX_SHORTEN_ATTEMPTS = 3;
const BETWEEN_ATTEMPT_DELAY_MS = [0, 1500, 3500];

// Auto-close idle browser contexts so the CloakBrowser Chromium process (and its
// macOS Dock icon) doesn't linger between shortlink calls. Sessions persist via
// the persistent userDataDir cookies, so reopening on the next call is cheap.
// Override with env AFFILIATE_CLOAK_BROWSER_IDLE_MS; set it to 0 to disable.
const DEFAULT_BROWSER_IDLE_MS = 30000;

module.exports = {
  DEFAULT_PORT,
  DEFAULT_HOST,
  PROFILE_ROOT,
  SHOPEE_AFFILIATE_HOME_URL,
  SHOPEE_LEGACY_CUSTOM_LINK_URL,
  SHOPEE_URL,
  SHOPEE_LOGIN_URL,
  SHOPEE_CUSTOM_LINK_ROUTE_CANDIDATES,
  LAZADA_URL,
  LAZADA_LOGIN_URL,
  CHROME_UA,
  DEFAULT_ACCOUNT,
  SHORTEN_TIMEOUT_MS,
  MAX_SHORTEN_ATTEMPTS,
  BETWEEN_ATTEMPT_DELAY_MS,
  DEFAULT_BROWSER_IDLE_MS,
};
