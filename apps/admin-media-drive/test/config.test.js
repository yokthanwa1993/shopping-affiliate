import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  config,
  STORAGE_MODES,
  normalizeStorageMode,
  defaultIndexStatus,
} from '../src/config.js';

test('normalizeStorageMode defaults to discord for unknown/empty values', () => {
  assert.equal(normalizeStorageMode(undefined), 'discord');
  assert.equal(normalizeStorageMode(''), 'discord');
  assert.equal(normalizeStorageMode('   '), 'discord');
  assert.equal(normalizeStorageMode('nope'), 'discord');
  assert.equal(normalizeStorageMode(null), 'discord');
});

test('normalizeStorageMode accepts the two allowed modes, case-insensitive', () => {
  assert.deepEqual([...STORAGE_MODES], ['discord', 'mirror']);
  assert.equal(normalizeStorageMode('discord'), 'discord');
  assert.equal(normalizeStorageMode('mirror'), 'mirror');
  assert.equal(normalizeStorageMode('MIRROR'), 'mirror');
  assert.equal(normalizeStorageMode(' Discord '), 'discord');
});

test('defaultIndexStatus is discord_indexed in discord mode, indexed in mirror', () => {
  assert.equal(defaultIndexStatus('discord'), 'discord_indexed');
  assert.equal(defaultIndexStatus('mirror'), 'indexed');
  // unknown modes are treated as discord
  assert.equal(defaultIndexStatus('whatever'), 'discord_indexed');
});

test('config.storageMode is always one of the allowed modes', () => {
  assert.ok(STORAGE_MODES.includes(config.storageMode));
});

test('config exposes source/processed channel ids (default empty strings)', () => {
  assert.equal(typeof config.discord.sourceChannelId, 'string');
  assert.equal(typeof config.discord.processedChannelId, 'string');
});

test('config exposes local processor settings without secrets', () => {
  assert.equal(typeof config.processor.ffmpegBin, 'string');
  assert.equal(typeof config.processor.ffprobeBin, 'string');
  assert.equal(typeof config.processor.videoEncoder, 'string');
  assert.equal(typeof config.processor.keepTmp, 'boolean');
  assert.equal(typeof config.processor.pollMs, 'number');
});
