import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  MAX_VERTEX_CREDENTIALS_BYTES,
  VertexCredentialsError,
  loadVertexServiceAccount,
} from '../src/vertex-credentials.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'amd-vertex-'));
}

// Obviously fake material: the structural shape of a service-account key with
// dummy values only. Never put real credentials in tests.
const DUMMY_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nZHVtbXktbm90LWEta2V5\n-----END PRIVATE KEY-----\n';

function dummyServiceAccount(overrides = {}) {
  return {
    type: 'service_account',
    project_id: 'dummy-project',
    private_key_id: 'dummy-key-id',
    private_key: DUMMY_PRIVATE_KEY,
    client_email: 'dummy-sa@dummy-project.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
    ...overrides,
  };
}

function writeCredentials(value) {
  const filePath = path.join(tempDir(), 'sa.json');
  fs.writeFileSync(filePath, typeof value === 'string' ? value : JSON.stringify(value));
  return filePath;
}

async function expectCategory(promise, category) {
  const error = await promise.then(
    () => assert.fail(`expected rejection ${category}`),
    (e) => e,
  );
  assert.equal(error instanceof VertexCredentialsError, true);
  assert.equal(error.category, category);
  // Sanitized: the message is exactly the category — no path, no contents.
  assert.equal(error.message, category);
}

test('loadVertexServiceAccount returns serialized JSON + project id for a valid dummy key file', async () => {
  const loaded = await loadVertexServiceAccount(writeCredentials(dummyServiceAccount()));
  assert.equal(typeof loaded.serviceAccountJson, 'string');
  assert.equal(loaded.projectId, 'dummy-project');
  const roundTrip = JSON.parse(loaded.serviceAccountJson);
  assert.equal(roundTrip.type, 'service_account');
  assert.equal(roundTrip.client_email, 'dummy-sa@dummy-project.iam.gserviceaccount.com');
});

test('loadVertexServiceAccount tolerates a credential without project_id (caller enforces the override)', async () => {
  const noProject = dummyServiceAccount();
  delete noProject.project_id;
  const loaded = await loadVertexServiceAccount(writeCredentials(noProject));
  assert.equal(loaded.projectId, '');
});

test('loadVertexServiceAccount fails closed with sanitized snake_case categories', async () => {
  await expectCategory(loadVertexServiceAccount(''), 'vertex_credentials_not_configured');
  await expectCategory(loadVertexServiceAccount('   '), 'vertex_credentials_not_configured');
  await expectCategory(
    loadVertexServiceAccount(path.join(tempDir(), 'nope.json')),
    'vertex_credentials_missing',
  );
  await expectCategory(loadVertexServiceAccount(tempDir()), 'vertex_credentials_not_a_file');
  await expectCategory(
    loadVertexServiceAccount(writeCredentials(dummyServiceAccount()), { maxBytes: 64 }),
    'vertex_credentials_too_large',
  );
  await expectCategory(
    loadVertexServiceAccount(writeCredentials(`{${' '.repeat(MAX_VERTEX_CREDENTIALS_BYTES)}}`)),
    'vertex_credentials_too_large',
  );
  await expectCategory(loadVertexServiceAccount(writeCredentials('{not json')), 'vertex_credentials_invalid_json');
  await expectCategory(loadVertexServiceAccount(writeCredentials('[1,2,3]')), 'vertex_credentials_invalid_json');
  await expectCategory(loadVertexServiceAccount(writeCredentials('"service_account"')), 'vertex_credentials_invalid_json');
  await expectCategory(
    loadVertexServiceAccount(writeCredentials(dummyServiceAccount({ type: 'authorized_user' }))),
    'vertex_credentials_invalid_shape',
  );
  await expectCategory(
    loadVertexServiceAccount(writeCredentials(dummyServiceAccount({ private_key: '' }))),
    'vertex_credentials_invalid_shape',
  );
  const missingEmail = dummyServiceAccount();
  delete missingEmail.client_email;
  await expectCategory(loadVertexServiceAccount(writeCredentials(missingEmail)), 'vertex_credentials_invalid_shape');
});
