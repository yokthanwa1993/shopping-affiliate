'use strict';

// Fast Graph polling so /post + /create-ad happy paths don't wait real seconds.
process.env.FACEBOOK_TOKEN_CLOAK_POLL_MS = '0';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createServer, DEFAULT_TEMPLATE_ADSET } = require('../src/server');

const USER_TOKEN_SECRET = 'EAAB_USER_SECRET';
const PAGE_TOKEN_SECRET = 'PAGE_SECRET_TOKEN';
const LIVE_PAGE_ID = '107267395614980';

test('bridge default template adset is the current SALES template, not retired pre-SALES template', () => {
  assert.equal(DEFAULT_TEMPLATE_ADSET, '120248134990230263');
  assert.notEqual(DEFAULT_TEMPLATE_ADSET, '120244361318490263');
});

function assertNoLeak(value) {
  const payload = JSON.stringify(value);
  for (const secret of [USER_TOKEN_SECRET, PAGE_TOKEN_SECRET]) {
    assert.ok(!payload.includes(secret), `leaked secret ${secret}`);
  }
}

// Graph response router — mirrors the live Graph happy path. Returns the parsed body object;
// the mock browser wraps it as the in-page fetch result ({ status, ok, text }).
function graphRoute(url, method, pages, opts = {}) {
  const u = String(url);
  const reqBody = String(opts.body || '');
  // pause-ad-only: status read-back after a { status: 'PAUSED' } write. Must precede the daily-
  // campaign adset readback below (which matches the broader /effective_status/). The pause readback
  // requests EXACTLY fields=status,effective_status; echo PAUSED so auto-pause can confirm the off-state.
  if (method === 'GET' && /\?fields=status,effective_status&/.test(u)) {
    return { status: 'PAUSED', effective_status: 'PAUSED' };
  }
  // CAMPAIGN-level (CBO) budget update POST on a REUSED daily campaign: { daily_budget } only, sent
  // to the campaign id (NOT an adset). opts.campaignBudgetError simulates a Graph error on it — the
  // bridge treats this update as best-effort and must NOT fail the whole flow.
  if (method === 'POST' && /\/CAMP(DAILY|1)\?/.test(u) && /daily_budget/.test(reqBody) && !/"status"/.test(reqBody) && opts.campaignBudgetError) {
    return { error: { message: 'Invalid parameter', code: 100, error_subcode: 1487793 } };
  }
  // Campaign CLEANUP delete (failure path): the bridge deletes a campaign it CREATED this request
  // (or a bad empty reused campaign) when a step fails. opts.campaignDeleteError simulates Graph
  // rejecting that delete: `true` → the fresh campaign CAMP1, or a campaign id string → that id.
  if (method === 'POST' && /"status":"DELETED"/.test(reqBody) && opts.campaignDeleteError) {
    const badId = opts.campaignDeleteError === true ? 'CAMP1' : String(opts.campaignDeleteError);
    if (new RegExp(`/${badId}\\?`).test(u)) {
      return { error: { message: 'Cannot delete campaign with active children', code: 100 } };
    }
  }
  // Adset ACTIVATION POST (daily-campaign path): { name, status:'ACTIVE', end_time } — the
  // live-proven shape. opts.adsetActivateError simulates a Graph error on activation.
  if (method === 'POST' && /\/ADSET1\?/.test(u) && /"status":"ACTIVE"/.test(reqBody) && opts.adsetActivateError) {
    return { error: { message: 'Invalid parameter', code: 100, error_subcode: 1487793 } };
  }
  // Adset CUSTOMER-LIFECYCLE re-apply POST (existing_customer_budget_percentage). Mirrors the
  // template's customer-lifecycle strategy onto the copied adset. opts.adsetLifecycleError simulates
  // Graph rejecting it (the bridge must fail SOFT and still create/activate the ad).
  if (method === 'POST' && /\/ADSET1\?/.test(u) && /existing_customer_budget_percentage/.test(reqBody)) {
    return opts.adsetLifecycleError ? { error: { message: 'Cannot apply lifecycle strategy', code: 100 } } : { success: true };
  }
  // Copied adset start_time readback (daily-campaign path): the bridge computes end_time as this
  // start_time + 24h. Default simulates Meta assigning a start_time LATER than the bridge's local
  // `now`. opts.copiedAdsetStartTimeMissing → no start_time (bridge falls back to now + buffer).
  if (method === 'GET' && /fields=start_time&/.test(u)) {
    return opts.copiedAdsetStartTimeMissing ? {} : { start_time: opts.copiedAdsetStartTime || '2026-06-15T21:39:39+0700' };
  }
  // Reused-campaign emptiness probe (bad-reused-campaign recovery): list non-DELETED adsets on the
  // reused daily campaign. Must precede the adset readback route below (both carry effective_status).
  // opts.reusedCampaignAdsets → simulate the reused campaign already having adsets (recovery must NOT
  // delete it); default [] → empty (recovery deletes + recreates).
  if (method === 'GET' && /\/adsets\?fields=id,status,effective_status/.test(u)) {
    return { data: opts.reusedCampaignAdsets || [] };
  }
  // Adset status readback (daily-campaign path): the bridge requires status === 'ACTIVE' AND an
  // end_time. opts.adsetReadbackPaused → stayed PAUSED; opts.adsetReadbackNoEndTime → ACTIVE but
  // the schedule did not stick (no end_time).
  if (method === 'GET' && /effective_status/.test(u)) {
    if (opts.adsetReadbackPaused) return { status: 'PAUSED', effective_status: 'PAUSED', name: 'Adset copy' };
    const base = { status: 'ACTIVE', effective_status: 'ACTIVE', name: 'Adset active', daily_budget: '10000' };
    return opts.adsetReadbackNoEndTime ? base : { ...base, start_time: '2026-06-15T21:04:36+0700', end_time: '2026-06-16T21:04:36+0700' };
  }
  // PAGE-PUBLISH POST (is_published:true on the story id, via the PAGE token). opts.publishError
  // simulates a Graph error on the publish — default the transient code 1 / "please reduce the
  // amount of data" shape that USED to be trusted as success. opts.publishFailTimes makes only the
  // FIRST N publish POSTs error (then a retry succeeds), exercising the bounded-retry recovery; a
  // shared opts._publishState counter survives the per-request routeOpts shallow-copy.
  if (method === 'POST' && /is_published/.test(reqBody)) {
    if (opts.publishError || opts.publishFailTimes != null) {
      const st = opts._publishState || { count: 0 };
      st.count += 1;
      const failTimes = opts.publishFailTimes != null ? opts.publishFailTimes : Infinity;
      if (st.count <= failTimes) {
        return { error: { message: opts.publishErrorMessage || 'please reduce the amount of data', code: opts.publishErrorCode != null ? opts.publishErrorCode : 1 } };
      }
    }
    return { success: true };
  }
  // is_published READBACK (token-free confirm that an errored publish actually landed on the feed).
  // opts.publishReadbackPublished === true → confirmed published; otherwise NOT published.
  if (method === 'GET' && /fields=is_published\b/.test(u)) {
    return {
      is_published: opts.publishReadbackPublished === true,
      ...(opts.publishReadbackPermalink ? { permalink_url: opts.publishReadbackPermalink } : {})
    };
  }
  // repair-ad-cta: read the OLD paid creative's object_story_spec (backfill video/image/message +
  // the placeholder link the live bug left). Keyed on the creative id the test supplies (OLDCR).
  if (method === 'GET' && /\/OLDCR\?fields=object_story_spec/.test(u)) {
    return { object_story_spec: { page_id: LIVE_PAGE_ID, video_data: { video_id: 'EXISTINGVID', image_url: 'https://thumb/old.jpg', message: 'cap', call_to_action: { type: 'SHOP_NOW', value: { link: 'https://s.shopee.co.th/PLACEHOLDER----' } } } } };
  }
  // repair-ad-cta: ad creative READBACK after the ad is re-pointed at the new creative. Echoes the
  // link baked into the most recently created adcreative (captured below) so paid_ad_cta_final is a
  // real confirmation; opts.repairReadbackCtaLink/CreativeId override it to exercise a failed confirm.
  if (method === 'GET' && /\/AD1\?fields=creative/.test(u)) {
    const link = opts.repairReadbackCtaLink !== undefined ? opts.repairReadbackCtaLink : ((opts._repairState && opts._repairState.lastCreativeLink) || '');
    const cid = opts.repairReadbackCreativeId !== undefined ? opts.repairReadbackCreativeId : 'CR1';
    return { creative: { id: cid, ...(link ? { object_story_spec: { video_data: { call_to_action: { type: 'SHOP_NOW', value: { link } } } } } : {}) } };
  }
  if (u.includes('/me/accounts')) return { data: pages };
  // Source-post attachment lookup: the freshly posted page video's attachment target id.
  // attachmentVideoId === '' simulates a post with no resolvable video (empty target id).
  // CTA read-back on the visible post (GET …?fields=call_to_action…). Returns the link the post
  // currently carries. opts.readbackCtaLink simulates the verified visible CTA after an update;
  // opts.readbackCtaLink === null simulates a POST that "succeeded" but left the visible CTA
  // unchanged (the live failure mode the read-back guards against).
  if (/fields=call_to_action,permalink_url/.test(u) && method === 'GET') {
    const vid = opts.attachmentVideoId === undefined ? '2061700814696950' : opts.attachmentVideoId;
    const target = vid ? { id: vid, url: `https://www.facebook.com/reel/${vid}/` } : {};
    const link = opts.readbackCtaLink;
    const cta = link ? { type: 'SHOP_NOW', value: { link, link_format: 'VIDEO_LPP' } } : undefined;
    return {
      ...(cta ? { call_to_action: cta } : {}),
      permalink_url: 'https://www.facebook.com/reel/2061700814696950/',
      attachments: { data: [{ media_type: 'video', target }] }
    };
  }
  if (/fields=attachments/.test(u) && method === 'GET') {
    const vid = opts.attachmentVideoId === undefined ? 'RESOLVEDVID' : opts.attachmentVideoId;
    const target = vid ? { id: vid, url: `https://www.facebook.com/watch/?v=${vid}` } : {};
    return { attachments: { data: [{ media_type: 'video', target }] } };
  }
  if (new RegExp(`/${LIVE_PAGE_ID}/videos\\?`).test(u) && method === 'POST') {
    return { id: 'PAGEVID1', post_id: `${LIVE_PAGE_ID}_NEWPOST1` };
  }
  if (/\/PAGEVID1\?fields=post_id,permalink_url,thumbnails/.test(u) && method === 'GET') {
    return {
      post_id: `${LIVE_PAGE_ID}_NEWPOST1`,
      permalink_url: `https://www.facebook.com/${LIVE_PAGE_ID}/posts/NEWPOST1`,
      thumbnails: { data: [{ uri: 'https://thumb/page.jpg' }] }
    };
  }
  if (/\/advideos\?/.test(u) && method === 'POST') return { id: 'VID123' };
  if (/fields=thumbnails/.test(u)) return { thumbnails: { data: [{ id: 't1', uri: 'https://thumb/x.jpg' }] } };
  if (/\/adcreatives/.test(u) && method === 'POST') {
    if (opts.creativeErrorWithInstagram && /instagram_(actor|user)_id/.test(String(reqBody || ''))) {
      return { error: { message: 'Invalid parameter', code: 100, error_subcode: 3858258, fbtrace_id: 'TRACE_IG' } };
    }
    if (opts.creativeErrorWithLinkFormat && /"link_format":"VIDEO_LPP"/.test(String(reqBody || ''))) {
      return { error: { message: 'Invalid parameter', code: 100, error_subcode: 3858258, fbtrace_id: 'TRACE_LF' } };
    }
    if (opts.creativeErrorWithCta && /"call_to_action"/.test(String(reqBody || ''))) {
      return { error: { message: 'Invalid parameter', code: 100, error_subcode: 3858258, fbtrace_id: 'TRACE_CTA' } };
    }
    if (opts.creativeErrorWithImage && /"image_url"/.test(String(reqBody || ''))) {
      return { error: { message: 'Invalid parameter', code: 100, error_subcode: 3858258, fbtrace_id: 'TRACE_IMG' } };
    }
    // Capture the CTA link baked into the created creative so the repair-ad-cta readback echoes it.
    if (opts._repairState) {
      try {
        const spec = JSON.parse(reqBody || '{}').object_story_spec;
        const link = spec && spec.video_data && spec.video_data.call_to_action && spec.video_data.call_to_action.value && spec.video_data.call_to_action.value.link;
        if (link) opts._repairState.lastCreativeLink = String(link);
      } catch {}
    }
    return { id: 'CR1' };
  }
  if (/fields=effective_object_story_id/.test(u) && method === 'GET') return { effective_object_story_id: `${LIVE_PAGE_ID}_STORY9` };
  if (/\/ads\?fields=creative/.test(u)) return { data: [{ creative: { id: 'TPLCR' } }] };
  if (/TPLCR\?fields=call_to_action_type/.test(u)) return {
    call_to_action_type: opts.ctaType || 'SHOP_NOW',
    ...(opts.templateInstagramActorId ? { instagram_actor_id: opts.templateInstagramActorId } : {}),
    ...(opts.templateInstagramUserId ? { object_story_spec: { instagram_user_id: opts.templateInstagramUserId } } : {})
  };
  // Template settings read (objective + campaign-level mirror fields + adset-level customer-
  // lifecycle fields) in ONE GET on the template adset. opts.* inject template values so the
  // mirror/re-apply behavior can be exercised; absent → only objective is returned (default).
  if (/fields=existing_customer_budget_percentage/.test(u) && method === 'GET') {
    return {
      ...(opts.templateExistingCustomerPct !== undefined ? { existing_customer_budget_percentage: opts.templateExistingCustomerPct } : {}),
      ...(opts.templateTargetingOptTypes !== undefined ? { targeting_optimization_types: opts.templateTargetingOptTypes } : {}),
      campaign: {
        id: opts.templateCampaignId || 'TPLCAMP1',
        objective: opts.templateObjective || 'OUTCOME_ENGAGEMENT',
        ...(opts.templateSmartPromotionType !== undefined ? { smart_promotion_type: opts.templateSmartPromotionType } : {})
      }
    };
  }
  if (/campaign\{objective\}/.test(u)) return { campaign: { objective: 'OUTCOME_ENGAGEMENT' } };
  // Campaign name search (daily-campaign reuse + legacy prefix lookup). opts.existingCampaigns
  // simulates campaigns already on the ad account so exact-name reuse can be exercised.
  if (/\/campaigns\?.*filtering/.test(u) && method === 'GET') return { data: opts.existingCampaigns || [] };
  if (/\/campaigns\?/.test(u) && method === 'POST') return { id: 'CAMP1' };
  // Adset COPY (template adset → campaign). opts.copyError simulates Graph rejecting EVERY copy.
  // opts.copyErrorForCampaign simulates a bad/orphan REUSED daily campaign: the copy errors only
  // when targeting that campaign id (live: code=100 subcode=1885272), and succeeds elsewhere (e.g.
  // the fresh duplicate the recovery creates).
  if (/\/copies/.test(u) && method === 'POST') {
    if (opts.copyError) return { error: { message: 'Invalid parameter', code: 100, error_subcode: 1885272 } };
    if (opts.copyErrorForCampaign) {
      let cid = '';
      try { cid = JSON.parse(reqBody || '{}').campaign_id || ''; } catch {}
      if (String(cid) === String(opts.copyErrorForCampaign)) {
        return { error: { message: 'Invalid parameter', code: 100, error_subcode: 1885272 } };
      }
    }
    return { copied_adset_id: 'ADSET1' };
  }
  if (/\/ads\?fields=id/.test(u) && method === 'GET') return { data: [{ id: 'AD1' }] };
  if (/\/ads\?/.test(u) && method === 'POST') return { id: 'AD1' };
  // edit-page-comment-link: READ comments on a target (GET /{target}/comments?fields=id,message,from…).
  // opts.commentsByTarget maps a target id → array of comment objects; a target absent from the map
  // (or no map) returns an empty list so the helper falls through to the next read candidate.
  if (method === 'GET' && /\/comments\?fields=id,message,from/.test(u)) {
    const map = opts.commentsByTarget || {};
    let list = [];
    for (const key of Object.keys(map)) {
      if (u.includes(`/${encodeURIComponent(key)}/comments`)) { list = map[key]; break; }
    }
    return { data: list };
  }
  // edit-page-comment-link: the EDIT itself — official Graph edit POST /{comment_id} { message }. The
  // URL ends with the comment id (no query). Records the edited message so the readback echoes it.
  if (method === 'POST' && /\/COMMENT[^/?]*$/.test(u) && /"message"/.test(reqBody)) {
    if (opts._editState) { try { opts._editState.editedMessage = JSON.parse(reqBody || '{}').message; } catch {} }
    if (opts.commentEditError) return { error: { message: 'Edit failed', code: 100 } };
    return { id: opts.editCommentId || 'COMMENTOLD', success: true };
  }
  // edit-page-comment-link: direct READBACK of the same comment id (GET /{comment_id}?fields=id,
  // message,from,permalink_url). Echoes the edited message + a from.id (default the live page).
  if (method === 'GET' && /\/COMMENT[^/?]*\?fields=id,message,from,permalink_url/.test(u)) {
    const edited = (opts._editState && opts._editState.editedMessage) || '';
    const fromId = opts.readbackFromId !== undefined ? opts.readbackFromId : LIVE_PAGE_ID;
    return {
      id: opts.editCommentId || 'COMMENTOLD',
      message: edited,
      from: { id: fromId, name: 'Page' },
      permalink_url: 'https://www.facebook.com/comment/COMMENTOLD'
    };
  }
  if (/\/comments/.test(u) && method === 'POST') return { id: 'COMMENT1' };
  return { success: true };
}

// Mock CloakBrowser.
//   - Graph traffic preferentially goes through context.request.fetch (Playwright
//     APIRequestContext — cookie-sharing, no page CORS). Recorded in `apiCalls`.
//   - page.evaluate has TWO modes: token extraction (no { url }) and a Graph FALLBACK
//     (with { url } — recorded in `evalGraphCalls`) used only when context.request is absent.
// Pass opts.noApiRequest to omit context.request and force the page.evaluate fallback.
function makeBrowser(opts = {}) {
  const calls = [];
  const apiCalls = [];
  const evalGraphCalls = [];
  let closes = 0;
  const pages = opts.pages || [{ id: LIVE_PAGE_ID, name: 'คอนเทนต์ป้ายยา', category: 'Shop', access_token: PAGE_TOKEN_SECRET }];
  const tokenInUrl = opts.oauthToken !== false && opts.url === undefined;
  let url = opts.url || (tokenInUrl
    ? `https://postcron.com/auth/login/facebook/callback#access_token=${USER_TOKEN_SECRET}`
    : 'https://www.facebook.com/dialog/oauth/error?error=invalid_app_id');
  const tokenExtract = opts.evalToken || { token: USER_TOKEN_SECRET, fbDtsgPresent: true, userId: '4242' };
  const routeOpts = {
    ctaType: opts.ctaType, attachmentVideoId: opts.attachmentVideoId, readbackCtaLink: opts.readbackCtaLink,
    existingCampaigns: opts.existingCampaigns, campaignBudgetError: opts.campaignBudgetError, adsetActivateError: opts.adsetActivateError,
    adsetReadbackPaused: opts.adsetReadbackPaused, adsetReadbackNoEndTime: opts.adsetReadbackNoEndTime,
    copiedAdsetStartTime: opts.copiedAdsetStartTime, copiedAdsetStartTimeMissing: opts.copiedAdsetStartTimeMissing,
    templateObjective: opts.templateObjective, templateCampaignId: opts.templateCampaignId,
    templateSmartPromotionType: opts.templateSmartPromotionType, templateExistingCustomerPct: opts.templateExistingCustomerPct,
    templateTargetingOptTypes: opts.templateTargetingOptTypes, adsetLifecycleError: opts.adsetLifecycleError,
    campaignDeleteError: opts.campaignDeleteError, copyError: opts.copyError,
    copyErrorForCampaign: opts.copyErrorForCampaign, reusedCampaignAdsets: opts.reusedCampaignAdsets,
    creativeErrorWithInstagram: opts.creativeErrorWithInstagram,
    creativeErrorWithLinkFormat: opts.creativeErrorWithLinkFormat,
    creativeErrorWithCta: opts.creativeErrorWithCta,
    creativeErrorWithImage: opts.creativeErrorWithImage,
    templateInstagramActorId: opts.templateInstagramActorId,
    templateInstagramUserId: opts.templateInstagramUserId,
    publishError: opts.publishError, publishErrorCode: opts.publishErrorCode,
    publishErrorMessage: opts.publishErrorMessage, publishReadbackPublished: opts.publishReadbackPublished,
    publishFailTimes: opts.publishFailTimes, publishReadbackPermalink: opts.publishReadbackPermalink,
    repairReadbackCtaLink: opts.repairReadbackCtaLink, repairReadbackCreativeId: opts.repairReadbackCreativeId,
    // edit-page-comment-link routing: which comments each target exposes + edit/readback overrides.
    commentsByTarget: opts.commentsByTarget, commentEditError: opts.commentEditError,
    editCommentId: opts.editCommentId, readbackFromId: opts.readbackFromId,
    // Shared mutable counter so publishFailTimes survives the per-request `{ ...routeOpts }` copy.
    _publishState: { count: 0 },
    // Shared mutable state so the edit-page-comment-link readback echoes the just-edited message.
    _editState: { editedMessage: '' },
    // Shared mutable state so the repair-ad-cta readback can echo the link of the creative just
    // created (survives the per-request `{ ...routeOpts }` shallow copy, like _publishState).
    _repairState: { lastCreativeLink: '' }
  };

  const apiRequest = opts.noApiRequest ? undefined : {
    // Playwright APIResponse-like: status()/ok()/text() are methods.
    fetch: async (reqUrl, init = {}) => {
      const method = (init.method || 'GET').toUpperCase();
      const reqBody = init.data != null ? String(init.data) : (init.body != null ? String(init.body) : '');
      calls.push({ url: String(reqUrl), method, body: reqBody });
      apiCalls.push({ url: String(reqUrl), method, body: reqBody });
      const obj = graphRoute(reqUrl, method, pages, { ...routeOpts, body: reqBody });
      const text = JSON.stringify(obj);
      return { status: () => 200, ok: () => true, text: async () => text, json: async () => obj };
    }
  };

  const browser = {
    PROFILE_ROOT: '/tmp/profiles',
    loadBrowserBackend: async () => ({ backend: 'mock-browser' }),
    openPage: async () => ({
      backend: 'mock-browser',
      profileDir: '/tmp/profiles/content_paiya',
      page: {
        url: () => url,
        textContent: async () => '',
        goto: async (to) => { url = String(to); },
        evaluate: async (fn, arg) => {
          if (arg && arg.url) {
            const method = (arg.method || 'GET').toUpperCase();
            const reqBody = arg.body != null ? String(arg.body) : '';
            calls.push({ url: String(arg.url), method, body: reqBody });
            evalGraphCalls.push({ url: String(arg.url), method, body: reqBody });
            return { status: 200, ok: true, text: JSON.stringify(graphRoute(arg.url, method, pages, { ...routeOpts, body: reqBody })) };
          }
          if (opts.onTokenEval) opts.onTokenEval();
          return tokenExtract;
        }
      },
      context: {
        cookies: async () => (opts.loggedIn === false ? [] : [{ name: 'c_user', value: '4242' }]),
        close: async () => { closes += 1; },
        ...(apiRequest ? { request: apiRequest } : {})
      }
    })
  };
  browser.calls = calls;
  browser.apiCalls = apiCalls;
  browser.evalGraphCalls = evalGraphCalls;
  browser.closeCount = () => closes;
  return browser;
}

const NOT_LOGGED_IN = { url: 'https://www.facebook.com/login', evalToken: { token: null, fbDtsgPresent: false, userId: null }, loggedIn: false };

let server;
let lastBrowser;
let lastNodeFetch;

function listen(opts = {}) {
  lastBrowser = opts.browser || makeBrowser();
  // Node fetch must NOT be used for Graph (cookies required) — default to a spy that records
  // any (unexpected) call so regressions can assert Graph never goes through Node fetch.
  lastNodeFetch = opts.nodeFetch || (() => { lastNodeFetch.called = true; return Promise.resolve({ ok: false, status: 400, json: async () => ({ error: { code: 1, message: 'Invalid request' } }) }); });
  lastNodeFetch.called = false;
  server = createServer({ browser: lastBrowser, fetch: lastNodeFetch, downloadVideo: opts.downloadVideo });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const r = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path,
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
});

test('GET /token returns booleans only (no raw token), accessToken=true when session has a token', async () => {
  await listen();
  const r = await req('GET', '/token');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.accessToken, true);
  assert.equal(r.body.fbDtsg, true);
  assert.equal(typeof r.body.accessToken, 'boolean');
  assertNoLeak(r.body);
});

test('GET /token reports accessToken=false when the profile is not logged in', async () => {
  await listen({ browser: makeBrowser(NOT_LOGGED_IN) });
  const r = await req('GET', '/token');
  assert.equal(r.body.ok, true);
  assert.equal(r.body.accessToken, false);
});

test('GET /token falls back to the Ads Manager in-page extractor when OAuth has no token', async () => {
  await listen({ browser: makeBrowser({ oauthToken: false }) });
  const r = await req('GET', '/token');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.accessToken, true, 'token resolved via window.__accessToken fallback');
  assert.equal(r.body.fbDtsg, true, 'fbDtsg presence from in-page extraction');
  assertNoLeak(r.body);
});

test('GET /pages works via the Ads Manager fallback token (no token leak)', async () => {
  await listen({ browser: makeBrowser({ oauthToken: false }) });
  const r = await req('GET', '/pages');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.map((p) => String(p.id)).includes(LIVE_PAGE_ID));
  assertNoLeak(r.body);
});

test('Ads Manager fallback is skipped when OAuth already yields a token', async () => {
  let evaluated = false;
  await listen({ browser: makeBrowser({ onTokenEval: () => { evaluated = true; } }) });
  const r = await req('GET', '/token');
  assert.equal(r.body.accessToken, true);
  assert.equal(evaluated, false, 'token-extract evaluate must not run when OAuth token exists');
});

test('GET /pages returns id/name only (no page access tokens) and includes the live page', async () => {
  await listen();
  const r = await req('GET', '/pages');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
  const ids = r.body.data.map((p) => String(p.id));
  assert.ok(ids.includes(LIVE_PAGE_ID), 'must include page 107267395614980 when logged in');
  for (const p of r.body.data) {
    assert.equal(p.access_token, undefined, 'must not return page access_token');
    assert.equal(p.hasToken, true, 'hasToken flag present without the token value');
  }
  assertNoLeak(r.body);
});

test('Graph runs through the logged-in browser page (credentials include), NOT Node fetch', async () => {
  // Node fetch with the AdsManager token returns OAuthException code=1 live — so it must never
  // be used. Pass a Node fetch that always errors; the browser-context Graph still succeeds.
  await listen({ browser: makeBrowser({ oauthToken: false }) });
  const r = await req('GET', '/pages');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.map((p) => String(p.id)).includes(LIVE_PAGE_ID), 'page resolved via in-page fetch');
  assert.equal(lastNodeFetch.called, false, 'Graph must NOT go through Node fetch');
  assert.ok(lastBrowser.calls.some((c) => /\/me\/accounts/.test(c.url)), 'me/accounts fetched in-page');
});

test('Graph uses context.request.fetch (APIRequestContext) when present, NOT page.evaluate', async () => {
  const browser = makeBrowser();
  await listen({ browser });
  const r = await req('GET', '/pages');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.map((p) => String(p.id)).includes(LIVE_PAGE_ID));
  assert.ok(browser.apiCalls.some((c) => /\/me\/accounts/.test(c.url)), 'me/accounts went through context.request.fetch');
  assert.equal(browser.evalGraphCalls.length, 0, 'page.evaluate must NOT be used for Graph when context.request exists');
});

test('Graph falls back to page.evaluate(fetch) when context.request is unavailable', async () => {
  const browser = makeBrowser({ noApiRequest: true });
  await listen({ browser });
  const r = await req('GET', '/pages');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.map((p) => String(p.id)).includes(LIVE_PAGE_ID), 'page resolved via in-page fetch fallback');
  assert.equal(browser.apiCalls.length, 0, 'no APIRequestContext available');
  assert.ok(browser.evalGraphCalls.some((c) => /\/me\/accounts/.test(c.url)), 'fell back to page.evaluate for Graph');
});

test('POST /page-comment succeeds via context.request.fetch (the CORS-failing path is avoided)', async () => {
  const browser = makeBrowser();
  await listen({ browser });
  const r = await req('POST', '/page-comment', {
    page_id: LIVE_PAGE_ID,
    story_id: `${LIVE_PAGE_ID}_STORY9`,
    message: 'comment via api request'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.author_expected, 'page');
  assert.ok(browser.apiCalls.some((c) => /\/comments/.test(c.url) && c.method === 'POST'), 'comment POSTed via context.request.fetch');
  assert.equal(browser.evalGraphCalls.length, 0, 'no page.evaluate Graph for the comment');
  assertNoLeak(r.body);
});

test('browser context is closed after the request completes (no context leak)', async () => {
  const browser = makeBrowser();
  await listen({ browser });
  await req('GET', '/pages');
  assert.equal(browser.closeCount(), 1, 'context.close() called once after the request');
});

test('POST /post publishes an organic page video and returns story/post fields, no token leak', async () => {
  await listen();
  const r = await req('POST', '/post', {
    page_id: LIVE_PAGE_ID,
    video_url: 'https://cdn/example.mp4',
    message: 'hello',
    website_url: 'https://s.shopee/x',
    cta: 'SHOP_NOW'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.story_id, `${LIVE_PAGE_ID}_STORY9`);
  assert.equal(r.body.video_id, 'VID123');
  assert.ok(String(r.body.post_url).includes(LIVE_PAGE_ID));
  assertNoLeak(r.body);
});

test('POST /post fails closed (validate) when page_id/video_url missing', async () => {
  await listen();
  const r = await req('POST', '/post', { page_id: LIVE_PAGE_ID });
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.step, 'validate');
});

test('POST /page-comment comments AS THE PAGE and returns author_expected=page, no token leak', async () => {
  await listen();
  const r = await req('POST', '/page-comment', {
    page_id: LIVE_PAGE_ID,
    story_id: `${LIVE_PAGE_ID}_STORY9`,
    message: 'นี่คอมเมนต์'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.author_expected, 'page');
  assert.ok(r.body.id);
  assertNoLeak(r.body);
});

test('POST /page-comment FAILS CLOSED when the session does not administer the page (never comments as user)', async () => {
  const browser = makeBrowser({ pages: [{ id: '999', name: 'Other', access_token: 'OTHER' }] });
  await listen({ browser });
  const r = await req('POST', '/page-comment', {
    page_id: LIVE_PAGE_ID,
    story_id: `${LIVE_PAGE_ID}_STORY9`,
    message: 'should not post'
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.error, 'page_token_not_found');
  // Hard guarantee: no comment was ever POSTed to Graph /comments.
  assert.ok(!browser.calls.some((c) => /\/comments/.test(c.url)), 'must not call /comments when page token is missing');
});

test('POST /page-comment fail-closed (no_session) when the profile is not logged in', async () => {
  await listen({ browser: makeBrowser(NOT_LOGGED_IN) });
  const r = await req('POST', '/page-comment', { page_id: LIVE_PAGE_ID, story_id: 'x_y', message: 'hi' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'no_session');
});

// ---------------------------------------------------------------------------
// POST /edit-page-comment-link — EDIT (never create) the Shopee link inside an EXISTING Page-owned
// comment. Discovery order is strict (full story first, alternate_targets only on no match); the
// matched comment must be authored by the page; allow_create_new is never honored; nothing is ever
// created or deleted.
// ---------------------------------------------------------------------------
const ECL_STORY = `${LIVE_PAGE_ID}_768749526323172`;
const ECL_OLD = 'https://s.shopee.co.th/5q5l46qSw4';
const ECL_NEW = 'https://s.shopee.co.th/8pjWjs1coO';
const eclComment = (overrides = {}) => ({
  id: 'COMMENTOLD',
  from: { id: LIVE_PAGE_ID, name: 'คอนเทนต์ป้ายยา' },
  message: `📌 พิกัดอยู่ตรงนี้เลย 👇\n🧡 Shopee : ${ECL_OLD}`,
  created_time: '2026-06-18T10:00:00+0700',
  permalink_url: 'https://www.facebook.com/comment/COMMENTOLD',
  ...overrides
});

test('POST /edit-page-comment-link finds the Page comment ON THE STORY and edits the SAME comment, verifies readback, never creates', async () => {
  const browser = makeBrowser({ commentsByTarget: { [ECL_STORY]: [eclComment()] } });
  await listen({ browser });
  const r = await req('POST', '/edit-page-comment-link', {
    page_id: LIVE_PAGE_ID,
    story_id: ECL_STORY,
    alternate_targets: ['1664564174693233', '768749526323172'],
    old_link: ECL_OLD,
    new_link: ECL_NEW,
    allow_create_new: false
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.phase, 'edit_page_comment_link');
  assert.equal(r.body.comment_id, 'COMMENTOLD');
  assert.equal(r.body.target_used, ECL_STORY, 'edited the comment found on the full story target');
  assert.equal(r.body.old_link_gone, true);
  assert.equal(r.body.new_link_present, true);
  assert.equal(r.body.author_page_verified, true);
  assert.ok(r.body.final_message_first_line.includes('พิกัด'), 'returns first line only');
  // The edit POST targets the SAME comment id (no query) and carries the replaced message.
  const editPost = browser.calls.find((c) => /\/COMMENTOLD$/.test(c.url) && c.method === 'POST');
  assert.ok(editPost, 'an edit POST to /{comment_id} was issued');
  const sent = JSON.parse(editPost.body);
  assert.ok(sent.message.includes(ECL_NEW) && !sent.message.includes(ECL_OLD), 'edited message swaps old→new link');
  // HARD GUARANTEE: never POST to /{target}/comments (that would CREATE a duplicate).
  assert.ok(!browser.calls.some((c) => /\/comments(\?|$)/.test(c.url) && c.method === 'POST'), 'must NOT create a comment');
  assertNoLeak(r.body);
});

test('POST /edit-page-comment-link falls back to an alternate READ target ONLY after the story has no match', async () => {
  const ALT = '1664564174693233';
  const browser = makeBrowser({ commentsByTarget: { [ALT]: [eclComment()] } }); // story target → empty
  await listen({ browser });
  const r = await req('POST', '/edit-page-comment-link', {
    page_id: LIVE_PAGE_ID,
    story_id: ECL_STORY,
    alternate_targets: [ALT, '768749526323172'],
    old_link: ECL_OLD,
    new_link: ECL_NEW,
    allow_create_new: false
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.target_used, ALT, 'used the alternate read target after the story had no match');
  // Order: the FULL story comments are read BEFORE any alternate target.
  const storyReadIdx = browser.calls.findIndex((c) => c.method === 'GET' && c.url.includes(`/${ECL_STORY}/comments`));
  const altReadIdx = browser.calls.findIndex((c) => c.method === 'GET' && c.url.includes(`/${ALT}/comments`));
  assert.ok(storyReadIdx >= 0 && altReadIdx >= 0, 'both targets were read');
  assert.ok(storyReadIdx < altReadIdx, 'the full story is read before the alternate target');
  assert.ok(!browser.calls.some((c) => /\/comments(\?|$)/.test(c.url) && c.method === 'POST'), 'must NOT create a comment');
  assertNoLeak(r.body);
});

test('POST /edit-page-comment-link rejects missing new_link and rejects allow_create_new:true WITHOUT creating/editing', async () => {
  // (a) missing new_link → validate.
  let browser = makeBrowser({ commentsByTarget: { [ECL_STORY]: [eclComment()] } });
  await listen({ browser });
  let r = await req('POST', '/edit-page-comment-link', { page_id: LIVE_PAGE_ID, story_id: ECL_STORY, old_link: ECL_OLD });
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.step, 'validate');
  assert.ok(!browser.calls.some((c) => c.method === 'POST'), 'no Graph write on validation failure');
  await new Promise((resolve) => server.close(resolve));
  server = null;

  // (b) allow_create_new:true → never supported here; must not create or edit anything.
  browser = makeBrowser({ commentsByTarget: { [ECL_STORY]: [eclComment()] } });
  await listen({ browser });
  r = await req('POST', '/edit-page-comment-link', {
    page_id: LIVE_PAGE_ID, story_id: ECL_STORY, old_link: ECL_OLD, new_link: ECL_NEW, allow_create_new: true
  });
  assert.equal(r.body.ok, false);
  assert.equal(r.body.error, 'create_new_not_supported');
  assert.ok(!browser.calls.some((c) => /\/comments(\?|$)/.test(c.url) && c.method === 'POST'), 'must NOT create a comment');
  assert.ok(!browser.calls.some((c) => /\/COMMENTOLD$/.test(c.url) && c.method === 'POST'), 'must NOT edit a comment');
  assertNoLeak(r.body);
});

test('POST /edit-page-comment-link is non-ok and edits NOTHING when the matching comment is not authored by the page', async () => {
  // The only comment carrying the old link is authored by a USER (from.id != page_id).
  const browser = makeBrowser({
    commentsByTarget: { [ECL_STORY]: [eclComment({ id: 'USERCOMMENT', from: { id: '999', name: 'Someone' } })] }
  });
  await listen({ browser });
  const r = await req('POST', '/edit-page-comment-link', {
    page_id: LIVE_PAGE_ID, story_id: ECL_STORY, old_link: ECL_OLD, new_link: ECL_NEW, allow_create_new: false
  });
  assert.equal(r.body.ok, false);
  assert.equal(r.body.error, 'matching_comment_not_found', 'a non-page-authored comment is never matched/edited');
  assert.ok(!browser.calls.some((c) => c.method === 'POST'), 'no edit/create POST when no page-owned comment matches');
  assertNoLeak(r.body);
});

test('POST /edit-page-comment-link response never leaks USER_TOKEN_SECRET or PAGE_TOKEN_SECRET', async () => {
  const browser = makeBrowser({ commentsByTarget: { [ECL_STORY]: [eclComment()] } });
  await listen({ browser });
  const r = await req('POST', '/edit-page-comment-link', {
    page_id: LIVE_PAGE_ID, story_id: ECL_STORY, old_link: ECL_OLD, new_link: ECL_NEW, allow_create_new: false
  });
  assert.equal(r.body.ok, true);
  assertNoLeak(r.body);
});

test('POST /create-ad runs the OneCard/ads orchestration and returns ids, no token leak', async () => {
  await listen();
  const r = await req('POST', '/create-ad', {
    page_id: LIVE_PAGE_ID,
    video_url: 'https://cdn/example.mp4',
    caption: 'cap',
    shortlink: 'https://s.wwoom/x',
    shopee_url: 'https://shopee.co.th/x',
    ad_account: 'act_test',
    template_adset: 'tpl_test'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.story_id, `${LIVE_PAGE_ID}_STORY9`);
  assert.equal(r.body.ad_id, 'AD1');
  assert.equal(r.body.adset_id, 'ADSET1');
  assert.equal(r.body.published_to_page, true);
  assertNoLeak(r.body);
});

test('POST /create-ad with publish_as_page_video publishes a NEW Page video post and creates no ad', async () => {
  const browser = makeBrowser();
  await listen({
    browser,
    downloadVideo: async () => ({ buffer: Buffer.from('REALBYTES'), contentType: 'video/mp4' })
  });
  const r = await req('POST', '/create-ad', {
    page_id: LIVE_PAGE_ID,
    video_url: 'https://cdn/example.mp4',
    caption: 'new page story',
    ad_name: '1de9be59',
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    skip_ad: true,
    publish_as_page_video: true,
    skip_comment: true
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.phase, 'post');
  assert.equal(r.body.story_id, `${LIVE_PAGE_ID}_NEWPOST1`);
  assert.equal(r.body.video_id, 'PAGEVID1');
  assert.equal(r.body.published_to_page, true);
  assert.equal(r.body.upload_mode, 'page_video_multipart');
  assert.ok(String(r.body.post_url).includes('/posts/NEWPOST1'));
  const publishCall = browser.calls.find((c) => new RegExp(`/${LIVE_PAGE_ID}/videos\\?`).test(c.url) && c.method === 'POST');
  assert.ok(publishCall, 'publishes through /{page_id}/videos');
  assert.ok(!String(publishCall.body || '').includes('1de9be59'), 'internal video code must not be used as public card title');
  assert.ok(!browser.calls.some((c) => /\/adcreatives/.test(c.url)), 'Phase A must not create an adcreative');
  assert.ok(!browser.calls.some((c) => /\/ads\?/.test(c.url) && c.method === 'POST'), 'Phase A must not create an ad');
  assert.ok(!browser.calls.some((c) => /\/advideos/.test(c.url)), 'Phase A does not use ad-account advideos');
  assertNoLeak(r.body);
});

test('POST /create-ad fails closed (validate) when page_id/video missing', async () => {
  await listen();
  const r = await req('POST', '/create-ad', { caption: 'x' });
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.step, 'validate');
});

// PAUSED / ACTIVE contract — the ad-only flow must be able to create a NON-SPENDING ad. The default
// (no paused flag) MUST stay the legacy ACTIVE path; an explicit paused/status_option:'PAUSED'
// leaves the adset + ad PAUSED and never issues an activation POST.
test('POST /create-ad DEFAULT (no paused flag) ACTIVATES the adset + ad to ACTIVE (legacy behavior unchanged)', async () => {
  const browser = makeBrowser();
  await listen({ browser });
  const r = await req('POST', '/create-ad', {
    page_id: LIVE_PAGE_ID,
    video_id: 'EXISTINGVID',
    caption: 'cap',
    shortlink: 'https://s.shopee.co.th/x',
    shopee_url: 'https://shopee.co.th/x',
    ad_account: 'act_test',
    template_adset: 'tpl_test'
  });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.ad_id, 'AD1');
  assert.equal(r.body.adset_status, 'ACTIVE', 'default path reports adset ACTIVE');
  assert.equal(r.body.ad_status, 'ACTIVE', 'default path reports ad ACTIVE');
  assert.equal(r.body.paused, undefined, 'default response carries no paused flag');
  // The ad-activation POST { status:'ACTIVE' } on the ad id IS issued in the default path.
  assert.ok(
    browser.calls.some((c) => /\/AD1\?/.test(c.url) && c.method === 'POST' && /"status":"ACTIVE"/.test(String(c.body || ''))),
    'default path activates the ad to ACTIVE'
  );
  assert.ok(
    browser.calls.some((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /"status":"ACTIVE"/.test(String(c.body || ''))),
    'default path activates the adset to ACTIVE'
  );
  // A NEW campaign is created (prefix branch) — and on the default path it is created ACTIVE.
  const campCreate = browser.calls.find((c) => /\/campaigns\?/.test(c.url) && c.method === 'POST');
  assert.ok(campCreate, 'a new campaign was created');
  assert.ok(/"status":"ACTIVE"/.test(String(campCreate.body || '')), 'default path creates the campaign ACTIVE');
  assert.equal(r.body.campaign_status, 'ACTIVE', 'default reports campaign_status ACTIVE');
  assertNoLeak(r.body);
});

test('POST /create-ad with paused:true creates a PAUSED ad and NEVER issues an ACTIVE activation', async () => {
  const browser = makeBrowser();
  await listen({ browser });
  const r = await req('POST', '/create-ad', {
    page_id: LIVE_PAGE_ID,
    video_id: 'EXISTINGVID',
    caption: 'cap',
    shortlink: 'https://s.shopee.co.th/x',
    shopee_url: 'https://shopee.co.th/x',
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    skip_publish_to_page: true,
    paused: true
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.ad_id, 'AD1');
  assert.equal(r.body.adset_id, 'ADSET1');
  assert.equal(r.body.paused, true, 'response flags the paused ad-only mode');
  assert.equal(r.body.adset_status, 'PAUSED', 'adset is left PAUSED');
  assert.equal(r.body.ad_status, 'PAUSED', 'ad is left PAUSED');
  assert.equal(r.body.published_to_page, false, 'ad-only never publishes a page post');
  // The ad CREATE POST carries status:'PAUSED'.
  const adCreate = browser.calls.find((c) => /\/ads\?/.test(c.url) && c.method === 'POST');
  assert.ok(adCreate, 'an ad was created');
  assert.ok(/"status":"PAUSED"/.test(String(adCreate.body || '')), 'ad is created PAUSED');
  // HARD GUARANTEE: no activation POST on the adset or the ad, and no daily-budget POST.
  assert.ok(
    !browser.calls.some((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /"status":"ACTIVE"/.test(String(c.body || ''))),
    'paused path must NOT activate the adset'
  );
  assert.ok(
    !browser.calls.some((c) => /\/AD1\?/.test(c.url) && c.method === 'POST' && /"status":"ACTIVE"/.test(String(c.body || ''))),
    'paused path must NOT activate the ad'
  );
  assert.ok(
    !browser.calls.some((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /daily_budget/.test(String(c.body || ''))),
    'paused path applies no budget (non-spending)'
  );
  // The paused/review path NEVER comments (the affiliate-link comment is only for the active path).
  assert.ok(
    !browser.calls.some((c) => /\/comments/.test(c.url) && c.method === 'POST'),
    'paused path must NOT post a Page comment'
  );
  assert.equal(r.body.comment_status, undefined, 'paused result carries no comment_status');
  // A NEW campaign is created (prefix branch) and MUST be created PAUSED — never ACTIVE.
  const campCreate = browser.calls.find((c) => /\/campaigns\?/.test(c.url) && c.method === 'POST');
  assert.ok(campCreate, 'a new campaign was created');
  assert.ok(/"status":"PAUSED"/.test(String(campCreate.body || '')), 'paused path creates the new campaign PAUSED');
  assert.ok(!/"status":"ACTIVE"/.test(String(campCreate.body || '')), 'paused path must NOT create the campaign ACTIVE');
  assert.equal(r.body.campaign_status, 'PAUSED', 'reports campaign_status PAUSED for the newly-created campaign');
  assertNoLeak(r.body);
});

test('POST /create-ad with paused:true + new_campaign_name creates the NEW campaign PAUSED (never ACTIVE)', async () => {
  const browser = makeBrowser();
  await listen({ browser });
  const r = await req('POST', '/create-ad', {
    page_id: LIVE_PAGE_ID,
    video_id: 'EXISTINGVID',
    caption: 'cap',
    shortlink: 'https://s.shopee.co.th/x',
    shopee_url: 'https://shopee.co.th/x',
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    skip_publish_to_page: true,
    paused: true,
    new_campaign_name: 'AD ONLY TEST CAMPAIGN'
  });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.campaign_status, 'PAUSED');
  // The new_campaign_name branch POST must carry the campaign name AND status:'PAUSED'.
  const campCreate = browser.calls.find((c) => /\/campaigns\?/.test(c.url) && c.method === 'POST');
  assert.ok(campCreate, 'a new campaign was created via the new_campaign_name branch');
  assert.ok(/AD ONLY TEST CAMPAIGN/.test(String(campCreate.body || '')), 'new campaign carries the requested name');
  assert.ok(/"status":"PAUSED"/.test(String(campCreate.body || '')), 'new_campaign_name branch creates PAUSED under paused:true');
  assert.ok(!/"status":"ACTIVE"/.test(String(campCreate.body || '')), 'new_campaign_name branch must NOT create ACTIVE under paused:true');
  assertNoLeak(r.body);
});

// AD-ONLY SCHEDULED/ACTIVE path (Dashboard Create Ads): build a LIVE, SPENDING ad from an EXISTING
// video using the date-named daily-campaign path — per-adset budget + run-hours schedule +
// activation — while skip_publish_to_page guarantees NO Page publish. On the ACTIVE path the bridge
// drops exactly ONE Page comment carrying the Shopee link (the affiliate link still has to surface
// under the dark story). This is the exact shape the worker /api/dashboard/create-ad-only sends in
// 'active' mode (no paused flag).
test('POST /create-ad scheduled (daily_campaign_name + budget + skip_publish) ACTIVATES + schedules, never publishes, comments ONCE', async () => {
  const browser = makeBrowser();
  await listen({ browser });
  const r = await req('POST', '/create-ad', {
    page_id: LIVE_PAGE_ID,
    video_id: 'EXISTINGVID',
    caption: 'cap',
    shortlink: 'https://s.shopee.co.th/x',
    shopee_url: 'https://shopee.co.th/x',
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    skip_publish_to_page: true,
    daily_campaign_name: '18/Jun/2026',
    campaign_daily_budget: 1000000,
    adset_run_hours: 24
    // NO paused flag — this is the live/spending path.
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.ad_id, 'AD1');
  assert.equal(r.body.adset_id, 'ADSET1');
  assert.equal(r.body.adset_status, 'ACTIVE', 'scheduled path activates the adset');
  assert.equal(r.body.ad_status, 'ACTIVE', 'scheduled path activates the ad');
  assert.equal(r.body.paused, undefined, 'scheduled path carries no paused flag');
  assert.equal(r.body.campaign_name, '18/Jun/2026', 'uses the date-named daily campaign');
  assert.equal(r.body.campaign_budget, 1000000, 'reports the CAMPAIGN-level (CBO) daily budget');
  assert.ok(r.body.end_time, 'a run-window end_time is scheduled');
  // INVARIANT: never publishes a Page post, even on the active path.
  assert.equal(r.body.published_to_page, false, 'ad-only scheduled mode never publishes a page post');
  assert.ok(
    !browser.calls.some((c) => /is_published/.test(String(c.body || ''))),
    'no Page-publish POST (is_published) is ever issued'
  );
  // The active ad-only path drops EXACTLY ONE Page comment carrying the Shopee link, targeting the
  // FULL story id; the result surfaces the comment outcome for the Worker/history.
  const commentPosts = browser.calls.filter((c) => /\/comments/.test(c.url) && c.method === 'POST');
  assert.equal(commentPosts.length, 1, 'exactly one Page comment POST is issued on the active ad-only path');
  assert.ok(commentPosts[0].url.includes(`${LIVE_PAGE_ID}_STORY9/comments`), 'comment targets the FULL story id');
  assert.ok(String(commentPosts[0].body).includes('https://s.shopee.co.th/x'), 'comment carries the Shopee link');
  assert.equal(r.body.comment_status, 'commented', 'result reports the comment landed');
  assert.equal(r.body.comment_fb_id, 'COMMENT1', 'result carries the comment fb id');
  // The adset is activated under the date-named daily campaign with the TAIL-ONLY name (story tail),
  // never the full page_id_post_id.
  const adsetActivate = browser.calls.find((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /"status":"ACTIVE"/.test(String(c.body || '')));
  assert.ok(adsetActivate, 'the adset activation POST was issued');
  assert.equal(JSON.parse(adsetActivate.body).name, 'STORY9', 'adset activation name is the story tail only');
  // The daily campaign is created WITH the campaign-level (CBO) budget; the adset gets NO budget.
  const campPost = browser.calls.find((c) => /\/campaigns\?/.test(c.url) && c.method === 'POST');
  assert.equal(JSON.parse(campPost.body).daily_budget, '1000000', 'daily campaign carries the CBO budget');
  assert.equal(JSON.parse(campPost.body).bid_strategy, 'LOWEST_COST_WITHOUT_CAP', 'daily campaign uses LOWEST_COST CBO bid strategy');
  assert.ok(
    !browser.calls.some((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /daily_budget/.test(String(c.body || ''))),
    'active daily path must NOT set a per-adset daily_budget under a CBO campaign'
  );
  // The activation POST { status:'ACTIVE' } still runs (schedule lives on it).
  assert.ok(
    browser.calls.some((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /"status":"ACTIVE"/.test(String(c.body || ''))),
    'scheduled path activates the adset'
  );
  assertNoLeak(r.body);
});

// When the worker supplies an explicit rendered comment template (comment_message), the active
// ad-only path must comment with THAT template text — never a bare shortlink. This is the defensive
// guard so the bridge never forces a bare-link comment when the caller already rendered one.
test('POST /create-ad active ad-only honors an explicit comment_message over the bare shortlink', async () => {
  const browser = makeBrowser();
  await listen({ browser });
  const rendered = '📌 พิกัดอยู่ตรงนี้เลย 👇\n🧡 Shopee : https://s.shopee.co.th/FINAL';
  const r = await req('POST', '/create-ad', {
    page_id: LIVE_PAGE_ID,
    video_id: 'EXISTINGVID',
    caption: 'cap',
    shortlink: 'https://s.shopee.co.th/x',
    shopee_url: 'https://shopee.co.th/x',
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    skip_publish_to_page: true,
    daily_campaign_name: '19/Jun/2026',
    campaign_daily_budget: 1000000,
    adset_run_hours: 24,
    comment_message: rendered
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  const commentPosts = browser.calls.filter((c) => /\/comments/.test(c.url) && c.method === 'POST');
  assert.equal(commentPosts.length, 1, 'exactly one Page comment POST is issued');
  const sentMessage = JSON.parse(commentPosts[0].body).message;
  assert.equal(sentMessage, rendered, 'comment posts the rendered template, not the bare shortlink');
  assert.ok(sentMessage.includes('Shopee :'), 'comment carries the template style, not a bare link');
  assert.equal(r.body.comment_status, 'commented');
  assertNoLeak(r.body);
});

test('POST /create-ad scheduled skip_publish retries creative without Instagram ids when Meta rejects IG fields', async () => {
  const browser = makeBrowser({
    creativeErrorWithInstagram: true,
    templateInstagramActorId: 'IG_ACTOR_1',
    templateInstagramUserId: 'IG_USER_1'
  });
  await listen({ browser });
  const r = await req('POST', '/create-ad', {
    page_id: LIVE_PAGE_ID,
    video_id: 'EXISTINGVID',
    caption: 'cap',
    shortlink: 'https://s.shopee.co.th/x',
    shopee_url: 'https://shopee.co.th/x',
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    skip_publish_to_page: true,
    daily_campaign_name: '22/Jun/2026',
    campaign_daily_budget: 1000000,
    adset_run_hours: 24
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.creative_retry_without_instagram, true);
  const creativeCalls = browser.calls.filter((c) => /\/adcreatives/.test(c.url) && c.method === 'POST');
  assert.equal(creativeCalls.length, 2, 'first creative with IG ids fails, retry without IG ids succeeds');
  assert.ok(/instagram_(actor|user)_id/.test(String(creativeCalls[0].body || '')), 'first attempt includes template IG ids');
  assert.ok(!/instagram_(actor|user)_id/.test(String(creativeCalls[1].body || '')), 'retry strips IG ids');
  assert.equal(r.body.published_to_page, false);
  assert.equal(r.body.ad_id, 'AD1');
  assertNoLeak(r.body);
});

test('POST /create-ad scheduled skip_publish retries creative without link_format when Meta rejects VIDEO_LPP', async () => {
  const browser = makeBrowser({ creativeErrorWithLinkFormat: true });
  await listen({ browser });
  const r = await req('POST', '/create-ad', {
    page_id: LIVE_PAGE_ID,
    video_id: 'EXISTINGVID',
    caption: 'cap',
    shortlink: 'https://s.shopee.co.th/x',
    shopee_url: 'https://shopee.co.th/x',
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    skip_publish_to_page: true,
    daily_campaign_name: '22/Jun/2026',
    campaign_daily_budget: 1000000,
    adset_run_hours: 24
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.creative_retry_without_link_format, true);
  const creativeCalls = browser.calls.filter((c) => /\/adcreatives/.test(c.url) && c.method === 'POST');
  assert.equal(creativeCalls.length, 2, 'first creative with VIDEO_LPP fails, retry without link_format succeeds');
  assert.ok(String(creativeCalls[0].body || '').includes('"link_format":"VIDEO_LPP"'));
  assert.ok(!String(creativeCalls[1].body || '').includes('"link_format"'));
  assert.equal(r.body.published_to_page, false);
  assert.equal(r.body.ad_id, 'AD1');
  assertNoLeak(r.body);
});

test('POST /create-ad scheduled skip_publish can create linkless first then rely on paid CTA repair', async () => {
  const browser = makeBrowser({ creativeErrorWithCta: true });
  await listen({ browser });
  const r = await req('POST', '/create-ad', {
    page_id: LIVE_PAGE_ID,
    video_id: 'EXISTINGVID',
    caption: 'cap',
    shortlink: 'https://s.shopee.co.th/x',
    shopee_url: 'https://shopee.co.th/x',
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    skip_publish_to_page: true,
    daily_campaign_name: '22/Jun/2026',
    campaign_daily_budget: 1000000,
    adset_run_hours: 24
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.creative_retry_without_cta, true);
  const creativeCalls = browser.calls.filter((c) => /\/adcreatives/.test(c.url) && c.method === 'POST');
  assert.equal(creativeCalls.length, 3, 'full creative fails, no-link_format retry fails, no-CTA retry succeeds');
  assert.ok(String(creativeCalls[0].body || '').includes('"call_to_action"'));
  assert.ok(String(creativeCalls[1].body || '').includes('"call_to_action"'));
  assert.ok(!String(creativeCalls[2].body || '').includes('"call_to_action"'));
  assert.equal(r.body.published_to_page, false);
  assert.equal(r.body.ad_id, 'AD1');
  assertNoLeak(r.body);
});

test('POST /create-ad scheduled skip_publish can retry without thumbnail image_url', async () => {
  const browser = makeBrowser({ creativeErrorWithImage: true });
  await listen({ browser });
  const r = await req('POST', '/create-ad', {
    page_id: LIVE_PAGE_ID,
    video_id: 'EXISTINGVID',
    caption: 'cap',
    shortlink: 'https://s.shopee.co.th/x',
    shopee_url: 'https://shopee.co.th/x',
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    skip_publish_to_page: true,
    daily_campaign_name: '22/Jun/2026',
    campaign_daily_budget: 1000000,
    adset_run_hours: 24
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.creative_retry_without_image, true);
  const creativeCalls = browser.calls.filter((c) => /\/adcreatives/.test(c.url) && c.method === 'POST');
  assert.equal(creativeCalls.length, 4, 'full/no-link/no-CTA attempts fail with image_url, final no-image retry succeeds');
  assert.ok(String(creativeCalls[0].body || '').includes('"image_url"'));
  assert.ok(String(creativeCalls[1].body || '').includes('"image_url"'));
  assert.ok(String(creativeCalls[2].body || '').includes('"image_url"'));
  assert.ok(!String(creativeCalls[3].body || '').includes('"image_url"'));
  assert.equal(r.body.published_to_page, false);
  assert.equal(r.body.ad_id, 'AD1');
  assertNoLeak(r.body);
});

// AD-ONLY ACTIVE path with an EXPLICIT campaign_id (usedDailyCampaign stays false). Without the
// ad-only signal the adset would be named with the FULL page_id_post_id; the bridge must still use
// the TAIL-only name here (driven by skip_publish_to_page / campaign_daily_budget / adset_run_hours /
// force_adset_name_tail) and still drop the single affiliate-link comment.
test('POST /create-ad active ad-only with explicit campaign_id names the adset TAIL-only and comments ONCE', async () => {
  const browser = makeBrowser();
  await listen({ browser });
  const r = await req('POST', '/create-ad', {
    page_id: LIVE_PAGE_ID,
    video_id: 'EXISTINGVID',
    caption: 'cap',
    shortlink: 'https://s.shopee.co.th/x',
    shopee_url: 'https://shopee.co.th/x',
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    skip_publish_to_page: true,
    campaign_id: 'CAMPEXPLICIT',
    adset_run_hours: 24
    // explicit campaign_id → NOT the daily-campaign path (usedDailyCampaign=false), still active.
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.campaign_id, 'CAMPEXPLICIT', 'reuses the explicit campaign id');
  assert.equal(r.body.adset_id, 'ADSET1');
  assert.equal(r.body.ad_status, 'ACTIVE');
  // No campaign is created when an explicit campaign_id is supplied.
  assert.ok(!browser.calls.some((c) => /\/campaigns\?/.test(c.url) && c.method === 'POST'), 'no campaign created for explicit campaign_id');
  // The adset activation carries the TAIL-only name (STORY9), never the full page_id_post_id.
  const adsetActivate = browser.calls.find((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /"status":"ACTIVE"/.test(String(c.body || '')));
  assert.ok(adsetActivate, 'the adset activation POST was issued');
  assert.equal(JSON.parse(adsetActivate.body).name, 'STORY9', 'explicit campaign_id ad-only path names the adset TAIL-only');
  // Still drops exactly one affiliate-link Page comment.
  const commentPosts = browser.calls.filter((c) => /\/comments/.test(c.url) && c.method === 'POST');
  assert.equal(commentPosts.length, 1, 'exactly one Page comment POST is issued');
  assert.equal(r.body.comment_status, 'commented');
  assert.equal(r.body.published_to_page, false, 'never publishes a page post');
  assertNoLeak(r.body);
});

test('POST /promote with paused:true builds a PAUSED ad and NEVER activates', async () => {
  const browser = makeBrowser();
  await listen({ browser });
  const r = await req('POST', '/promote', {
    page_id: LIVE_PAGE_ID,
    video_id: 'EXISTINGVID',
    final_cta_link: 'https://s.shopee.co.th/x',
    caption: 'cap',
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    paused: true
  });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.ad_id, 'AD1');
  assert.equal(r.body.paused, true);
  assert.equal(r.body.adset_status, 'PAUSED');
  assert.equal(r.body.ad_status, 'PAUSED');
  assert.equal(r.body.published_to_page, false, 'promote never publishes a page post');
  assert.ok(
    !browser.calls.some((c) => /\/AD1\?/.test(c.url) && c.method === 'POST' && /"status":"ACTIVE"/.test(String(c.body || ''))),
    'paused promote must NOT activate the ad'
  );
  assert.ok(
    !browser.calls.some((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /"status":"ACTIVE"/.test(String(c.body || ''))),
    'paused promote must NOT activate the adset'
  );
  assertNoLeak(r.body);
});

// VISIBLE-CTA-FIRST (current intent): skip_ad is a LEGACY path (the Worker main flow now uses
// skip_publish_to_page + ad-story-first, see /publish-story). When it IS used, Phase A bakes the
// INITIAL direct Shopee CTA so the visible post immediately shows the Shopee card + SHOP_NOW button.
test('POST /create-ad with skip_ad bakes the INITIAL visible Shopee CTA (visible-CTA-first), never a Worker redirect', async () => {
  const browser = makeBrowser();
  await listen({ browser });
  const INITIAL_SHORTLINK = 'https://s.shopee.co.th/sub3only';
  const SHOPEE = 'https://shopee.co.th/x';
  const r = await req('POST', '/create-ad', {
    page_id: LIVE_PAGE_ID,
    video_url: 'https://cdn/example.mp4',
    caption: 'cap',
    shortlink: INITIAL_SHORTLINK,
    shopee_url: SHOPEE,
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    skip_ad: true
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.phase, 'post', 'Phase A returns phase=post');
  assert.equal(r.body.story_id, `${LIVE_PAGE_ID}_STORY9`);
  assert.equal(r.body.video_id, 'VID123', 'returns the reusable uploaded video id');
  assert.equal(r.body.thumbnail_url, 'https://thumb/x.jpg', 'returns the reusable thumbnail');
  assert.equal(r.body.published_to_page, true, 'the visible page post is published');
  assert.equal(r.body.ad_id, undefined, 'no ad is created in Phase A');
  // VISIBLE-CTA-FIRST: Phase A bakes the INITIAL direct Shopee CTA. It must NEVER bake a Worker
  // redirect into the visible UI.
  const phaseACreative = browser.calls.find((c) => /\/adcreatives/.test(c.url) && c.method === 'POST');
  assert.ok(phaseACreative, 'a Phase A adcreative was created');
  assert.ok(String(phaseACreative.body).includes('call_to_action'), 'Phase A bakes the initial visible CTA object');
  assert.ok(String(phaseACreative.body).includes(INITIAL_SHORTLINK), 'visible post creative carries the initial direct Shopee link');
  assert.ok(!String(phaseACreative.body).includes('onecard-cta'), 'Phase A must not contain the retired redirect path');
  assert.ok(!String(phaseACreative.body).includes('api.pubilo.com'), 'Phase A CTA payload must not contain api.pubilo.com');
  assert.ok(!String(phaseACreative.body).includes('cta_redirect_url'), 'Phase A must not forward cta_redirect_url');
  assert.equal(r.body.cta_link, INITIAL_SHORTLINK, 'reports the initial visible CTA link');
  assert.equal(r.body.visible_page_cta_link, INITIAL_SHORTLINK);
  assert.equal(r.body.visible_page_cta_initial, true, 'Phase A shows an initial Shopee CTA card/button');
  assert.equal(r.body.visible_page_cta_final, false, 'the post-specific final link is applied later by /update-cta');
  // Hard guarantee: skip_ad must NOT create a campaign/adset/ad.
  assert.ok(!browser.calls.some((c) => /\/campaigns\?/.test(c.url) && c.method === 'POST'), 'no campaign created');
  assert.ok(!browser.calls.some((c) => /\/copies/.test(c.url)), 'no adset copied');
  assert.ok(!browser.calls.some((c) => /\/ads\?/.test(c.url) && c.method === 'POST'), 'no ad created');
  assertNoLeak(r.body);
});

test('POST /create-ad with skip_ad strips a Worker redirect CTA and publishes linkless (never a redirect in the visible UI)', async () => {
  const browser = makeBrowser();
  await listen({ browser });
  // Only a Worker redirect is available (no direct Shopee link). The visible post must NEVER carry
  // a redirect URL, so Phase A strips it and publishes a linkless video rather than baking it in.
  const REDIRECT = 'https://api.pubilo.com/onecard-cta/oc_test123';
  const r = await req('POST', '/create-ad', {
    page_id: LIVE_PAGE_ID,
    video_url: 'https://cdn/example.mp4',
    caption: 'cap',
    shortlink: REDIRECT,
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    skip_ad: true
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  const phaseACreative = browser.calls.find((c) => /\/adcreatives/.test(c.url) && c.method === 'POST');
  assert.ok(phaseACreative, 'a Phase A adcreative was created');
  assert.ok(!String(phaseACreative.body).includes('call_to_action'), 'strips the redirect → no CTA object (linkless)');
  assert.ok(!String(phaseACreative.body).includes('onecard-cta'), 'must NOT bake the Worker redirect path');
  assert.ok(!String(phaseACreative.body).includes('api.pubilo.com'), 'must NOT bake api.pubilo.com into the visible UI');
  assert.equal(r.body.cta_link, null, 'no CTA link when only a Worker redirect was available');
  assert.equal(r.body.visible_page_cta_link, null);
  assert.equal(r.body.visible_page_cta_initial, false);
  assert.equal(r.body.visible_page_cta_final, false);
  assertNoLeak(r.body);
});

test('POST /promote builds a paid ad from video_data.video_id with the FINAL CTA — no organic post CTA update', async () => {
  // The verified legacy flow: a NEW dark-post creative with object_story_spec.video_data
  // carrying the video_id + SHOP_NOW CTA to the direct Shopee link, then copy template adset
  // + create ad. The mock browser exposes NO updateExistingPostCta — promote must not need it.
  const FINAL = 'https://s.shopee.co.th/80AJs9V61t';
  const SOURCE_POST = `${LIVE_PAGE_ID}_984409834561573`;
  const browser = makeBrowser();
  await listen({ browser });
  const r = await req('POST', '/promote', {
    page_id: LIVE_PAGE_ID,
    video_id: '1739988064022663',
    story_id: SOURCE_POST,
    final_cta_link: FINAL,
    thumbnail_url: 'https://thumb/x.jpg',
    caption: 'cap',
    ad_account: 'act_test',
    template_adset: 'tpl_test'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.phase, 'promote');
  assert.equal(r.body.ad_id, 'AD1');
  assert.equal(r.body.adset_id, 'ADSET1');
  assert.equal(r.body.video_id, '1739988064022663', 'reuses the supplied video_id');
  assert.equal(r.body.cta_link, FINAL);
  assert.equal(r.body.promoted_ad_cta_link, FINAL, 'promoted ad CTA link is the final link');
  assert.equal(r.body.promoted_ad_cta_final, true, 'the promoted ad CTA is final');
  assert.equal(r.body.published_to_page, false, 'promote never publishes a second page post');
  // The ad creative mints its OWN story (ad_story_id), DISTINCT from the source page post.
  assert.equal(r.body.source_post_id, SOURCE_POST, 'reports the source page post id');
  assert.equal(r.body.ad_story_id, `${LIVE_PAGE_ID}_STORY9`, 'reports the new ad dark-story id');
  assert.notEqual(r.body.ad_story_id, r.body.source_post_id, 'ad_story_id is distinct from source_post_id');
  // It does NOT update the organic page post CTA and never claims a visible page CTA success.
  assert.equal(r.body.visible_page_cta_final, false, 'promote does not update the organic post CTA');
  assert.equal(r.body.visible_page_cta_link, undefined, 'no visible page CTA link is reported');
  assert.equal(r.body.visible_cta_update_status, undefined);
  // The creative is built via video_data.video_id with the FINAL link in its call_to_action.
  const creativePost = browser.calls.find((c) => /\/adcreatives/.test(c.url) && c.method === 'POST');
  assert.ok(creativePost, 'an adcreative was created');
  const crBody = JSON.parse(creativePost.body);
  assert.equal(crBody.object_story_spec.video_data.video_id, '1739988064022663', 'creative uses video_data.video_id');
  assert.equal(crBody.object_story_spec.video_data.call_to_action.value.link, FINAL, 'creative CTA carries the FINAL link');
  assert.equal(crBody.object_story_spec.video_data.call_to_action.value.link_format, 'VIDEO_LPP');
  assert.ok(!('object_story_id' in crBody.object_story_spec), 'must NOT build the creative from an existing object_story_id');
  // It uses the build/copy/ad path (template adset copy + ad create) and never publishes the ad story.
  assert.ok(browser.calls.some((c) => /\/copies/.test(c.url) && c.method === 'POST'), 'copies the template adset');
  assert.ok(browser.calls.some((c) => /\/ads\?/.test(c.url) && c.method === 'POST'), 'creates the ad');
  assert.ok(!browser.calls.some((c) => /\/advideos/.test(c.url)), 'must not upload a second video');
  assert.ok(!browser.calls.some((c) => /is_published/.test(String(c.body || ''))), 'must not publish the ad dark story');
  assertNoLeak(r.body);
});

test('POST /promote with use_object_story_id sponsors the same NEW Page story', async () => {
  const FINAL = 'https://s.shopee.co.th/80AJs9V61t';
  const NEW_STORY = `${LIVE_PAGE_ID}_NEWPOST1`;
  const browser = makeBrowser();
  await listen({ browser });
  const r = await req('POST', '/promote', {
    page_id: LIVE_PAGE_ID,
    story_id: NEW_STORY,
    post_id: NEW_STORY,
    video_id: 'PAGEVID1',
    final_cta_link: FINAL,
    caption: 'cap',
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    use_object_story_id: true,
    skip_comment: true
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.phase, 'promote');
  assert.equal(r.body.promote_mode, 'object_story_id');
  assert.equal(r.body.promote_uses_object_story_id, true);
  assert.equal(r.body.story_id, NEW_STORY);
  assert.equal(r.body.effective_object_story_id, NEW_STORY);
  assert.equal(r.body.ad_story_id, NEW_STORY);
  assert.equal(r.body.ad_id, 'AD1');
  assert.equal(r.body.published_to_page, true);
  assert.equal(r.body.promoted_ad_cta_link, FINAL);
  assert.equal(r.body.promoted_ad_cta_final, true);
  assert.equal(r.body.visible_page_cta_final, true);

  const creativePost = browser.calls.find((c) => /\/adcreatives/.test(c.url) && c.method === 'POST');
  assert.ok(creativePost, 'an adcreative was created');
  const crBody = JSON.parse(creativePost.body);
  assert.equal(crBody.object_story_id, NEW_STORY, 'creative sponsors the same new Page story');
  assert.ok(!('object_story_spec' in crBody), 'must not create a second video_data dark story');
  assert.ok(!String(creativePost.body).includes('video_data'), 'creative body has no video_data');
  assert.ok(browser.calls.some((c) => /\/copies/.test(c.url) && c.method === 'POST'), 'copies the template adset');
  assert.ok(browser.calls.some((c) => /\/ads\?/.test(c.url) && c.method === 'POST'), 'creates the ad');
  assert.ok(!browser.calls.some((c) => /\/advideos/.test(c.url)), 'must not upload another video');
  assertNoLeak(r.body);
});

test('POST /promote resolves video_id from the source post attachment when video_id is absent', async () => {
  // No video_id supplied: promote reads attachments{media_type,target{id,url}} on the source
  // post and promotes the attachment target video. Fails closed if none can be resolved.
  const FINAL = 'https://s.shopee.co.th/80AJs9V61t';
  const SOURCE_POST = `${LIVE_PAGE_ID}_984409834561573`;
  const browser = makeBrowser({ attachmentVideoId: '1739988064022663' });
  await listen({ browser });
  const r = await req('POST', '/promote', {
    page_id: LIVE_PAGE_ID,
    story_id: SOURCE_POST,
    final_cta_link: FINAL,
    thumbnail_url: 'https://thumb/x.jpg',
    caption: 'cap',
    ad_account: 'act_test',
    template_adset: 'tpl_test'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.video_id, '1739988064022663', 'resolved the video_id from the source post attachment');
  assert.ok(browser.calls.some((c) => /fields=attachments/.test(c.url)), 'queried the source post attachments');
  const creativePost = browser.calls.find((c) => /\/adcreatives/.test(c.url) && c.method === 'POST');
  const crBody = JSON.parse(creativePost.body);
  assert.equal(crBody.object_story_spec.video_data.video_id, '1739988064022663');
  assertNoLeak(r.body);
});

test('POST /promote fails closed (resolve_video) when no video_id can be resolved from the source post', async () => {
  // Source post has NO video attachment → no target id → fail closed before any creative/ad.
  // attachmentVideoId:'' makes the attachment route return a target with an empty id.
  const browser = makeBrowser({ attachmentVideoId: '' });
  await listen({ browser });
  const r = await req('POST', '/promote', {
    page_id: LIVE_PAGE_ID,
    story_id: `${LIVE_PAGE_ID}_984409834561573`,
    final_cta_link: 'https://s.shopee.co.th/80AJs9V61t',
    ad_account: 'act_test',
    template_adset: 'tpl_test'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.step, 'resolve_video');
  assert.equal(r.body.error, 'video_id_unresolved');
  assert.ok(!browser.calls.some((c) => /\/adcreatives/.test(c.url) && c.method === 'POST'), 'must not create an adcreative');
  assert.ok(!browser.calls.some((c) => /\/ads\?/.test(c.url) && c.method === 'POST'), 'must not create an ad');
  assertNoLeak(r.body);
});

test('POST /promote FAILS CLOSED when the template CTA is LIKE_PAGE (cannot bake the final link)', async () => {
  const browser = makeBrowser({ ctaType: 'LIKE_PAGE' });
  await listen({ browser });
  const r = await req('POST', '/promote', {
    page_id: LIVE_PAGE_ID,
    video_id: 'VID123',
    story_id: `${LIVE_PAGE_ID}_STORY9`,
    final_cta_link: 'https://s.shopee.co.th/FINAL_sub2_sub3',
    thumbnail_url: 'https://thumb/x.jpg',
    caption: 'cap',
    ad_account: 'act_test',
    template_adset: 'tpl_test'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.step, 'creative');
  assert.equal(r.body.error, 'template_cta_type_does_not_support_final_link');
  assert.equal(r.body.cta_type, 'LIKE_PAGE');
  // Hard guarantee: nothing is created — no adcreative, no campaign, no adset, no ad.
  assert.ok(!browser.calls.some((c) => /\/adcreatives/.test(c.url) && c.method === 'POST'), 'must not create an adcreative');
  assert.ok(!browser.calls.some((c) => /\/campaigns\?/.test(c.url) && c.method === 'POST'), 'must not create a campaign');
  assert.ok(!browser.calls.some((c) => /\/copies/.test(c.url)), 'must not copy an adset');
  assert.ok(!browser.calls.some((c) => /\/ads\?/.test(c.url) && c.method === 'POST'), 'must not create an ad');
  assertNoLeak(r.body);
});

test('POST /promote fails closed (validate) when video_id missing', async () => {
  await listen();
  const r = await req('POST', '/promote', { page_id: LIVE_PAGE_ID, final_cta_link: 'https://s.shopee.co.th/x' });
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.step, 'validate');
});

test('POST /promote fails closed (validate) when final_cta_link missing', async () => {
  await listen();
  const r = await req('POST', '/promote', { page_id: LIVE_PAGE_ID, video_id: 'VID123' });
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.step, 'validate');
});

test('POST /promote rejects a non-http final_cta_link (no fake/empty CTA)', async () => {
  await listen();
  const r = await req('POST', '/promote', {
    page_id: LIVE_PAGE_ID, video_id: 'VID123', final_cta_link: 'notaurl', ad_account: 'act_test', template_adset: 'tpl_test'
  });
  assert.equal(r.body.ok, false);
  assert.equal(r.body.step, 'validate');
});

test('POST /promote rejects Worker redirect URLs as final CTA payloads', async () => {
  await listen();
  const r = await req('POST', '/promote', {
    page_id: LIVE_PAGE_ID,
    video_id: 'VID123',
    final_cta_link: 'https://api.pubilo.com/onecard-cta/oc_test123',
    ad_account: 'act_test',
    template_adset: 'tpl_test'
  });
  assert.equal(r.body.ok, false);
  assert.equal(r.body.step, 'validate');
  assert.equal(r.body.error, 'final_cta_link_must_be_direct_shopee_link');
});

test('POST /promote fails closed (no_session) when the profile is not logged in', async () => {
  await listen({ browser: makeBrowser(NOT_LOGGED_IN) });
  const r = await req('POST', '/promote', {
    page_id: LIVE_PAGE_ID, video_id: 'VID123', final_cta_link: 'https://s.shopee.co.th/x', ad_account: 'act_test', template_adset: 'tpl_test'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.step, 'session');
  assert.equal(r.body.error, 'no_session');
});

test('POST /update-cta updates the VISIBLE post CTA on attachments.target.id and verifies via read-back', async () => {
  // Live-proven flow: read the visible post → POST call_to_action on attachments.target.id (the
  // Reel video object, NOT the story id) → read back to confirm. readbackCtaLink === FINAL makes
  // the read-back confirm the visible CTA changed.
  const FINAL = 'https://s.shopee.co.th/3VhueVmOBA';
  const SOURCE_POST = `${LIVE_PAGE_ID}_984495714552985`;
  const TARGET_ID = '2061700814696950';
  const browser = makeBrowser({ readbackCtaLink: FINAL });
  await listen({ browser });
  const r = await req('POST', '/update-cta', {
    page_id: LIVE_PAGE_ID,
    story_id: SOURCE_POST,
    final_cta_link: FINAL,
    video_id: 'VID123'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.phase, 'update_cta');
  assert.equal(r.body.cta_update_target_id, TARGET_ID, 'updates the attachment target id, not the story id');
  assert.notEqual(r.body.cta_update_target_id, SOURCE_POST, 'must NOT update the story id directly');
  assert.equal(r.body.final_cta_link, FINAL);
  assert.equal(r.body.visible_page_cta_link, FINAL, 'read-back confirms the visible CTA link');
  assert.equal(r.body.visible_page_cta_final, true, 'read-back parity proves the visible CTA changed');
  assert.ok(String(r.body.permalink_url || '').includes('/reel/'), 'returns the reel permalink');
  // The CTA POST targets the attachment id and carries the FINAL link with VIDEO_LPP.
  const ctaPost = browser.calls.find((c) => c.method === 'POST' && new RegExp(`/${TARGET_ID}\\?`).test(c.url) && /call_to_action/.test(String(c.body || '')));
  assert.ok(ctaPost, 'CTA POST sent to the attachment target id');
  const ctaBody = JSON.parse(ctaPost.body);
  assert.equal(ctaBody.call_to_action.type, 'SHOP_NOW');
  assert.equal(ctaBody.call_to_action.value.link, FINAL, 'CTA POST carries the FINAL link');
  assert.equal(ctaBody.call_to_action.value.link_format, 'VIDEO_LPP');
  // Never POST the CTA to the bare story id.
  assert.ok(!browser.calls.some((c) => c.method === 'POST' && new RegExp(`/${SOURCE_POST}\\?`).test(c.url) && /call_to_action/.test(String(c.body || ''))), 'must not update the story id');
  assertNoLeak(r.body);
});

test('POST /update-cta reports visible_page_cta_final:false when the read-back shows the CTA unchanged', async () => {
  // The live failure mode: the POST "succeeds" but the visible post CTA does not change. The
  // read-back (no call_to_action link) must keep visible_page_cta_final:false — never overclaim.
  const FINAL = 'https://s.shopee.co.th/3VhueVmOBA';
  const browser = makeBrowser({ readbackCtaLink: null });
  await listen({ browser });
  const r = await req('POST', '/update-cta', {
    page_id: LIVE_PAGE_ID,
    story_id: `${LIVE_PAGE_ID}_984495714552985`,
    final_cta_link: FINAL
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, 'the POST itself succeeded');
  assert.equal(r.body.visible_page_cta_final, false, 'unchanged read-back must not claim a visible CTA');
  assert.equal(r.body.visible_page_cta_link, '', 'no verified visible CTA link');
  assertNoLeak(r.body);
});

test('POST /update-cta FAILS CLOSED (page_token_not_found) when the session does not administer the page', async () => {
  const browser = makeBrowser({ pages: [{ id: '999', name: 'Other', access_token: 'OTHER' }] });
  await listen({ browser });
  const r = await req('POST', '/update-cta', {
    page_id: LIVE_PAGE_ID,
    story_id: `${LIVE_PAGE_ID}_984495714552985`,
    final_cta_link: 'https://s.shopee.co.th/3VhueVmOBA'
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.error, 'page_token_not_found');
  // Hard guarantee: no CTA was ever POSTed without a page token.
  assert.ok(!browser.calls.some((c) => /call_to_action/.test(String(c.body || ''))), 'must not POST a CTA when the page token is missing');
});

test('POST /update-cta rejects Worker redirect / non-direct-shopee links (no redirect in the visible UI)', async () => {
  await listen();
  for (const bad of ['https://api.pubilo.com/onecard-cta/oc_x', 'https://short.wwoom.com/abc', 'notaurl']) {
    const r = await req('POST', '/update-cta', {
      page_id: LIVE_PAGE_ID,
      story_id: `${LIVE_PAGE_ID}_984495714552985`,
      final_cta_link: bad
    });
    assert.equal(r.body.ok, false, `rejected ${bad}`);
    assert.equal(r.body.step, 'validate');
  }
});

test('POST /update-cta fails closed (validate) when page_id/story_id/final_cta_link missing', async () => {
  await listen();
  const r = await req('POST', '/update-cta', { page_id: LIVE_PAGE_ID });
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.step, 'validate');
});

test('POST /update-cta fails closed (no_session) when the profile is not logged in', async () => {
  await listen({ browser: makeBrowser(NOT_LOGGED_IN) });
  const r = await req('POST', '/update-cta', {
    page_id: LIVE_PAGE_ID,
    story_id: `${LIVE_PAGE_ID}_984495714552985`,
    final_cta_link: 'https://s.shopee.co.th/3VhueVmOBA'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.step, 'session');
  assert.equal(r.body.error, 'no_session');
});

test('POST /publish-story publishes the SAME ad story to the page and returns published_to_page (no token leak)', async () => {
  const browser = makeBrowser();
  await listen({ browser });
  const STORY = `${LIVE_PAGE_ID}_STORY9`;
  const r = await req('POST', '/publish-story', { page_id: LIVE_PAGE_ID, story_id: STORY });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.phase, 'publish_story');
  assert.equal(r.body.story_id, STORY);
  assert.equal(r.body.published_to_page, true);
  // Published via the PAGE token with is_published:true on the story id.
  const pub = browser.calls.find((c) => c.method === 'POST' && new RegExp(`/${STORY}\\?`).test(c.url) && /is_published/.test(String(c.body || '')));
  assert.ok(pub, 'is_published POSTed to the story id');
  assertNoLeak(r.body);
});

test('POST /publish-story FAILS CLOSED (page_token_not_found) when the session does not administer the page', async () => {
  const browser = makeBrowser({ pages: [{ id: '999', name: 'Other', access_token: 'OTHER' }] });
  await listen({ browser });
  const r = await req('POST', '/publish-story', { page_id: LIVE_PAGE_ID, story_id: `${LIVE_PAGE_ID}_STORY9` });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.published_to_page, false);
  assert.equal(r.body.error, 'page_token_not_found');
  // Hard guarantee: no is_published POST without the page token.
  assert.ok(!browser.calls.some((c) => /is_published/.test(String(c.body || ''))), 'must not publish without a page token');
});

test('POST /publish-story fails closed (validate) when page_id/story_id missing', async () => {
  await listen();
  const r = await req('POST', '/publish-story', { page_id: LIVE_PAGE_ID });
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.step, 'validate');
});

test('POST /publish-story fails closed (no_session) when the profile is not logged in', async () => {
  await listen({ browser: makeBrowser(NOT_LOGGED_IN) });
  const r = await req('POST', '/publish-story', { page_id: LIVE_PAGE_ID, story_id: `${LIVE_PAGE_ID}_STORY9` });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.step, 'session');
  assert.equal(r.body.error, 'no_session');
});

test('POST /promote with daily_campaign_name CREATES the daily campaign with a CAMPAIGN-level (CBO) budget + 24h schedule (no adset budget)', async () => {
  const FINAL = 'https://s.shopee.co.th/80AJs9V61t';
  const DAILY = '15/Jun/2026';
  const browser = makeBrowser(); // no existingCampaigns → must create the daily campaign
  await listen({ browser });
  const r = await req('POST', '/promote', {
    page_id: LIVE_PAGE_ID,
    video_id: '1739988064022663',
    story_id: `${LIVE_PAGE_ID}_984409834561573`,
    final_cta_link: FINAL,
    thumbnail_url: 'https://thumb/x.jpg',
    caption: 'cap',
    source_video_id: 'ea401f1e',
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    daily_campaign_name: DAILY
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.campaign_id, 'CAMP1', 'created the daily campaign');
  assert.equal(r.body.campaign_name, DAILY, 'returns the daily campaign name');
  // A campaign POST was made carrying the EXACT daily name + the template objective + the
  // CAMPAIGN-level (CBO) daily_budget + LOWEST_COST bid strategy (operator's Ads Manager template).
  const campPost = browser.calls.find((c) => /\/campaigns\?/.test(c.url) && c.method === 'POST');
  assert.ok(campPost, 'a campaign was created');
  const campBody = JSON.parse(campPost.body);
  assert.equal(campBody.name, DAILY, 'campaign created with the exact daily name');
  assert.equal(campBody.objective, 'OUTCOME_ENGAGEMENT', 'campaign uses the template objective');
  assert.equal(campBody.daily_budget, '1000000', 'daily campaign carries the CBO budget (default 10,000 THB/day)');
  assert.equal(campBody.bid_strategy, 'LOWEST_COST_WITHOUT_CAP', 'daily campaign uses LOWEST_COST CBO bid strategy');
  // The copied adset must NOT get its own daily_budget — Meta rejects an adset budget under a CBO
  // campaign. There is no adset budget POST at all on the daily path now.
  assert.ok(
    !browser.calls.some((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /daily_budget/.test(String(c.body || ''))),
    'daily path must NOT POST a per-adset daily_budget'
  );
  // ACTIVATION POST is the live-proven shape: { name, status:'ACTIVE', end_time } (no daily_budget,
  // no start_time). end_time is a Graph-compatible offset ISO string (e.g. 2026-06-16T21:04:36+0700).
  const actPost = browser.calls.find((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /"status":"ACTIVE"/.test(String(c.body || '')));
  assert.ok(actPost, 'the adset was activated in a separate POST');
  const actBody = JSON.parse(actPost.body);
  assert.equal(actBody.status, 'ACTIVE', 'activation POST sets status ACTIVE');
  assert.equal(typeof actBody.end_time, 'string', 'activation end_time is a string, not a number');
  assert.match(actBody.end_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/, 'activation end_time is an offset ISO string');
  // end_time = the COPIED adset's read-back start_time (2026-06-15T21:39:39+0700) + 24h — derived
  // from Graph's start_time, NOT the bridge's local clock at copy time.
  assert.equal(actBody.end_time, '2026-06-16T21:39:39+0700', 'end_time is exactly 24h after the copied adset start_time');
  assert.equal(actBody.start_time, undefined, 'no start_time on the activation POST');
  assert.equal(actBody.daily_budget, undefined, 'activation POST must NOT include daily_budget (rejected with end_time)');
  assert.ok(browser.calls.some((c) => /\/ADSET1\?fields=start_time&/.test(c.url) && c.method === 'GET'), 'read the copied adset start_time before scheduling');
  // ADSET name = the post tail / sub2 only — never the hash, never page_id_post_id.
  assert.equal(actBody.name, '984409834561573', 'adset name is the post tail/sub2');
  assert.notEqual(actBody.name, `${LIVE_PAGE_ID}_984409834561573`, 'adset name must NOT be page_id_post_id');
  // AD name stays the system video code/hash (NOT sub2) — the ad is created (and named) at /ads.
  const adCreate = browser.calls.find((c) => /\/ads\?/.test(c.url) && c.method === 'POST');
  assert.ok(adCreate, 'the ad was created');
  assert.equal(JSON.parse(adCreate.body).name, 'ea401f1e', 'ad name is the system video code/hash');
  assert.notEqual(JSON.parse(adCreate.body).name, '984409834561573', 'ad name must NOT be sub2');
  assert.ok(browser.calls.some((c) => /\/ADSET1\?fields=name,status,effective_status/.test(c.url) && c.method === 'GET'), 'adset status read back to confirm ACTIVE');
  // Sanitized response carries the CBO campaign budget + the schedule as offset ISO strings.
  assert.equal(r.body.campaign_budget, 1000000, 'response reports the campaign CBO budget');
  assert.equal(r.body.daily_budget, undefined, 'no per-adset daily_budget is reported');
  assert.match(r.body.end_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/, 'response end_time is an offset ISO string');
  assert.equal(new Date(r.body.end_time).getTime() - new Date(r.body.start_time).getTime(), 24 * 3600 * 1000, 'run window is 24h');
  assertNoLeak(r.body);
});

test('POST /promote with daily_campaign_name REUSES an existing exact-name + same-objective campaign (no new campaign)', async () => {
  const FINAL = 'https://s.shopee.co.th/80AJs9V61t';
  const DAILY = '15/Jun/2026';
  const browser = makeBrowser({
    existingCampaigns: [
      { id: 'CAMPOTHER', name: '14/Jun/2026', status: 'ACTIVE', objective: 'OUTCOME_ENGAGEMENT', daily_budget: '1000000' },
      { id: 'CAMPDAILY', name: DAILY, status: 'ACTIVE', objective: 'OUTCOME_ENGAGEMENT', daily_budget: '1000000' }
    ]
  });
  await listen({ browser });
  const r = await req('POST', '/promote', {
    page_id: LIVE_PAGE_ID,
    video_id: '1739988064022663',
    story_id: `${LIVE_PAGE_ID}_984409834561573`,
    final_cta_link: FINAL,
    thumbnail_url: 'https://thumb/x.jpg',
    caption: 'cap',
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    daily_campaign_name: DAILY
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.campaign_id, 'CAMPDAILY', 'reused the existing daily campaign');
  assert.equal(r.body.campaign_name, DAILY);
  assert.ok(!browser.calls.some((c) => /\/campaigns\?/.test(c.url) && c.method === 'POST'), 'must NOT create a campaign when one with the exact name + objective exists');
  // Reuse keeps the campaign's existing CBO budget and applies only the 24h schedule. NO per-adset
  // daily_budget POST, and NO blind campaign-budget overwrite (no campaign_daily_budget requested).
  assert.ok(!browser.calls.some((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /daily_budget/.test(String(c.body || ''))), 'reuse must NOT set a per-adset daily_budget');
  assert.ok(!browser.calls.some((c) => /\/CAMPDAILY\?/.test(c.url) && c.method === 'POST' && /daily_budget/.test(String(c.body || ''))), 'reuse must NOT overwrite the campaign budget when none requested');
  const actPost = browser.calls.find((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /"status":"ACTIVE"/.test(String(c.body || '')));
  const actBody = JSON.parse(actPost.body);
  assert.match(actBody.end_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/, 'activation carries the offset ISO end_time');
  assert.equal(actBody.start_time, undefined);
  assert.equal(r.body.campaign_budget, 1000000, 'reports the reused campaign CBO budget');
  assert.equal(new Date(r.body.end_time).getTime() - new Date(r.body.start_time).getTime(), 24 * 3600 * 1000);
  assertNoLeak(r.body);
});

test('POST /promote REUSE updates the campaign CBO budget ONLY when an explicit campaign_daily_budget differs', async () => {
  const DAILY = '15/Jun/2026';
  const browser = makeBrowser({
    existingCampaigns: [{ id: 'CAMPDAILY', name: DAILY, status: 'ACTIVE', objective: 'OUTCOME_ENGAGEMENT', daily_budget: '1000000' }]
  });
  await listen({ browser });
  const r = await req('POST', '/promote', {
    page_id: LIVE_PAGE_ID,
    video_id: '1739988064022663',
    story_id: `${LIVE_PAGE_ID}_984409834561573`,
    final_cta_link: 'https://s.shopee.co.th/80AJs9V61t',
    thumbnail_url: 'https://thumb/x.jpg',
    caption: 'cap',
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    daily_campaign_name: DAILY,
    campaign_daily_budget: 2000000 // differs from the current 1,000,000 → safe update
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.campaign_id, 'CAMPDAILY', 'still reuses the campaign (no new campaign)');
  assert.ok(!browser.calls.some((c) => /\/campaigns\?/.test(c.url) && c.method === 'POST'), 'no new campaign created');
  // A campaign-level budget update POST was issued to the reused campaign id (NOT an adset).
  const campUpdate = browser.calls.find((c) => /\/CAMPDAILY\?/.test(c.url) && c.method === 'POST' && /daily_budget/.test(String(c.body || '')));
  assert.ok(campUpdate, 'reuse updates the campaign budget when an explicit budget differs');
  assert.equal(JSON.parse(campUpdate.body).daily_budget, '2000000', 'updates to the requested CBO budget');
  assert.ok(!browser.calls.some((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /daily_budget/.test(String(c.body || ''))), 'still no per-adset daily_budget');
  assert.equal(r.body.campaign_budget, 2000000, 'reports the updated CBO budget');
  assertNoLeak(r.body);
});

test('POST /promote REUSE budget update is best-effort — a failed update does NOT fail the ad', async () => {
  const DAILY = '15/Jun/2026';
  const browser = makeBrowser({
    existingCampaigns: [{ id: 'CAMPDAILY', name: DAILY, status: 'ACTIVE', objective: 'OUTCOME_ENGAGEMENT', daily_budget: '1000000' }],
    campaignBudgetError: true
  });
  await listen({ browser });
  const r = await req('POST', '/promote', {
    page_id: LIVE_PAGE_ID,
    video_id: '1739988064022663',
    story_id: `${LIVE_PAGE_ID}_984409834561573`,
    final_cta_link: 'https://s.shopee.co.th/80AJs9V61t',
    thumbnail_url: 'https://thumb/x.jpg',
    caption: 'cap',
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    daily_campaign_name: DAILY,
    campaign_daily_budget: 2000000
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, 'a failed CBO budget update must NOT fail the whole flow');
  assert.equal(r.body.ad_id, 'AD1');
  // The update was attempted but errored → campaign_budget falls back to the read value.
  assert.equal(r.body.campaign_budget, 1000000, 'reports the existing CBO budget when the update fails');
  assertNoLeak(r.body);
});

test('POST /promote does NOT reuse when the existing campaign objective differs from the template', async () => {
  const DAILY = '15/Jun/2026';
  const browser = makeBrowser({
    existingCampaigns: [{ id: 'CAMPDAILY', name: DAILY, status: 'ACTIVE', objective: 'OUTCOME_SALES' }]
  });
  await listen({ browser });
  const r = await req('POST', '/promote', {
    page_id: LIVE_PAGE_ID,
    video_id: '1739988064022663',
    story_id: `${LIVE_PAGE_ID}_984409834561573`,
    final_cta_link: 'https://s.shopee.co.th/80AJs9V61t',
    thumbnail_url: 'https://thumb/x.jpg',
    caption: 'cap',
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    daily_campaign_name: DAILY
  });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.campaign_id, 'CAMP1', 'created a fresh daily campaign (objective mismatch is not reused)');
  assert.ok(browser.calls.some((c) => /\/campaigns\?/.test(c.url) && c.method === 'POST'), 'created a campaign because objective did not match');
  assertNoLeak(r.body);
});

test('POST /promote with new_campaign_name FORCE-CREATES even when a same-name campaign exists (no reuse, legacy behavior)', async () => {
  const FORCED = '15/Jun/2026';
  const browser = makeBrowser({
    existingCampaigns: [{ id: 'CAMPDAILY', name: FORCED, status: 'ACTIVE', objective: 'OUTCOME_ENGAGEMENT' }]
  });
  await listen({ browser });
  const r = await req('POST', '/promote', {
    page_id: LIVE_PAGE_ID,
    video_id: '1739988064022663',
    story_id: `${LIVE_PAGE_ID}_984409834561573`,
    final_cta_link: 'https://s.shopee.co.th/80AJs9V61t',
    thumbnail_url: 'https://thumb/x.jpg',
    caption: 'cap',
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    new_campaign_name: FORCED
  });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.campaign_id, 'CAMP1', 'force-create returns the new campaign id, never the existing one');
  const campPost = browser.calls.find((c) => /\/campaigns\?/.test(c.url) && c.method === 'POST');
  assert.ok(campPost, 'new_campaign_name always POSTs a fresh campaign');
  assert.equal(JSON.parse(campPost.body).name, FORCED);
  // Legacy new_campaign_name path keeps the activate-only adset behavior (campaign carries the
  // budget) — it must NOT set a per-adset daily_budget that would conflict with campaign CBO, and
  // must NOT send a separate schedule POST or read the adset back.
  assert.ok(!browser.calls.some((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /daily_budget/.test(String(c.body || ''))), 'new_campaign_name path must not set an adset daily_budget');
  assert.ok(!browser.calls.some((c) => /\/ADSET1\?fields=name,status,effective_status/.test(c.url)), 'legacy path does not read the adset status back');
  const actPost = browser.calls.find((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /"status":"ACTIVE"/.test(String(c.body || '')));
  assert.ok(actPost, 'adset still activated');
  assert.equal(r.body.daily_budget, undefined, 'no schedule/budget reported on the legacy path');
  assertNoLeak(r.body);
});

test('POST /promote computes end_time as 24h after the COPIED adset start_time, not the local clock', async () => {
  // Live blocker: end_time was computed from the bridge clock BEFORE the copy finished, landing a
  // few seconds before the copied adset's own start_time + 24h → code=100 subcode=1487793. The
  // copied adset start_time here is far from "now" to prove end_time tracks the readback, not now.
  const COPIED_START = '2026-09-09T10:00:00+0700';
  const EXPECTED_END = '2026-09-10T10:00:00+0700';
  const browser = makeBrowser({ copiedAdsetStartTime: COPIED_START });
  await listen({ browser });
  const r = await req('POST', '/promote', {
    page_id: LIVE_PAGE_ID,
    video_id: '1739988064022663',
    story_id: `${LIVE_PAGE_ID}_984409834561573`,
    final_cta_link: 'https://s.shopee.co.th/80AJs9V61t',
    thumbnail_url: 'https://thumb/x.jpg',
    caption: 'cap',
    source_video_id: 'ea401f1e',
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    daily_campaign_name: '15/Jun/2026'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  const actPost = browser.calls.find((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /"status":"ACTIVE"/.test(String(c.body || '')));
  const actBody = JSON.parse(actPost.body);
  assert.equal(actBody.end_time, EXPECTED_END, 'end_time = copied adset start_time + 24h');
  assert.equal(actBody.start_time, undefined, 'still never send start_time on the POST');
  // No per-adset daily_budget POST on the daily (CBO) path.
  assert.ok(!browser.calls.some((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /daily_budget/.test(String(c.body || ''))), 'no per-adset daily_budget POST');
  // Response reports the same start/end pair (exact 24h window).
  assert.equal(r.body.start_time, COPIED_START);
  assert.equal(r.body.end_time, EXPECTED_END);
  assert.equal(new Date(r.body.end_time).getTime() - new Date(r.body.start_time).getTime(), 24 * 3600 * 1000);
  assertNoLeak(r.body);
});

function promoteDaily(extra) {
  return {
    page_id: LIVE_PAGE_ID,
    video_id: '1739988064022663',
    story_id: `${LIVE_PAGE_ID}_984409834561573`,
    final_cta_link: 'https://s.shopee.co.th/80AJs9V61t',
    thumbnail_url: 'https://thumb/x.jpg',
    caption: 'cap',
    source_video_id: 'ea401f1e',
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    daily_campaign_name: '15/Jun/2026',
    ...extra
  };
}

test('POST /promote daily path puts the budget on the CAMPAIGN (CBO) and never on the copied adset', async () => {
  // Regression guard for the CBO migration: the active daily path must set NO per-adset daily_budget
  // (Meta rejects an adset budget under a CBO campaign) and instead carry it on the created campaign.
  const browser = makeBrowser(); // no existingCampaigns → creates the daily campaign
  await listen({ browser });
  const r = await req('POST', '/promote', promoteDaily());
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  // The created campaign carries the CBO daily_budget (default 10,000 THB/day = 1,000,000 minor).
  const campPost = browser.calls.find((c) => /\/campaigns\?/.test(c.url) && c.method === 'POST');
  assert.equal(JSON.parse(campPost.body).daily_budget, '1000000', 'CBO budget set on the campaign');
  // HARD INVARIANT: no POST to the adset ever carries a daily_budget.
  assert.ok(
    !browser.calls.some((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /daily_budget/.test(String(c.body || ''))),
    'never sets a per-adset daily_budget on the daily CBO path'
  );
  assert.equal(r.body.campaign_budget, 1000000);
  assertNoLeak(r.body);
});

test('POST /promote FAILS CLOSED (adset_activate) when the activation POST errors', async () => {
  const browser = makeBrowser({ adsetActivateError: true });
  await listen({ browser });
  const r = await req('POST', '/promote', promoteDaily());
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.step, 'adset_activate');
  assert.ok(browser.calls.some((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /"status":"DELETED"/.test(String(c.body || ''))), 'orphan adset deleted on activation failure');
  assertNoLeak(r.body);
});

test('POST /promote FAILS CLOSED when the adset readback is ACTIVE but has NO end_time (schedule did not stick)', async () => {
  const browser = makeBrowser({ adsetReadbackNoEndTime: true });
  await listen({ browser });
  const r = await req('POST', '/promote', promoteDaily());
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false, 'must not claim success when the 24h schedule is missing on readback');
  assert.equal(r.body.step, 'adset_activate');
  assert.equal(r.body.error, 'adset_end_time_missing_after_update');
  assert.ok(browser.calls.some((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /"status":"DELETED"/.test(String(c.body || ''))), 'orphan adset deleted');
  assertNoLeak(r.body);
});

test('POST /promote FAILS CLOSED when the adset readback stays PAUSED after a "successful" activation POST', async () => {
  // Live blocker: POST {status:ACTIVE} returned success:true but the adset stayed PAUSED on
  // readback. The bridge reads the adset back and must reject a non-ACTIVE adset.
  const browser = makeBrowser({ adsetReadbackPaused: true });
  await listen({ browser });
  const r = await req('POST', '/promote', {
    page_id: LIVE_PAGE_ID,
    video_id: '1739988064022663',
    story_id: `${LIVE_PAGE_ID}_984409834561573`,
    final_cta_link: 'https://s.shopee.co.th/80AJs9V61t',
    thumbnail_url: 'https://thumb/x.jpg',
    caption: 'cap',
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    daily_campaign_name: '15/Jun/2026'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false, 'must not report success when readback shows the adset is PAUSED');
  assert.equal(r.body.step, 'adset_activate');
  assert.equal(r.body.error, 'adset_not_active_after_update');
  assert.equal(r.body.adset_status, 'PAUSED');
  assert.ok(browser.calls.some((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /"status":"DELETED"/.test(String(c.body || ''))), 'paused adset cleaned up');
  assertNoLeak(r.body);
});

// ── Cleanup: a failed force-post must not leave an orphan empty campaign ──────────────────────
// Live symptom: after a failed force-post on page เฉียบ, Ads Manager kept a 16/Jun/2026 campaign
// with "ไม่มีโฆษณา" (no ads). When the bridge CREATES the daily campaign and a downstream step
// fails, it must delete the copied adset AND the now-empty campaign it created. A REUSED existing
// campaign must never be deleted (other live ads may share it).

test('POST /promote downstream failure deletes the copied adset AND the newly-created daily campaign', async () => {
  // No existingCampaigns → the bridge CREATES the daily campaign (CAMP1). The activation then errors
  // → both the adset (ADSET1) and the created campaign (CAMP1) must be deleted.
  const browser = makeBrowser({ adsetActivateError: true });
  await listen({ browser });
  const r = await req('POST', '/promote', promoteDaily());
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.step, 'adset_activate');
  // The copied adset is deleted.
  assert.ok(browser.calls.some((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /"status":"DELETED"/.test(String(c.body || ''))), 'orphan adset deleted');
  // The newly-created empty campaign is deleted too (no "ไม่มีโฆษณา" leftover).
  assert.ok(browser.calls.some((c) => /\/CAMP1\?/.test(c.url) && c.method === 'POST' && /"status":"DELETED"/.test(String(c.body || ''))), 'newly-created empty campaign deleted');
  assert.equal(r.body.cleaned_campaign_id, 'CAMP1', 'reports the cleaned-up campaign id');
  assert.equal(r.body.orphan_campaign_id, undefined, 'no orphan reported when cleanup succeeds');
  // Diagnostics carry the exact bridge ids (never a token).
  assert.equal(r.body.campaign_id, 'CAMP1');
  assert.equal(r.body.daily_campaign_name, '15/Jun/2026');
  assert.equal(r.body.template_adset, 'tpl_test');
  assertNoLeak(r.body);
});

test('POST /promote downstream failure does NOT delete a REUSED existing daily campaign', async () => {
  // The daily campaign already exists (CAMPDAILY) → the bridge REUSES it. A downstream failure must
  // delete only the copied adset, NEVER the shared existing campaign.
  const DAILY = '15/Jun/2026';
  const browser = makeBrowser({
    adsetActivateError: true,
    existingCampaigns: [{ id: 'CAMPDAILY', name: DAILY, status: 'ACTIVE', objective: 'OUTCOME_ENGAGEMENT' }]
  });
  await listen({ browser });
  const r = await req('POST', '/promote', promoteDaily());
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.step, 'adset_activate');
  // The copied adset is still cleaned up.
  assert.ok(browser.calls.some((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /"status":"DELETED"/.test(String(c.body || ''))), 'orphan adset deleted');
  // The reused campaign must NOT be deleted.
  assert.ok(!browser.calls.some((c) => /\/CAMPDAILY\?/.test(c.url) && c.method === 'POST' && /"status":"DELETED"/.test(String(c.body || ''))), 'reused existing campaign must NOT be deleted');
  assert.equal(r.body.cleaned_campaign_id, undefined, 'no campaign cleanup for a reused campaign');
  assert.equal(r.body.orphan_campaign_id, undefined);
  assert.equal(r.body.campaign_id, 'CAMPDAILY');
  assertNoLeak(r.body);
});

test('POST /promote reports orphan_campaign_id + campaign_cleanup_error when the campaign delete fails', async () => {
  // The activation errors (created daily campaign) AND the campaign delete itself errors → the
  // bridge surfaces orphan_campaign_id + campaign_cleanup_error so Hermes can clean it up manually.
  const browser = makeBrowser({ adsetActivateError: true, campaignDeleteError: true });
  await listen({ browser });
  const r = await req('POST', '/promote', promoteDaily());
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.step, 'adset_activate');
  assert.equal(r.body.orphan_campaign_id, 'CAMP1', 'reports the campaign that could not be deleted');
  assert.ok(r.body.campaign_cleanup_error, 'records why the campaign cleanup failed');
  assert.equal(r.body.cleaned_campaign_id, undefined, 'cleaned_campaign_id only on a successful delete');
  assertNoLeak(r.body);
});

test('POST /promote copy failure cleans up the newly-created campaign (no orphan before any adset)', async () => {
  // The adset copy fails BEFORE any adset exists. The bridge must still delete the campaign it
  // created this request (CAMP1) so no empty campaign is left behind.
  const browser = makeBrowser({ copyError: true });
  await listen({ browser });
  const r = await req('POST', '/promote', promoteDaily());
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.step, 'copy');
  // No adset was created, so only the created campaign needs cleanup.
  assert.ok(browser.calls.some((c) => /\/CAMP1\?/.test(c.url) && c.method === 'POST' && /"status":"DELETED"/.test(String(c.body || ''))), 'created campaign deleted after a copy failure');
  assert.equal(r.body.cleaned_campaign_id, 'CAMP1');
  assert.equal(r.body.template_adset, 'tpl_test');
  assertNoLeak(r.body);
});

// ── Recovery: a bad/orphan EMPTY reused daily campaign must not get the flow stuck ────────────
// Live symptom (history 28710): the bridge REUSED an existing 16/Jun/2026 daily campaign left
// empty/bad by prior failed runs; copying the template adset into it returned code=100
// subcode=1885272 "Invalid parameter". Because it was reused, prior cleanup left it in place and
// every retry hit the same wall. The fix: on a copy failure into a REUSED daily campaign, if that
// campaign has NO non-DELETED adsets, delete it and create a fresh duplicate, then retry once.

test('POST /promote recovers from a bad EMPTY reused daily campaign: deletes it, recreates, retries copy, succeeds', async () => {
  const DAILY = '15/Jun/2026';
  // The reused campaign CAMPDAILY rejects the copy (subcode 1885272) and has NO adsets (default []).
  const browser = makeBrowser({
    existingCampaigns: [{ id: 'CAMPDAILY', name: DAILY, status: 'ACTIVE', objective: 'OUTCOME_ENGAGEMENT' }],
    copyErrorForCampaign: 'CAMPDAILY'
    // reusedCampaignAdsets defaults to [] → empty → safe to delete + recreate
  });
  await listen({ browser });
  const r = await req('POST', '/promote', promoteDaily());
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, 'recovery retry succeeds so the whole flow succeeds');
  // The bad reused campaign was probed for adsets, then deleted, and a fresh duplicate was created.
  assert.ok(browser.calls.some((c) => /\/CAMPDAILY\/adsets\?fields=id,status,effective_status/.test(c.url) && c.method === 'GET'), 'probed the reused campaign for adsets');
  assert.ok(browser.calls.some((c) => /\/CAMPDAILY\?/.test(c.url) && c.method === 'POST' && /"status":"DELETED"/.test(String(c.body || ''))), 'deleted the bad empty reused campaign');
  const freshCampPost = browser.calls.find((c) => /\/campaigns\?/.test(c.url) && c.method === 'POST');
  assert.ok(freshCampPost, 'created a fresh duplicate daily campaign');
  assert.equal(JSON.parse(freshCampPost.body).name, DAILY, 'fresh campaign keeps the same daily name');
  assert.equal(JSON.parse(freshCampPost.body).objective, 'OUTCOME_ENGAGEMENT', 'fresh campaign keeps the template objective');
  // The copy was attempted TWICE: into CAMPDAILY (failed), then into the fresh CAMP1 (succeeded).
  const copyCalls = browser.calls.filter((c) => /\/copies/.test(c.url) && c.method === 'POST');
  assert.equal(copyCalls.length, 2, 'copy retried exactly once');
  assert.equal(JSON.parse(copyCalls[0].body).campaign_id, 'CAMPDAILY', 'first copy targeted the reused campaign');
  assert.equal(JSON.parse(copyCalls[1].body).campaign_id, 'CAMP1', 'retry copy targeted the fresh campaign');
  // Final entity lives in the fresh campaign; recovery diagnostics surfaced.
  assert.equal(r.body.campaign_id, 'CAMP1', 'the ad is built in the fresh campaign');
  assert.equal(r.body.recovered_from_bad_reused_campaign, true);
  assert.equal(r.body.bad_reused_campaign_id, 'CAMPDAILY');
  assert.equal(r.body.cleaned_bad_reused_campaign_id, 'CAMPDAILY');
  assert.equal(r.body.retry_campaign_id, 'CAMP1');
  // INVARIANTS intact: adset name = sub2, ad name = video hash, 24h schedule.
  const actPost = browser.calls.find((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /"status":"ACTIVE"/.test(String(c.body || '')));
  assert.equal(JSON.parse(actPost.body).name, '984409834561573', 'adset name invariant: post tail/sub2');
  assert.match(JSON.parse(actPost.body).end_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/, '24h offset ISO end_time');
  const adCreate = browser.calls.find((c) => /\/ads\?/.test(c.url) && c.method === 'POST');
  assert.equal(JSON.parse(adCreate.body).name, 'ea401f1e', 'ad name invariant: source video hash/code');
  assertNoLeak(r.body);
});

test('POST /promote does NOT delete a reused daily campaign that still has adsets; returns the copy error', async () => {
  const DAILY = '15/Jun/2026';
  const browser = makeBrowser({
    existingCampaigns: [{ id: 'CAMPDAILY', name: DAILY, status: 'ACTIVE', objective: 'OUTCOME_ENGAGEMENT' }],
    copyErrorForCampaign: 'CAMPDAILY',
    reusedCampaignAdsets: [{ id: 'EXISTINGADSET', status: 'ACTIVE', effective_status: 'ACTIVE' }]
  });
  await listen({ browser });
  const r = await req('POST', '/promote', promoteDaily());
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false, 'a non-empty reused campaign is not recovered — surfaces the copy error');
  assert.equal(r.body.step, 'copy');
  assert.equal(r.body.fb_error_subcode, 1885272, 'surfaces the original copy error subcode');
  assert.equal(r.body.reused_campaign_had_adsets, true);
  // Hard guarantee: the reused campaign was probed but NEVER deleted, and no fresh campaign created.
  assert.ok(browser.calls.some((c) => /\/CAMPDAILY\/adsets\?fields=id,status,effective_status/.test(c.url)), 'probed the reused campaign');
  assert.ok(!browser.calls.some((c) => /\/CAMPDAILY\?/.test(c.url) && c.method === 'POST' && /"status":"DELETED"/.test(String(c.body || ''))), 'must NOT delete a reused campaign that has adsets');
  assert.ok(!browser.calls.some((c) => /\/campaigns\?/.test(c.url) && c.method === 'POST'), 'must NOT create a fresh campaign');
  assert.equal(r.body.recovered_from_bad_reused_campaign, undefined);
  assertNoLeak(r.body);
});

test('POST /promote recovery: when the retry copy ALSO fails, cleans up the fresh campaign + reports diagnostics', async () => {
  const DAILY = '15/Jun/2026';
  // copyError errors EVERY copy (both the reused campaign and the fresh duplicate). Recovery still
  // deletes the empty reused campaign + creates the fresh one, but the retry copy fails → the fresh
  // campaign must be cleaned up and the recovery diagnostics surfaced.
  const browser = makeBrowser({
    existingCampaigns: [{ id: 'CAMPDAILY', name: DAILY, status: 'ACTIVE', objective: 'OUTCOME_ENGAGEMENT' }],
    copyError: true
  });
  await listen({ browser });
  const r = await req('POST', '/promote', promoteDaily());
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.step, 'copy');
  // The bad empty reused campaign was deleted and a fresh duplicate (CAMP1) was created + cleaned up.
  assert.ok(browser.calls.some((c) => /\/CAMPDAILY\?/.test(c.url) && c.method === 'POST' && /"status":"DELETED"/.test(String(c.body || ''))), 'deleted the bad empty reused campaign');
  assert.ok(browser.calls.some((c) => /\/CAMP1\?/.test(c.url) && c.method === 'POST' && /"status":"DELETED"/.test(String(c.body || ''))), 'cleaned up the fresh campaign after the retry copy failed');
  assert.equal(r.body.recovered_from_bad_reused_campaign, true);
  assert.equal(r.body.bad_reused_campaign_id, 'CAMPDAILY');
  assert.equal(r.body.cleaned_bad_reused_campaign_id, 'CAMPDAILY');
  assert.equal(r.body.retry_campaign_id, 'CAMP1');
  assert.equal(r.body.cleaned_campaign_id, 'CAMP1', 'fresh campaign cleaned via failCleanup');
  assertNoLeak(r.body);
});

test('POST /promote recovery: reports bad_reused_campaign_cleanup_error when the bad campaign delete fails', async () => {
  const DAILY = '15/Jun/2026';
  // The reused campaign is empty but its DELETE fails; recovery still proceeds to recreate + retry,
  // and surfaces bad_reused_campaign_cleanup_error so Hermes can clean it up manually.
  const browser = makeBrowser({
    existingCampaigns: [{ id: 'CAMPDAILY', name: DAILY, status: 'ACTIVE', objective: 'OUTCOME_ENGAGEMENT' }],
    copyErrorForCampaign: 'CAMPDAILY',
    campaignDeleteError: 'CAMPDAILY'
  });
  await listen({ browser });
  const r = await req('POST', '/promote', promoteDaily());
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, 'the retry into the fresh campaign still succeeds');
  assert.equal(r.body.recovered_from_bad_reused_campaign, true);
  assert.equal(r.body.bad_reused_campaign_id, 'CAMPDAILY');
  assert.ok(r.body.bad_reused_campaign_cleanup_error, 'records why the bad campaign delete failed');
  assert.equal(r.body.cleaned_bad_reused_campaign_id, undefined, 'cleaned id only on a successful delete');
  assert.equal(r.body.retry_campaign_id, 'CAMP1');
  assertNoLeak(r.body);
});

// ── Template parity: customer-lifecycle / campaign-level setup ───────────────────────────────
// The live gap: the new ad/adset did NOT carry the template's customer-lifecycle strategy
// ("รับคอนเวอร์ชั่นจากกลุ่มเป้าหมายทั้งหมด" / "Reach new and existing customers"). Per Meta's
// Marketing API this strategy lives on the AD SET (existing_customer_budget_percentage); the
// daily campaign is created fresh (dropping campaign-level mirror fields), and deep_copy:false was
// observed to drop the adset strategy — so the bridge mirrors the template campaign's safe fields
// onto the new daily campaign AND re-applies the template adset's customer-lifecycle strategy onto
// the copied adset, reporting both under copied_template_settings for live verification.

test('POST /create-ad mirrors the template campaign setting into the new daily campaign + reports diagnostics', async () => {
  const browser = makeBrowser({ templateSmartPromotionType: 'SMART_PROMOTION', templateCampaignId: '120248134990220263' });
  await listen({ browser });
  const r = await req('POST', '/create-ad', {
    page_id: LIVE_PAGE_ID,
    video_url: 'https://cdn/example.mp4',
    caption: 'cap',
    shortlink: 'https://s.shopee.co.th/x',
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    daily_campaign_name: '15/Jun/2026'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  // The template settings were read in ONE GET on the template adset (objective + campaign-level
  // mirror fields + adset-level lifecycle fields).
  assert.ok(browser.calls.some((c) => /fields=existing_customer_budget_percentage/.test(c.url) && /campaign\{id,objective,smart_promotion_type\}/.test(c.url) && c.method === 'GET'), 'template settings read in one GET');
  // The new daily campaign POST carries the mirrored template campaign field AND the CAMPAIGN-level
  // (CBO) budget + bid strategy (the operator's Ads Manager template).
  const campPost = browser.calls.find((c) => /\/campaigns\?/.test(c.url) && c.method === 'POST');
  assert.ok(campPost, 'a daily campaign was created');
  const campBody = JSON.parse(campPost.body);
  assert.equal(campBody.smart_promotion_type, 'SMART_PROMOTION', 'daily campaign mirrors the template campaign setting');
  assert.equal(campBody.objective, 'OUTCOME_ENGAGEMENT', 'daily campaign keeps the template objective');
  assert.equal(campBody.daily_budget, '1000000', 'daily campaign carries the CBO budget');
  assert.equal(campBody.bid_strategy, 'LOWEST_COST_WITHOUT_CAP', 'daily campaign uses the CBO bid strategy');
  // Diagnostics for Hermes live-verification.
  assert.equal(r.body.template_campaign_id, '120248134990220263');
  assert.equal(r.body.copied_template_settings.campaign.applied, true);
  assert.equal(r.body.copied_template_settings.campaign.fields.smart_promotion_type, 'SMART_PROMOTION');
  assertNoLeak(r.body);
});

test('POST /promote re-applies the template adset customer-lifecycle strategy to the COPIED adset (invariants intact)', async () => {
  // existing_customer_budget_percentage:0 = "Acquire new customers only" — re-applied to the copy.
  const browser = makeBrowser({ templateExistingCustomerPct: 0 });
  await listen({ browser });
  const r = await req('POST', '/promote', promoteDaily());
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  // A dedicated POST re-applied the customer-lifecycle field to the copied adset (ADSET1).
  const lifePost = browser.calls.find((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /existing_customer_budget_percentage/.test(String(c.body || '')));
  assert.ok(lifePost, 'customer-lifecycle re-applied to the copied adset');
  const lifeBody = JSON.parse(lifePost.body);
  assert.deepEqual(Object.keys(lifeBody), ['existing_customer_budget_percentage'], 'lifecycle POST carries ONLY the lifecycle field');
  assert.equal(lifeBody.existing_customer_budget_percentage, 0, 're-applies the exact template percentage');
  assert.equal(r.body.copied_template_settings.adset.applied, true);
  assert.equal(r.body.copied_template_settings.adset.fields.existing_customer_budget_percentage, 0);
  // INVARIANTS unchanged: NO per-adset budget POST (CBO is on the campaign), schedule offset-ISO
  // end_time, adset name = sub2, ad name = source video hash/code.
  assert.ok(!browser.calls.some((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /daily_budget/.test(String(c.body || ''))), 'no per-adset daily_budget POST');
  const actPost = browser.calls.find((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /"status":"ACTIVE"/.test(String(c.body || '')));
  assert.match(JSON.parse(actPost.body).end_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/, 'activation end_time is an offset ISO string');
  assert.equal(JSON.parse(actPost.body).name, '984409834561573', 'adset name invariant: post tail/sub2');
  const adCreate = browser.calls.find((c) => /\/ads\?/.test(c.url) && c.method === 'POST');
  assert.equal(JSON.parse(adCreate.body).name, 'ea401f1e', 'ad name invariant: source video hash/code');
  assertNoLeak(r.body);
});

test('POST /promote fails SOFT when the customer-lifecycle re-apply errors (ad still created, diagnostic records it)', async () => {
  const browser = makeBrowser({ templateExistingCustomerPct: 50, adsetLifecycleError: true });
  await listen({ browser });
  const r = await req('POST', '/promote', promoteDaily());
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, 'a lifecycle re-apply failure must NOT fail the whole flow (not explicitly required)');
  assert.equal(r.body.ad_id, 'AD1', 'the ad is still created');
  assert.equal(r.body.copied_template_settings.adset.applied, false);
  assert.ok(r.body.copied_template_settings.adset.error, 'records the lifecycle apply error for verification');
  assert.equal(r.body.copied_template_settings.adset.fields.existing_customer_budget_percentage, 50);
  assertNoLeak(r.body);
});

test('POST /promote does NOT mirror when the template carries no lifecycle/strategy fields (no extra POST, applied:false)', async () => {
  const browser = makeBrowser(); // default template: no smart_promotion_type, no existing_customer_budget_percentage
  await listen({ browser });
  const r = await req('POST', '/promote', promoteDaily());
  assert.equal(r.body.ok, true);
  const campPost = browser.calls.find((c) => /\/campaigns\?/.test(c.url) && c.method === 'POST');
  assert.equal(JSON.parse(campPost.body).smart_promotion_type, undefined, 'no campaign mirror field when template has none');
  assert.ok(!browser.calls.some((c) => /\/ADSET1\?/.test(c.url) && c.method === 'POST' && /existing_customer_budget_percentage/.test(String(c.body || ''))), 'no lifecycle re-apply POST when template carries none');
  assert.equal(r.body.copied_template_settings.campaign.applied, false);
  assert.equal(r.body.copied_template_settings.adset.applied, false);
  assert.equal(r.body.template_campaign_id, 'TPLCAMP1', 'still reports the template campaign id for verification');
  assertNoLeak(r.body);
});

test('POST /promote reports campaign mirror applied:false + reuse when an existing daily campaign is reused', async () => {
  const DAILY = '15/Jun/2026';
  const browser = makeBrowser({
    templateSmartPromotionType: 'SMART_PROMOTION',
    existingCampaigns: [{ id: 'CAMPDAILY', name: DAILY, status: 'ACTIVE', objective: 'OUTCOME_ENGAGEMENT' }]
  });
  await listen({ browser });
  const r = await req('POST', '/promote', promoteDaily());
  assert.equal(r.body.ok, true);
  assert.equal(r.body.campaign_id, 'CAMPDAILY', 'reused the existing daily campaign');
  assert.ok(!browser.calls.some((c) => /\/campaigns\?/.test(c.url) && c.method === 'POST'), 'no campaign created on reuse → no campaign-level mirror possible');
  assert.equal(r.body.copied_template_settings.campaign.applied, false, 'cannot mirror campaign settings onto a reused campaign');
  assert.equal(r.body.copied_template_settings.campaign.reuse, 'reused_existing_campaign');
  assertNoLeak(r.body);
});

test('endpoints exist (no 404) for the Worker contract surface', async () => {
  await listen();
  for (const [method, path] of [['GET', '/token'], ['GET', '/pages']]) {
    const r = await req(method, path);
    assert.notEqual(r.status, 404, `${method} ${path} must exist`);
  }
});

// ---------------------------------------------------------------------------
// advideos DIRECT multipart upload (the cheiab/OneCard incident: Meta returns
// "Unable to fetch video file from URL" for Worker public asset URLs it cannot reach).
// The bridge now downloads the video itself and uploads it as multipart/form-data as the
// PRIMARY path, so Meta never has to fetch our URL. file_url is only a last-resort fallback
// when the local download cannot proceed (download/fetch failure or the byte-ceiling guard).
// ---------------------------------------------------------------------------
const posting = require('../src/posting');
const UPLOAD_TOKEN = 'EAAB_UPLOAD_SECRET';

// A Graph transport mock that distinguishes the file_url advideos POST from the
// multipart advideos POST and records every call (body/headers) for assertions.
function makeUploadFetch(opts = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    const ct = (init.headers && (init.headers['Content-Type'] || init.headers['content-type'])) || '';
    const isMultipart = /multipart\/form-data/.test(String(ct));
    calls.push({ url: u, method, isMultipart, body: init.body, contentType: String(ct) });
    let obj = { success: true };
    if (/\/advideos\?/.test(u) && method === 'POST') {
      if (/[?&]file_url=/.test(u) && !isMultipart) {
        obj = opts.fileUrlResponse || { id: 'VID_FILEURL' };
      } else if (isMultipart) {
        obj = opts.multipartResponse || { id: 'VID_MULTIPART' };
      }
    }
    return { status: 200, ok: !obj.error, json: async () => obj };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('buildVideoMultipart: wraps bytes as a `source` file part with a matching boundary', () => {
  const bytes = Buffer.from('FAKEMP4BYTES');
  const part = posting.buildVideoMultipart({ buffer: bytes, filename: 'clip.mp4', contentType: 'video/mp4' });
  const m = /boundary=(.+)$/.exec(part.contentType);
  assert.ok(m, 'content-type carries a boundary');
  const text = part.body.toString('utf8');
  assert.ok(text.includes(`--${m[1]}`), 'body opens with the boundary');
  assert.ok(text.includes('name="source"'), 'uses the Graph advideos file field `source`');
  assert.ok(text.includes('filename="clip.mp4"'));
  assert.ok(text.includes('FAKEMP4BYTES'), 'the video bytes are embedded');
  assert.ok(text.trimEnd().endsWith(`--${m[1]}--`), 'body closes with the terminating boundary');
});

test('uploadAdVideoFromUrl (1): downloads + uploads multipart FIRST and never calls file_url', async () => {
  const fetchImpl = makeUploadFetch({ multipartResponse: { id: 'VID_OK' } });
  const downloadCalls = [];
  const download = async (url, dlOpts) => { downloadCalls.push({ url, dlOpts }); return { buffer: Buffer.from('REALBYTES'), contentType: 'video/mp4' }; };
  const out = await posting.uploadAdVideoFromUrl(fetchImpl, {
    adAccount: 'act_1', userToken: UPLOAD_TOKEN, videoUrl: 'https://api.pubilo.com/asset.mp4', download
  });
  assert.equal(out.data.id, 'VID_OK', 'uploaded via the direct multipart path');
  assert.equal(out.uploadMode, 'multipart');
  assert.equal(downloadCalls.length, 1, 'downloaded the video once (primary path)');
  assert.equal(downloadCalls[0].url, 'https://api.pubilo.com/asset.mp4');
  assert.equal(fetchImpl.calls.length, 1, 'exactly one Graph upload call');
  const multipartCall = fetchImpl.calls[0];
  assert.ok(multipartCall.isMultipart, 'the single upload is multipart');
  assert.ok(!fetchImpl.calls.some((c) => /file_url=/.test(c.url)), 'NEVER calls advideos with file_url on the primary path');
  assert.ok(/access_token=/.test(multipartCall.url), 'token stays in the URL, not the multipart body');
  assert.ok(!String(multipartCall.body.toString('utf8')).includes(UPLOAD_TOKEN), 'token never embedded in the multipart body');
});

test('uploadAdVideoFromUrl (2): a real Graph error from multipart is returned as-is and does NOT fall back to file_url', async () => {
  // A validation/permission error from the multipart upload must surface unchanged — never masked by
  // a file_url retry (guards against random fallback loops hiding real errors).
  const fetchImpl = makeUploadFetch({
    multipartResponse: { error: { message: 'Invalid parameter', code: 100, error_subcode: 1487390 } }
  });
  const download = async () => ({ buffer: Buffer.from('REALBYTES'), contentType: 'video/mp4' });
  const out = await posting.uploadAdVideoFromUrl(fetchImpl, {
    adAccount: 'act_1', userToken: UPLOAD_TOKEN, videoUrl: 'https://api.pubilo.com/asset.mp4', download
  });
  assert.ok(out.data.error, 'the Graph error is preserved');
  assert.equal(out.data.error.message, 'Invalid parameter');
  assert.equal(out.uploadMode, 'multipart', 'still reports the multipart transport (no fallback)');
  assert.ok(!fetchImpl.calls.some((c) => /file_url=/.test(c.url)), 'must NOT retry via file_url after a real Graph error');
  assert.equal(fetchImpl.calls.filter((c) => !c.isMultipart).length, 0, 'the only upload attempt was multipart');
});

test('uploadAdVideoFromUrl (3): download failure FALLS BACK to file_url and succeeds', async () => {
  const fetchImpl = makeUploadFetch({ fileUrlResponse: { id: 'VID_VIA_FILEURL' } });
  const download = async () => { throw new Error('video_download_http_503'); };
  const out = await posting.uploadAdVideoFromUrl(fetchImpl, {
    adAccount: 'act_1', userToken: UPLOAD_TOKEN, videoUrl: 'https://api.pubilo.com/asset.mp4', download
  });
  assert.equal(out.data.id, 'VID_VIA_FILEURL', 'recovered via the file_url fallback');
  assert.equal(out.uploadMode, 'file_url_fallback');
  assert.equal(fetchImpl.calls.length, 1, 'exactly one Graph upload call (the file_url fallback)');
  assert.ok(/file_url=/.test(fetchImpl.calls[0].url), 'the fallback uses file_url');
  assert.equal(fetchImpl.calls.filter((c) => c.isMultipart).length, 0, 'no multipart upload when the download failed');
});

test('uploadAdVideoFromUrl (4): download too-large + file_url ALSO fails surfaces a clear non-secret error', async () => {
  const fetchImpl = makeUploadFetch({
    fileUrlResponse: { error: { message: 'Unable to fetch video file from URL.', code: 100, error_subcode: 1363030, fbtrace_id: 'TRACE9' } }
  });
  const download = async () => { throw new Error('video_too_large_999999999_bytes_max_209715200'); };
  const out = await posting.uploadAdVideoFromUrl(fetchImpl, {
    adAccount: 'act_1', userToken: UPLOAD_TOKEN, videoUrl: 'https://api.pubilo.com/huge.mp4', download
  });
  assert.equal(out.uploadMode, 'file_url_fallback');
  assert.ok(out.data.error, 'returns an error when both paths fail');
  assert.ok(String(out.data.error.message).includes('multipart_download_unavailable'), 'explains the download could not proceed');
  assert.ok(String(out.data.error.message).includes('video_too_large'), 'carries the download guard reason');
  assert.ok(String(out.data.error.message).includes('Unable to fetch video file from URL'), 'carries the file_url error too');
  assert.equal(out.data.error.fbtrace_id, 'TRACE9', 'preserves the file_url Graph trace id');
  assert.ok(!String(JSON.stringify(out)).includes(UPLOAD_TOKEN), 'no token leak in the error');
  assert.equal(fetchImpl.calls.filter((c) => c.isMultipart).length, 0, 'no multipart upload attempted when the download failed');
});

test('downloadVideoToBuffer: enforces the byte ceiling via content-length (fails closed)', async () => {
  const fakeFetch = async () => ({
    status: 200, ok: true,
    headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(500 * 1024 * 1024) : 'video/mp4') },
    arrayBuffer: async () => new ArrayBuffer(8)
  });
  await assert.rejects(
    () => posting.downloadVideoToBuffer('https://api.pubilo.com/huge.mp4', { fetchImpl: fakeFetch, maxBytes: 200 * 1024 * 1024 }),
    /video_too_large/
  );
});

test('downloadVideoToBuffer: returns the buffer + content-type on a normal 200', async () => {
  const payload = Buffer.from('SMALLMP4');
  const fakeFetch = async () => ({
    status: 200, ok: true,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'video/mp4; charset=binary' : null) },
    arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
  });
  const out = await posting.downloadVideoToBuffer('https://api.pubilo.com/ok.mp4', { fetchImpl: fakeFetch });
  assert.equal(out.contentType, 'video/mp4', 'content-type is normalized (params stripped)');
  assert.equal(out.buffer.toString('utf8'), 'SMALLMP4');
});

test('downloadVideoToBuffer: non-2xx download fails closed', async () => {
  const fakeFetch = async () => ({ status: 404, ok: false, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) });
  await assert.rejects(
    () => posting.downloadVideoToBuffer('https://r2.dev/missing.mp4', { fetchImpl: fakeFetch }),
    /video_download_http_404/
  );
});

// Shared Graph mock for a full createAd run. `onAdvideos(isMultipart)` decides what the advideos
// upload returns, so each test can drive the multipart-primary path or a file_url fallback. Records
// every advideos call so tests can assert which transport was used.
function makeCreateAdFetch(onAdvideos) {
  const advideosCalls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    const ct = (init.headers && (init.headers['Content-Type'] || init.headers['content-type'])) || '';
    const isMultipart = /multipart\/form-data/.test(String(ct));
    let obj = { success: true };
    if (/\/advideos\?/.test(u) && method === 'POST') {
      advideosCalls.push({ url: u, isMultipart });
      obj = onAdvideos(isMultipart, u);
    } else if (/me\/accounts/.test(u)) obj = { data: [{ id: '107267395614980', name: 'P', access_token: 'PAGE_TOK' }] };
    else if (/fields=thumbnails/.test(u)) obj = { thumbnails: { data: [{ uri: 'https://thumb/x.jpg' }] } };
    else if (/\/adcreatives/.test(u) && method === 'POST') obj = { id: 'CR1' };
    else if (/fields=effective_object_story_id/.test(u)) obj = { effective_object_story_id: '107267395614980_STORY9' };
    else if (/\/ads\?fields=creative/.test(u)) obj = { data: [{ creative: { id: 'TPLCR' } }] };
    else if (/TPLCR\?fields=call_to_action_type/.test(u)) obj = { call_to_action_type: 'SHOP_NOW' };
    else if (/fields=existing_customer_budget_percentage/.test(u)) obj = { campaign: { id: 'TPLCAMP', objective: 'OUTCOME_ENGAGEMENT' } };
    else if (/\/campaigns\?.*filtering/.test(u) && method === 'GET') obj = { data: [] };
    else if (/\/campaigns\?/.test(u) && method === 'POST') obj = { id: 'CAMP1' };
    else if (/\/copies/.test(u) && method === 'POST') obj = { copied_adset_id: 'ADSET1' };
    else if (/\/ads\?fields=id/.test(u) && method === 'GET') obj = { data: [{ id: 'AD1' }] };
    else if (/\/ads\?/.test(u) && method === 'POST') obj = { id: 'AD1' };
    return { status: 200, ok: !obj.error, json: async () => obj };
  };
  fetchImpl.advideosCalls = advideosCalls;
  return fetchImpl;
}

test('createAd: video upload uses multipart FIRST and never calls advideos with file_url', async () => {
  // The live-safe path — Meta never has to fetch our URL. The injected downloader supplies the bytes
  // and the direct multipart upload succeeds; the success response carries upload_mode=multipart.
  const fetchImpl = makeCreateAdFetch((isMultipart) => (isMultipart ? { id: 'VIDMULTI' } : { error: { message: 'Unable to fetch video file from URL.', code: 100 } }));
  const download = async () => ({ buffer: Buffer.from('REALBYTES'), contentType: 'video/mp4' });
  const result = await posting.createAd(fetchImpl, {
    userToken: UPLOAD_TOKEN,
    body: { page_id: '107267395614980', video_url: 'https://api.pubilo.com/asset.mp4', caption: 'cap', shopee_url: 'https://shopee.co.th/x', ad_account: 'act_test', template_adset: 'tpl_test' },
    pollMs: 0,
    downloadVideo: download
  });
  assert.equal(result.ok, true);
  assert.equal(result.video_id, 'VIDMULTI', 'used the multipart-uploaded video');
  assert.equal(result.upload_mode, 'multipart', 'reports the primary multipart upload mode');
  assert.equal(fetchImpl.advideosCalls.length, 1, 'exactly one advideos upload');
  assert.ok(fetchImpl.advideosCalls[0].isMultipart, 'the upload was multipart');
  assert.ok(!fetchImpl.advideosCalls.some((c) => /file_url=/.test(c.url)), 'NEVER calls advideos with file_url');
  assert.ok(!JSON.stringify(result).includes(UPLOAD_TOKEN), 'no token leak');
});

test('createAd: skip_publish_to_page (Instagram) path maps upload_mode to the multipart-based mode', async () => {
  const fetchImpl = makeCreateAdFetch((isMultipart) => (isMultipart ? { id: 'VIDIG' } : { error: { message: 'should not be called', code: 100 } }));
  const download = async () => ({ buffer: Buffer.from('REALBYTES'), contentType: 'video/mp4' });
  const result = await posting.createAd(fetchImpl, {
    userToken: UPLOAD_TOKEN,
    body: { page_id: '107267395614980', video_url: 'https://api.pubilo.com/asset.mp4', caption: 'cap', shopee_url: 'https://shopee.co.th/x', ad_account: 'act_test', template_adset: 'tpl_test', skip_publish_to_page: true },
    pollMs: 0,
    downloadVideo: download
  });
  assert.equal(result.ok, true);
  assert.equal(result.video_id, 'VIDIG', 'used the multipart-uploaded video on the IG path');
  assert.equal(result.upload_mode, 'instagram_advideo_multipart', 'IG path reports the multipart-based mode');
  assert.ok(fetchImpl.advideosCalls.length >= 1 && fetchImpl.advideosCalls.every((c) => c.isMultipart), 'every advideos upload was multipart');
  assert.ok(!fetchImpl.advideosCalls.some((c) => /file_url=/.test(c.url)), 'IG path never calls advideos with file_url');
  assert.ok(!JSON.stringify(result).includes(UPLOAD_TOKEN), 'no token leak');
});

test('createAd: download failure falls back to file_url and reports the fallback upload_mode', async () => {
  // When the bridge cannot download, file_url is the last resort; the success response reports it.
  const fetchImpl = makeCreateAdFetch((isMultipart) => (isMultipart ? { error: { message: 'should not be called', code: 100 } } : { id: 'VIDFILEURL' }));
  const download = async () => { throw new Error('video_download_http_503'); };
  const result = await posting.createAd(fetchImpl, {
    userToken: UPLOAD_TOKEN,
    body: { page_id: '107267395614980', video_url: 'https://api.pubilo.com/asset.mp4', caption: 'cap', shopee_url: 'https://shopee.co.th/x', ad_account: 'act_test', template_adset: 'tpl_test' },
    pollMs: 0,
    downloadVideo: download
  });
  assert.equal(result.ok, true);
  assert.equal(result.video_id, 'VIDFILEURL', 'used the file_url fallback video');
  assert.equal(result.upload_mode, 'file_url_fallback', 'reports the fallback upload mode');
  assert.equal(fetchImpl.advideosCalls.length, 1, 'one advideos upload (the file_url fallback)');
  assert.ok(/file_url=/.test(fetchImpl.advideosCalls[0].url), 'the fallback used file_url');
  assert.ok(!JSON.stringify(result).includes(UPLOAD_TOKEN), 'no token leak');
});

// ---------------------------------------------------------------------------
// FALSE-SUCCESS PAGE-PUBLISH GUARDS
// Regression for the live incident: a page post recorded as success while the Facebook feed
// never showed it. publishStoryToPage used to treat a transient Graph publish error (code 1 /
// "please reduce the amount of data") as published; createAd then returned ok:true and the
// Worker recorded a visible-post success for a post that does not exist on the page feed.
// ---------------------------------------------------------------------------

const PUBLISH_PAGE_TOKEN = 'PUBLISH_PAGE_SECRET';

// Graph fetch mock for the direct posting.* unit tests with controllable PAGE-PUBLISH behavior.
//   opts.publishError → every is_published POST returns a Graph error (default code 1 transient shape)
//   opts.publishFailTimes → only the FIRST N publish POSTs error, then a retry succeeds
//   opts.publishErrorCode / publishErrorMessage → override the simulated error
//   opts.readbackPublished → the token-free is_published readback reports the post actually landed
//   opts.readbackPermalink → the readback also returns a permalink_url
function makePublishAwareFetch(opts = {}) {
  const calls = [];
  let publishPostCount = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    const body = init && init.body != null ? String(init.body) : '';
    calls.push({ url: u, method, body });
    let obj = { success: true };
    if (method === 'POST' && /is_published/.test(body)) {
      publishPostCount += 1;
      const failTimes = opts.publishFailTimes != null ? opts.publishFailTimes : (opts.publishError ? Infinity : 0);
      obj = publishPostCount <= failTimes
        ? { error: { message: opts.publishErrorMessage || 'please reduce the amount of data', code: opts.publishErrorCode != null ? opts.publishErrorCode : 1 } }
        : { success: true };
    } else if (method === 'GET' && /fields=is_published\b/.test(u)) {
      obj = { is_published: opts.readbackPublished === true, ...(opts.readbackPermalink ? { permalink_url: opts.readbackPermalink } : {}) };
    } else if (/\/advideos\?/.test(u) && method === 'POST') obj = { id: 'VID123' };
    else if (/me\/accounts/.test(u)) obj = { data: [{ id: '107267395614980', name: 'P', access_token: PUBLISH_PAGE_TOKEN }] };
    else if (/fields=thumbnails/.test(u)) obj = { thumbnails: { data: [{ uri: 'https://thumb/x.jpg' }] } };
    else if (/\/adcreatives/.test(u) && method === 'POST') obj = { id: 'CR1' };
    else if (/fields=effective_object_story_id/.test(u)) obj = { effective_object_story_id: '107267395614980_STORY9' };
    else if (/\/ads\?fields=creative/.test(u)) obj = { data: [{ creative: { id: 'TPLCR' } }] };
    else if (/TPLCR\?fields=call_to_action_type/.test(u)) obj = { call_to_action_type: 'SHOP_NOW' };
    else if (/fields=existing_customer_budget_percentage/.test(u)) obj = { campaign: { id: 'TPLCAMP', objective: 'OUTCOME_ENGAGEMENT' } };
    else if (/\/campaigns\?.*filtering/.test(u) && method === 'GET') obj = { data: [] };
    else if (/\/campaigns\?/.test(u) && method === 'POST') obj = { id: 'CAMP1' };
    else if (/\/copies/.test(u) && method === 'POST') obj = { copied_adset_id: 'ADSET1' };
    else if (/\/ads\?fields=id/.test(u) && method === 'GET') obj = { data: [{ id: 'AD1' }] };
    else if (/\/ads\?/.test(u) && method === 'POST') obj = { id: 'AD1' };
    return { status: 200, ok: !obj.error, json: async () => obj };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('publishStoryToPage: a transient publish error that never clears FAILS CLOSED after exhausting retries', async () => {
  const fetchImpl = makePublishAwareFetch({ publishError: true, readbackPublished: false });
  const res = await posting.publishStoryToPage(fetchImpl, {
    userToken: USER_TOKEN_SECRET, pageId: '107267395614980', storyId: '107267395614980_STORY9', pollMs: 0
  });
  assert.equal(res.publishedToPage, false, 'errored publish without a confirming readback is NOT published');
  assert.ok(res.publishError, 'carries the publish error for diagnosis');
  assert.equal(res.publishExhaustedRetries, true, 'flags that bounded retries were exhausted');
  // It RETRIED the publish (default 4 attempts) instead of giving up after one.
  const publishPosts = fetchImpl.calls.filter((c) => c.method === 'POST' && /is_published/.test(c.body));
  assert.equal(publishPosts.length, 4, 'made the full set of publish attempts');
  // It must actually READ BACK is_published before deciding — never assume.
  assert.ok(fetchImpl.calls.some((c) => c.method === 'GET' && /fields=is_published/.test(c.url)), 'performed the is_published readback');
  assert.ok(!JSON.stringify(res).includes(PUBLISH_PAGE_TOKEN), 'no page token leak');
});

test('publishStoryToPage: a transient publish error RECOVERS on retry (the live remedy for "reduce the amount of data")', async () => {
  // The first two publish POSTs return the transient code 1 error; the third succeeds — exactly the
  // FAIL→SUCCESS-on-retry shape the Worker documents for this message.
  const fetchImpl = makePublishAwareFetch({ publishFailTimes: 2, readbackPublished: false });
  const res = await posting.publishStoryToPage(fetchImpl, {
    userToken: USER_TOKEN_SECRET, pageId: '107267395614980', storyId: '107267395614980_STORY9', pollMs: 0
  });
  assert.equal(res.publishedToPage, true, 'a retry that succeeds publishes the visible post');
  assert.equal(res.publishAttempts, 3, 'succeeded on the third attempt');
  assert.ok(!JSON.stringify(res).includes(PUBLISH_PAGE_TOKEN), 'no page token leak');
});

test('publishStoryToPage: a transient publish error becomes success when a between-retry readback confirms is_published', async () => {
  const fetchImpl = makePublishAwareFetch({ publishError: true, readbackPublished: true, readbackPermalink: 'https://www.facebook.com/reel/123/' });
  const res = await posting.publishStoryToPage(fetchImpl, {
    userToken: USER_TOKEN_SECRET, pageId: '107267395614980', storyId: '107267395614980_STORY9', pollMs: 0
  });
  assert.equal(res.publishedToPage, true, 'readback-confirmed publish is reported as published');
  assert.equal(res.publishWarning, 'publish_story_error_but_readback_confirmed_published');
  assert.equal(res.permalink_url, 'https://www.facebook.com/reel/123/', 'surfaces the confirmed permalink');
  // The readback confirmed it on the FIRST errored attempt — no need to exhaust retries.
  assert.equal(res.publishAttempts, 1);
  assert.ok(!JSON.stringify(res).includes(PUBLISH_PAGE_TOKEN), 'no page token leak');
});

test('publishStoryToPage: a HARD (non-transient) publish error does NOT retry and fails closed immediately', async () => {
  // A permission error (code 200) will not clear on retry — fail closed after a single attempt.
  const fetchImpl = makePublishAwareFetch({ publishError: true, publishErrorCode: 200, publishErrorMessage: 'Permissions error', readbackPublished: false });
  const res = await posting.publishStoryToPage(fetchImpl, {
    userToken: USER_TOKEN_SECRET, pageId: '107267395614980', storyId: '107267395614980_STORY9', pollMs: 0
  });
  assert.equal(res.publishedToPage, false);
  assert.equal(res.publishAttempts, 1, 'a hard error is not retried');
  assert.notEqual(res.publishExhaustedRetries, true, 'did not loop through retries for a hard error');
  const publishPosts = fetchImpl.calls.filter((c) => c.method === 'POST' && /is_published/.test(c.body));
  assert.equal(publishPosts.length, 1, 'exactly one publish attempt for a hard error');
  assert.ok(!JSON.stringify(res).includes(PUBLISH_PAGE_TOKEN), 'no page token leak');
});

test('createAd skip_ad: FAILS CLOSED (step=publish) when publishStoryToPage fails and the readback does not confirm', async () => {
  const fetchImpl = makePublishAwareFetch({ publishError: true, readbackPublished: false });
  const result = await posting.createAd(fetchImpl, {
    userToken: USER_TOKEN_SECRET,
    body: { page_id: '107267395614980', video_url: 'https://cdn/x.mp4', caption: 'cap', shortlink: 'https://s.shopee.co.th/x', shopee_url: 'https://shopee.co.th/x', ad_account: 'act_test', template_adset: 'tpl_test', skip_ad: true },
    pollMs: 0,
    downloadVideo: async () => ({ buffer: Buffer.from('REALBYTES'), contentType: 'video/mp4' })
  });
  assert.equal(result.ok, false, 'must NOT report success when the page publish was not confirmed');
  assert.equal(result.step, 'publish');
  assert.equal(result.published_to_page, false);
  assert.ok(result.publish_error, 'surfaces publish_error for history');
  assert.equal(result.story_id, '107267395614980_STORY9', 'still surfaces the story id for diagnosis');
  // Hard guarantee: no campaign/adset/ad created in skip_ad mode even on failure.
  assert.ok(!fetchImpl.calls.some((c) => /\/copies/.test(c.url)), 'no adset copied');
  assert.ok(!JSON.stringify(result).includes(PUBLISH_PAGE_TOKEN), 'no page token leak');
});

test('createAd skip_ad: SUCCESS when the page publish is confirmed', async () => {
  const fetchImpl = makePublishAwareFetch({ publishError: false });
  const result = await posting.createAd(fetchImpl, {
    userToken: USER_TOKEN_SECRET,
    body: { page_id: '107267395614980', video_url: 'https://cdn/x.mp4', caption: 'cap', shortlink: 'https://s.shopee.co.th/x', shopee_url: 'https://shopee.co.th/x', ad_account: 'act_test', template_adset: 'tpl_test', skip_ad: true },
    pollMs: 0,
    downloadVideo: async () => ({ buffer: Buffer.from('REALBYTES'), contentType: 'video/mp4' })
  });
  assert.equal(result.ok, true);
  assert.equal(result.phase, 'post');
  assert.equal(result.published_to_page, true);
  assert.ok(!JSON.stringify(result).includes(PUBLISH_PAGE_TOKEN), 'no page token leak');
});

test('createAd full: FAILS CLOSED (step=publish) when publishStoryToPage fails for the visible page post', async () => {
  const fetchImpl = makePublishAwareFetch({ publishError: true, readbackPublished: false });
  const result = await posting.createAd(fetchImpl, {
    userToken: USER_TOKEN_SECRET,
    body: { page_id: '107267395614980', video_url: 'https://cdn/x.mp4', caption: 'cap', shortlink: 'https://s.shopee.co.th/x', shopee_url: 'https://shopee.co.th/x', ad_account: 'act_test', template_adset: 'tpl_test' },
    pollMs: 0,
    downloadVideo: async () => ({ buffer: Buffer.from('REALBYTES'), contentType: 'video/mp4' })
  });
  assert.equal(result.ok, false, 'a full create-ad must not claim success when the page publish failed');
  assert.equal(result.step, 'publish');
  assert.equal(result.published_to_page, false);
  assert.ok(result.publish_error, 'surfaces publish_error');
  // The ad entities were created before the publish step — their ids are surfaced for diagnosis.
  assert.equal(result.ad_id, 'AD1');
  assert.equal(result.adset_id, 'ADSET1');
  assert.ok(!JSON.stringify(result).includes(PUBLISH_PAGE_TOKEN), 'no page token leak');
});

test('createAd full with skip_publish_to_page: TRUTHFUL ok:true but published_to_page:false (no visible publish attempted)', async () => {
  const fetchImpl = makePublishAwareFetch({ publishError: true, readbackPublished: false });
  const result = await posting.createAd(fetchImpl, {
    userToken: USER_TOKEN_SECRET,
    body: { page_id: '107267395614980', video_url: 'https://cdn/x.mp4', caption: 'cap', shortlink: 'https://s.shopee.co.th/x', shopee_url: 'https://shopee.co.th/x', ad_account: 'act_test', template_adset: 'tpl_test', skip_publish_to_page: true },
    pollMs: 0,
    downloadVideo: async () => ({ buffer: Buffer.from('REALBYTES'), contentType: 'video/mp4' })
  });
  assert.equal(result.ok, true, 'skip_publish_to_page is an intentional non-publish path');
  assert.equal(result.published_to_page, false, 'never claims a visible page post when publish was skipped');
  // It never attempts the is_published POST/readback when the publish is intentionally skipped.
  assert.ok(!fetchImpl.calls.some((c) => c.method === 'POST' && /is_published/.test(c.body)), 'no publish POST when skipped');
  assert.ok(!JSON.stringify(result).includes(PUBLISH_PAGE_TOKEN), 'no page token leak');
});

test('POST /publish-story FAILS CLOSED when the publish errors transiently and the readback does not confirm (no false success)', async () => {
  const browser = makeBrowser({ publishError: true, publishReadbackPublished: false });
  await listen({ browser });
  const STORY = `${LIVE_PAGE_ID}_STORY9`;
  const r = await req('POST', '/publish-story', { page_id: LIVE_PAGE_ID, story_id: STORY });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false, 'a transient publish error is NOT a success');
  assert.equal(r.body.published_to_page, false);
  assert.equal(r.body.step, 'publish');
  assertNoLeak(r.body);
});

test('POST /create-ad FAILS CLOSED (ok:false, step=publish) when the page publish is not confirmed — Worker must record failure, not success', async () => {
  const browser = makeBrowser({ publishError: true, publishReadbackPublished: false });
  await listen({ browser });
  const r = await req('POST', '/create-ad', {
    page_id: LIVE_PAGE_ID,
    video_url: 'https://cdn/example.mp4',
    caption: 'cap',
    shortlink: 'https://s.shopee.co.th/x',
    shopee_url: 'https://shopee.co.th/x',
    ad_account: 'act_test',
    template_adset: 'tpl_test'
  });
  assert.equal(r.body.ok, false, 'create-ad must not return ok:true when the visible publish failed');
  assert.equal(r.body.step, 'publish');
  assert.equal(r.body.published_to_page, false);
  assertNoLeak(r.body);
});

test('POST /publish-story RECOVERS a transient "reduce the amount of data" publish via retry and reports success', async () => {
  // The first two publish POSTs return the transient code 1 error; the retry succeeds — the real
  // remedy for the live CHEARB incident where a single publish attempt failed transiently.
  const browser = makeBrowser({ publishFailTimes: 2, publishReadbackPublished: false });
  await listen({ browser });
  const STORY = `${LIVE_PAGE_ID}_STORY9`;
  const r = await req('POST', '/publish-story', { page_id: LIVE_PAGE_ID, story_id: STORY });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, 'a transient publish that clears on retry is a real success');
  assert.equal(r.body.published_to_page, true);
  // It retried the is_published POST rather than failing on the first transient error.
  const publishPosts = browser.calls.filter((c) => c.method === 'POST' && /is_published/.test(String(c.body || '')));
  assert.ok(publishPosts.length >= 3, 'retried the publish until it succeeded');
  assertNoLeak(r.body);
});

test('POST /create-ad RECOVERS a transient page publish via retry and returns ok:true with published_to_page', async () => {
  const browser = makeBrowser({ publishFailTimes: 1, publishReadbackPublished: false });
  await listen({ browser });
  const r = await req('POST', '/create-ad', {
    page_id: LIVE_PAGE_ID,
    video_url: 'https://cdn/example.mp4',
    caption: 'cap',
    shortlink: 'https://s.shopee.co.th/x',
    shopee_url: 'https://shopee.co.th/x',
    ad_account: 'act_test',
    template_adset: 'tpl_test'
  });
  assert.equal(r.body.ok, true, 'create-ad succeeds once the transient publish clears on retry');
  assert.equal(r.body.published_to_page, true);
  assertNoLeak(r.body);
});

// =====================================================================
// PAID AD CTA REPAIR (/repair-ad-cta) — the urgent production fix. The ad-only ACTIVE flow creates
// the paid ad BEFORE the final post-specific shortlink exists, so the paid creative carries a
// placeholder link (sub2/sub3 unset — Ads Manager previews showed utm_content=…AD----). This repairs
// the PAID ad creative (NOT just the visible post /update-cta): a NEW creative carrying the final
// link, the existing ad re-pointed at it, and a read-back confirmation.
// =====================================================================
test('POST /repair-ad-cta builds a NEW creative with the final link, re-points the ad, confirms paid_ad_cta_final', async () => {
  const browser = makeBrowser();
  await listen({ browser });
  const FINAL = 'https://s.shopee.co.th/FINALCTA';
  const r = await req('POST', '/repair-ad-cta', {
    page_id: LIVE_PAGE_ID,
    ad_id: 'AD1',
    creative_id: 'OLDCR',
    video_id: 'EXISTINGVID',
    final_cta_link: FINAL,
    caption: 'cap',
    ad_account: 'act_test',
    template_adset: 'tpl_test',
    story_id: `${LIVE_PAGE_ID}_STORY9`
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.phase, 'repair_ad_cta');
  assert.equal(r.body.ad_id, 'AD1');
  assert.equal(r.body.old_creative_id, 'OLDCR');
  assert.equal(r.body.new_creative_id, 'CR1');
  assert.equal(r.body.paid_ad_cta_link, FINAL, 'read-back confirms the paid CTA carries the final link');
  assert.equal(r.body.paid_ad_cta_final, true);
  // A NEW adcreative carrying the final link in the video_data CTA was POSTed.
  const crPost = browser.calls.find((c) => /\/adcreatives/.test(c.url) && c.method === 'POST');
  assert.ok(crPost, 'a new adcreative was created');
  assert.ok(String(crPost.body).includes(FINAL), 'new creative bakes the final link into the CTA');
  assert.ok(/call_to_action/.test(String(crPost.body)), 'new creative carries a CTA object');
  assert.ok(/video_data/.test(String(crPost.body)), 'new creative uses object_story_spec.video_data');
  // The existing ad is re-pointed at the new creative (Graph cannot edit a live creative inline).
  const adRepoint = browser.calls.find((c) => /\/AD1\?/.test(c.url) && c.method === 'POST' && /creative_id/.test(String(c.body || '')));
  assert.ok(adRepoint, 'the ad is re-pointed at the new creative');
  assert.ok(String(adRepoint.body).includes('CR1'), 're-point references the new creative id');
  assertNoLeak(r.body);
});

test('POST /repair-ad-cta backfills video/image/message from the OLD creative when not supplied', async () => {
  const browser = makeBrowser();
  await listen({ browser });
  const FINAL = 'https://s.shopee.co.th/BACKFILL';
  const r = await req('POST', '/repair-ad-cta', {
    page_id: LIVE_PAGE_ID,
    ad_id: 'AD1',
    creative_id: 'OLDCR', // video_id / caption / thumbnail intentionally omitted — read off OLDCR
    final_cta_link: FINAL,
    ad_account: 'act_test',
    template_adset: 'tpl_test'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.video_id, 'EXISTINGVID', 'video id backfilled from the old creative spec');
  assert.equal(r.body.paid_ad_cta_final, true);
  const crPost = browser.calls.find((c) => /\/adcreatives/.test(c.url) && c.method === 'POST');
  assert.ok(String(crPost.body).includes('EXISTINGVID'), 'new creative reuses the old video id');
  assert.ok(String(crPost.body).includes('https://thumb/old.jpg'), 'new creative reuses the old thumbnail');
  // The old placeholder link is surfaced for diagnostics but never re-used as the CTA.
  assert.equal(r.body.old_paid_ad_cta_link, 'https://s.shopee.co.th/PLACEHOLDER----');
  assert.ok(String(crPost.body).includes(FINAL), 'new creative uses the FINAL link, not the placeholder');
  assertNoLeak(r.body);
});

test('POST /repair-ad-cta does NOT claim paid_ad_cta_final when the read-back creative does not match', async () => {
  // The re-point "succeeds" but the ad still reports the OLD creative on read-back — fail closed.
  const browser = makeBrowser({ repairReadbackCreativeId: 'OLDCR', repairReadbackCtaLink: 'https://s.shopee.co.th/PLACEHOLDER----' });
  await listen({ browser });
  const r = await req('POST', '/repair-ad-cta', {
    page_id: LIVE_PAGE_ID,
    ad_id: 'AD1',
    creative_id: 'OLDCR',
    video_id: 'EXISTINGVID',
    final_cta_link: 'https://s.shopee.co.th/FINALCTA',
    caption: 'cap',
    ad_account: 'act_test',
    template_adset: 'tpl_test'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, 'the call still completes (creative made + ad re-pointed)');
  assert.equal(r.body.paid_ad_cta_final, false, 'read-back did not confirm the new creative → fail closed');
  assertNoLeak(r.body);
});

test('POST /repair-ad-cta REJECTS a non-Shopee / redirect final link and never touches the ad creative', async () => {
  for (const bad of ['https://api.pubilo.com/onecard-cta/abc', 'https://example.com/x']) {
    const browser = makeBrowser();
    await listen({ browser });
    const r = await req('POST', '/repair-ad-cta', {
      page_id: LIVE_PAGE_ID,
      ad_id: 'AD1',
      creative_id: 'OLDCR',
      video_id: 'EXISTINGVID',
      final_cta_link: bad,
      ad_account: 'act_test',
      template_adset: 'tpl_test'
    });
    assert.equal(r.body.ok, false, `rejects ${bad}`);
    assert.equal(r.body.error, 'final_cta_link_must_be_direct_shopee_link');
    // HARD GUARANTEE: no creative was created and the ad was never re-pointed.
    assert.ok(!browser.calls.some((c) => /\/adcreatives/.test(c.url) && c.method === 'POST'), 'no creative created on a rejected link');
    assert.ok(!browser.calls.some((c) => /\/AD1\?/.test(c.url) && c.method === 'POST' && /creative_id/.test(String(c.body || ''))), 'ad never re-pointed on a rejected link');
    assertNoLeak(r.body);
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
});

test('POST /repair-ad-cta fails closed (validate) when ad_id is missing', async () => {
  await listen();
  const r = await req('POST', '/repair-ad-cta', {
    page_id: LIVE_PAGE_ID,
    final_cta_link: 'https://s.shopee.co.th/x',
    ad_account: 'act_test'
  });
  assert.equal(r.body.ok, false);
  assert.equal(r.body.step, 'validate');
});

// =====================================================================
// AD-ONLY AUTO-PAUSE (/pause-ad-only) — turn OFF a finished campaign/adset/ad. The HARD invariant:
// status=PAUSED ONLY, never a DELETE request and never status='DELETED'. Close/off, never destroy.
// =====================================================================
test('POST /pause-ad-only sets status=PAUSED on campaign+adset+ad and reads back the off-state', async () => {
  const browser = makeBrowser();
  await listen({ browser });
  const r = await req('POST', '/pause-ad-only', {
    campaign_id: 'CAMPX',
    adset_id: 'ADSETX',
    ad_id: 'ADX'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.phase, 'pause_ad_only');
  assert.equal(r.body.campaign_id, 'CAMPX');
  assert.equal(r.body.adset_id, 'ADSETX');
  assert.equal(r.body.ad_id, 'ADX');
  assert.equal(r.body.campaign.ok, true);
  assert.equal(r.body.campaign.effective_status, 'PAUSED');
  assert.equal(r.body.adset.effective_status, 'PAUSED');
  assert.equal(r.body.ad.effective_status, 'PAUSED');
  // Each object got a { status: 'PAUSED' } POST.
  for (const id of ['CAMPX', 'ADSETX', 'ADX']) {
    const pausePost = browser.calls.find((c) => new RegExp(`/${id}\\?`).test(c.url) && c.method === 'POST' && /"status":"PAUSED"/.test(String(c.body || '')));
    assert.ok(pausePost, `${id} received a status=PAUSED POST`);
  }
  // HARD GUARANTEE: never a DELETE request, never status='DELETED'.
  assert.ok(!browser.calls.some((c) => String(c.method).toUpperCase() === 'DELETE'), 'no DELETE request issued');
  assert.ok(!browser.calls.some((c) => /"status":"DELETED"/.test(String(c.body || ''))), 'never sets status=DELETED');
  assertNoLeak(r.body);
});

test('POST /pause-ad-only works with only a campaign_id (ad_id optional)', async () => {
  const browser = makeBrowser();
  await listen({ browser });
  const r = await req('POST', '/pause-ad-only', { campaign_id: 'CAMPONLY' });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.campaign.effective_status, 'PAUSED');
  assert.equal(r.body.adset, undefined, 'no adset pause attempted when none supplied');
  assert.equal(r.body.ad, undefined, 'no ad pause attempted when none supplied');
  assert.ok(!browser.calls.some((c) => String(c.method).toUpperCase() === 'DELETE'), 'no DELETE request issued');
  assertNoLeak(r.body);
});

test('POST /pause-ad-only fails closed (validate) when neither campaign_id nor adset_id supplied', async () => {
  const browser = makeBrowser();
  await listen({ browser });
  const r = await req('POST', '/pause-ad-only', { ad_id: 'ADX' });
  assert.equal(r.body.ok, false);
  assert.equal(r.body.step, 'validate');
  // Nothing was touched on Graph.
  assert.ok(!browser.calls.some((c) => c.method === 'POST' && /"status"/.test(String(c.body || ''))), 'no status write on a rejected request');
  assertNoLeak(r.body);
});

// SOURCE INVARIANT — the pause helper must be provably DELETE-free.
test('pauseAdOnlyObjects source contains status=PAUSED and NEVER DELETE/DELETED', () => {
  const { readFileSync } = require('fs');
  const { resolve } = require('path');
  const src = readFileSync(resolve(__dirname, '../src/posting.js'), 'utf8');
  const fnStart = src.indexOf('async function pauseAdOnlyObjects');
  assert.ok(fnStart >= 0, 'pauseAdOnlyObjects exists');
  const fnEnd = src.indexOf('\nmodule.exports', fnStart);
  const fn = src.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);
  assert.ok(/status:\s*'PAUSED'/.test(fn), 'pause helper writes status=PAUSED');
  // Strip line/block comments so the doc-comment's literal mention of DELETED (documenting the
  // guarantee) does not satisfy the invariant — only EXECUTABLE code is checked.
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/status:\s*'DELETED'/.test(code), 'pause helper never writes status=DELETED');
  assert.ok(!/method:\s*'DELETE'/.test(code), 'pause helper never issues a DELETE method');
});
