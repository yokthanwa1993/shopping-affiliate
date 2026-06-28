// Agent command-queue + heartbeat tests — drive the real router against a real (node:sqlite) D1.
//
// Proves: auth required on every new /v1 endpoint, the enqueue -> poll(claim) -> complete lifecycle,
// single-claim safety (no double-claim), agent heartbeat, and that NO secret-shaped key/value can
// ride along in a command payload/result.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/router.js';
import { makeEnv } from './d1-sqlite.js';

const AGENT = 'mac-mini';

async function call(env, method, path, { body, key } = {}) {
  const headers = {};
  if (key !== null) headers['x-accounts-bridge-key'] = key === undefined ? env.ACCOUNTS_BRIDGE_API_KEY : key;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const req = new Request('https://bridge.local' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const res = await handleRequest(req, env);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

test('every new agent/command endpoint rejects a missing or wrong API key with 401', async () => {
  const env = makeEnv();
  const probes = [
    ['POST', '/v1/commands'],
    ['GET', '/v1/commands?agent_id=mac-mini'],
    ['POST', '/v1/agents/mac-mini/poll'],
    ['POST', '/v1/commands/cmd_x/complete'],
    ['POST', '/v1/agents/mac-mini/status'],
    ['PUT', '/v1/agents/mac-mini/status'],
    ['GET', '/v1/agents/mac-mini/status'],
    ['GET', '/v1/agents']
  ];
  for (const [method, p] of probes) {
    const missing = await call(env, method, p, { key: null });
    assert.equal(missing.status, 401, `${method} ${p} without key`);
    const wrong = await call(env, method, p, { key: 'nope' });
    assert.equal(wrong.status, 401, `${method} ${p} wrong key`);
  }
});

test('enqueue -> poll(claim) -> complete lifecycle works and is non-secret end to end', async () => {
  const env = makeEnv();
  // Seed the targeted account so open_profile is a believable command (not strictly required).
  await call(env, 'POST', '/v1/accounts', { body: { account_uid: '100000000000001', platform: 'facebook', display_label: 'Chanalai' } });

  const enq = await call(env, 'POST', '/v1/commands', {
    body: { agent_id: AGENT, action: 'open_profile', platform: 'facebook', account_uid: '100000000000001', payload: { visible: true, note: 'operator open' } }
  });
  assert.equal(enq.status, 201);
  assert.equal(enq.json.command.status, 'queued');
  assert.equal(enq.json.command.action, 'open_profile');
  const cmdId = enq.json.command.id;

  // Before a poll the command is queued and the agent is known but not yet seen-online.
  const list = await call(env, 'GET', `/v1/commands?agent_id=${AGENT}`);
  assert.equal(list.json.commands.length, 1);
  assert.equal(list.json.commands[0].status, 'queued');

  // Poll claims it and flips it to running; the agent is now heartbeated online.
  const poll = await call(env, 'POST', `/v1/agents/${AGENT}/poll`, { body: { limit: 10 } });
  assert.equal(poll.status, 200);
  assert.equal(poll.json.commands.length, 1);
  assert.equal(poll.json.commands[0].id, cmdId);
  assert.equal(poll.json.commands[0].status, 'running');

  const agents = await call(env, 'GET', '/v1/agents');
  assert.equal(agents.json.agents.length, 1);
  assert.equal(agents.json.agents[0].agent_id, AGENT);
  assert.equal(agents.json.agents[0].status, 'online');
  assert.ok(agents.json.agents[0].last_seen_at, 'poll heartbeats last_seen_at');

  // A second poll claims nothing (already running) — no double-claim.
  const poll2 = await call(env, 'POST', `/v1/agents/${AGENT}/poll`);
  assert.equal(poll2.json.commands.length, 0);

  // Complete it with a non-secret result.
  const done = await call(env, 'POST', `/v1/commands/${cmdId}/complete`, {
    body: { status: 'succeeded', result: { opened: true, profileDir: 'uidpost', reused: false } }
  });
  assert.equal(done.status, 200);
  assert.equal(done.json.command.status, 'succeeded');
  assert.deepEqual(done.json.command.result, { opened: true, profileDir: 'uidpost', reused: false });

  // Completing again is refused (not running anymore).
  const again = await call(env, 'POST', `/v1/commands/${cmdId}/complete`, { body: { status: 'failed' } });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'command_not_running');
});

test('open_profile / close_profile require an account_uid', async () => {
  const env = makeEnv();
  const res = await call(env, 'POST', '/v1/commands', { body: { agent_id: AGENT, action: 'open_profile' } });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'account_uid_required');
});

test('unknown action is rejected', async () => {
  const env = makeEnv();
  const res = await call(env, 'POST', '/v1/commands', { body: { agent_id: AGENT, action: 'rm_rf_profile', account_uid: 'x' } });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'bad_action');
});

test('command payload with a secret-shaped key is refused', async () => {
  const env = makeEnv();
  const res = await call(env, 'POST', '/v1/commands', {
    body: { agent_id: AGENT, action: 'status', payload: { access_token: 'whatever' } }
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'forbidden_field');
});

test('command payload with a secret-shaped VALUE is refused even under a safe key name', async () => {
  const env = makeEnv();
  const res = await call(env, 'POST', '/v1/commands', {
    body: { agent_id: AGENT, action: 'status', payload: { note: 'EAAB0123456789abcdef minted' } }
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'forbidden_value');
  // The offending value must NOT be echoed back.
  assert.ok(!res.text.includes('EAAB0123456789abcdef'));
});

test('complete result with a secret-shaped key is refused', async () => {
  const env = makeEnv();
  const enq = await call(env, 'POST', '/v1/commands', { body: { agent_id: AGENT, action: 'status' } });
  await call(env, 'POST', `/v1/agents/${AGENT}/poll`);
  const res = await call(env, 'POST', `/v1/commands/${enq.json.command.id}/complete`, {
    body: { status: 'succeeded', result: { cookie: 'c_user=123; xs=abc' } }
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'forbidden_field');
});

test('a sanitized error message + code survives, but a token-shaped message is redacted', async () => {
  const env = makeEnv();
  const enq = await call(env, 'POST', '/v1/commands', { body: { agent_id: AGENT, action: 'open_profile', account_uid: '100000000000001' } });
  await call(env, 'POST', `/v1/agents/${AGENT}/poll`);
  const res = await call(env, 'POST', `/v1/commands/${enq.json.command.id}/complete`, {
    body: { status: 'failed', error_code: 'profile_already_open', error_message: 'leaked EAAB0123456789abcdef in window' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.command.status, 'failed');
  assert.equal(res.json.command.error_code, 'profile_already_open');
  assert.equal(res.json.command.error_message, '[redacted]');
  assert.ok(!res.text.includes('EAAB0123456789abcdef'));
});

test('agent status heartbeat upsert + read, non-secret detail only', async () => {
  const env = makeEnv();
  const beat = await call(env, 'POST', `/v1/agents/${AGENT}/status`, {
    body: { status: 'online', label: 'Mac mini', detail: { accountsCount: 4, app: 'facebook-token-cloak' } }
  });
  assert.equal(beat.status, 200);
  assert.equal(beat.json.agent.status, 'online');
  assert.equal(beat.json.agent.detail.accountsCount, 4);

  const read = await call(env, 'GET', `/v1/agents/${AGENT}/status`);
  assert.equal(read.json.present, true);
  assert.equal(read.json.agent.agent_id, AGENT);

  const bad = await call(env, 'POST', `/v1/agents/${AGENT}/status`, { body: { detail: { datr: 'abc' } } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'forbidden_field');
});

test('claim is deterministic single-claim across two concurrent-shaped polls (no double-claim)', async () => {
  const env = makeEnv();
  // Three queued commands; two polls with limit 2 each must partition them with zero overlap.
  for (let i = 0; i < 3; i += 1) {
    await call(env, 'POST', '/v1/commands', { body: { agent_id: AGENT, action: 'status', payload: { i } } });
  }
  const a = await call(env, 'POST', `/v1/agents/${AGENT}/poll`, { body: { limit: 2 } });
  const b = await call(env, 'POST', `/v1/agents/${AGENT}/poll`, { body: { limit: 2 } });
  const idsA = a.json.commands.map((c) => c.id);
  const idsB = b.json.commands.map((c) => c.id);
  assert.equal(idsA.length, 2);
  assert.equal(idsB.length, 1);
  const overlap = idsA.filter((id) => idsB.includes(id));
  assert.equal(overlap.length, 0, 'no command is claimed by two polls');
});
