'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildAdFromCreative } = require('../src/posting');

test('buildAdFromCreative names ad-only Follow ads with the Facebook post tail only', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const method = String(opts.method || 'GET').toUpperCase();
    let body = null;
    if (opts.body) {
      try { body = JSON.parse(opts.body); } catch {}
    }
    calls.push({ url: u, method, body });

    if (u.includes('/TEMPLATE_ADSET?')) {
      return { ok: true, status: 200, json: async () => ({ campaign: { id: 'TEMPLATE_CAMPAIGN', objective: 'OUTCOME_ENGAGEMENT' } }) };
    }
    if (u.includes('/TEMPLATE_CAMPAIGN?')) {
      return { ok: true, status: 200, json: async () => ({ id: 'TEMPLATE_CAMPAIGN', objective: 'OUTCOME_ENGAGEMENT' }) };
    }
    if (u.includes('/TEMPLATE_ADSET/copies') && method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ copied_adset_id: 'NEW_ADSET' }) };
    }
    if (u.includes('/act_123/ads') && method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ id: 'NEW_AD' }) };
    }
    if (u.includes('/NEW_ADSET') && method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
    if (u.includes('/NEW_ADSET/ads') && method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'NEW_AD' }] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const result = await buildAdFromCreative(fetchImpl, {
    userToken: 'USER_TOKEN',
    adAccount: 'act_123',
    templateAdset: 'TEMPLATE_ADSET',
    creativeId: 'CREATIVE_1',
    storyId: '1008898512617594_1313101520994543',
    adName: 'f100e76f',
    paused: true,
    body: {
      campaign_id: '120248151339120263',
      skip_publish_to_page: true
    },
    sleep: async () => {},
    pollMs: 1
  });

  assert.equal(result.ok, true);
  assert.equal(result.ad_name, '1313101520994543');
  const adCreate = calls.find((c) => c.url.includes('/act_123/ads') && c.method === 'POST');
  assert.ok(adCreate, 'expected an ad create call');
  assert.equal(adCreate.body.name, '1313101520994543');
  assert.equal(adCreate.body.name.includes('1008898512617594'), false, 'ad name must not include page id');
  assert.equal(adCreate.body.name, String(Number(adCreate.body.name)), 'ad name should be the numeric post tail only');
});
