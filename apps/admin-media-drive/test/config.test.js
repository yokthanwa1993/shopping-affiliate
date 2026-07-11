import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  config,
  PROCESSOR_MODES,
  STORAGE_MODES,
  normalizeProcessorMode,
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

test('normalizeProcessorMode defaults to the real merge-rust pipeline', () => {
  assert.deepEqual([...PROCESSOR_MODES], ['merge_rust', 'ffmpeg']);
  assert.equal(normalizeProcessorMode(undefined), 'merge_rust');
  assert.equal(normalizeProcessorMode(''), 'merge_rust');
  assert.equal(normalizeProcessorMode('merge-rust'), 'merge_rust');
  assert.equal(normalizeProcessorMode('MERGE_RUST'), 'merge_rust');
  assert.equal(normalizeProcessorMode('ffmpeg'), 'ffmpeg');
  assert.equal(normalizeProcessorMode('unknown'), 'merge_rust');
});

test('config exposes source/processed channel ids (default empty strings)', () => {
  assert.equal(typeof config.discord.sourceChannelId, 'string');
  assert.equal(typeof config.discord.processedChannelId, 'string');
});

test('config exposes local processor settings without secrets', () => {
  assert.ok(PROCESSOR_MODES.includes(config.processor.mode));
  assert.equal(config.processor.mode, 'merge_rust');
  assert.equal(typeof config.processor.ffmpegBin, 'string');
  assert.equal(typeof config.processor.ffprobeBin, 'string');
  assert.equal(typeof config.processor.videoEncoder, 'string');
  assert.equal(typeof config.processor.keepTmp, 'boolean');
  assert.equal(typeof config.processor.pollMs, 'number');
  assert.equal(typeof config.processor.mergeRustRoot, 'string');
  assert.equal(typeof config.processor.mergeRustUrl, 'string');
  assert.equal(typeof config.processor.geminiModel, 'string');
  assert.equal(config.processor.vertexTtsModel, 'gemini-3.1-flash-tts-preview');
});
