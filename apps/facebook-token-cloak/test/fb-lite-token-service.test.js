'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const svc = require('../src/fb-lite-token-service.cjs');

test('FB_LITE targets the Facebook Lite Android app id (EAAD6V-minting app)', () => {
  assert.equal(svc.FB_APPS.FB_LITE, '275254692598279');
});

test('extractTokenPrefix returns the EAAD6V app prefix for a Facebook Lite token', () => {
  // A real Lite token is EAAD6V<lowercase…>; the prefix is the leading run before the first
  // lowercase char. This is the non-secret hint surfaced as token_prefix/tokenPrefix.
  assert.equal(svc.extractTokenPrefix('EAAD6Vabc123def456'), 'EAAD6V');
  assert.equal(svc.extractTokenPrefix('EAAD6V0z'), 'EAAD6V0');
});

test('extractTokenPrefix never returns the full token (no raw-token leak via the hint)', () => {
  const token = 'EAAD6Vsupersecretremainderxyz';
  const prefix = svc.extractTokenPrefix(token);
  assert.ok(prefix.length < token.length, 'prefix must be shorter than the token');
  assert.ok(token.startsWith(prefix));
  assert.ok(!prefix.includes('supersecretremainder'), 'prefix must not carry the secret tail');
});

test('the service exposes the bridge-consumed login/convert/resolve API', () => {
  for (const fn of ['facebookLogin', 'convertToken', 'resolvePageToken', 'extractTokenPrefix']) {
    assert.equal(typeof svc[fn], 'function', `${fn} must be exported`);
  }
});
