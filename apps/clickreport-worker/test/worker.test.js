import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildUpstreamUrl, handleRequest } from '../src/index.js';

test('buildUpstreamUrl preserves query exactly for root path', () => {
  const out = buildUpstreamUrl('https://clickreport.wwoom.com/?time=26/05/2026');
  assert.equal(out, 'https://customlink.wwoom.com/click-report?time=26/05/2026');
});

test('buildUpstreamUrl preserves multi-param query and ignores inbound path', () => {
  const out = buildUpstreamUrl(
    'https://clickreport.wwoom.com/anything/here?id=15130770000&time=26/05/2026&page_size=1',
  );
  assert.equal(
    out,
    'https://customlink.wwoom.com/click-report?id=15130770000&time=26/05/2026&page_size=1',
  );
});

test('buildUpstreamUrl with no query yields bare upstream path', () => {
  const out = buildUpstreamUrl('https://clickreport.wwoom.com/');
  assert.equal(out, 'https://customlink.wwoom.com/click-report');
});

test('OPTIONS returns 204 with CORS + Allow header', async () => {
  const req = new Request('https://clickreport.wwoom.com/?time=26/05/2026', { method: 'OPTIONS' });
  const res = await handleRequest(req, { fetch: async () => { throw new Error('should not fetch'); } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(res.headers.get('Allow'), 'GET, HEAD, OPTIONS');
});

test('POST returns 405 JSON with Allow: GET, HEAD', async () => {
  const req = new Request('https://clickreport.wwoom.com/', { method: 'POST' });
  const res = await handleRequest(req, { fetch: async () => { throw new Error('should not fetch'); } });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('Allow'), 'GET, HEAD');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.match(res.headers.get('Content-Type') || '', /application\/json/);
  const body = await res.json();
  assert.equal(body.error, 'method_not_allowed');
});

test('GET proxies to upstream, preserves status, adds CORS', async () => {
  let calledWith = null;
  const fakeFetch = async (url, init) => {
    calledWith = { url, init };
    return new Response(JSON.stringify({ status: 'ok', total_count: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  };
  const req = new Request('https://clickreport.wwoom.com/?id=15130770000&time=26/05/2026', { method: 'GET' });
  const res = await handleRequest(req, { fetch: fakeFetch });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.match(res.headers.get('Content-Type') || '', /application\/json/);
  assert.equal(
    calledWith.url,
    'https://customlink.wwoom.com/click-report?id=15130770000&time=26/05/2026',
  );
  assert.equal(calledWith.init.method, 'GET');
  const body = await res.json();
  assert.deepEqual(body, { status: 'ok', total_count: 0 });
});

test('GET passes through upstream error status', async () => {
  const fakeFetch = async () => new Response(
    JSON.stringify({ status: 'error', error: 'click_report_time_invalid' }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  );
  const req = new Request('https://clickreport.wwoom.com/?time=garbage', { method: 'GET' });
  const res = await handleRequest(req, { fetch: fakeFetch });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'click_report_time_invalid');
});

test('HEAD proxies upstream status without body', async () => {
  const fakeFetch = async () => new Response('ignored', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  const req = new Request('https://clickreport.wwoom.com/?time=26/05/2026', { method: 'HEAD' });
  const res = await handleRequest(req, { fetch: fakeFetch });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(text, '');
});

test('upstream fetch failure yields 502 JSON', async () => {
  const fakeFetch = async () => { throw new Error('connect ECONNREFUSED'); };
  const req = new Request('https://clickreport.wwoom.com/?time=26/05/2026', { method: 'GET' });
  const res = await handleRequest(req, { fetch: fakeFetch });
  assert.equal(res.status, 502);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  const body = await res.json();
  assert.equal(body.error, 'upstream_unreachable');
});
