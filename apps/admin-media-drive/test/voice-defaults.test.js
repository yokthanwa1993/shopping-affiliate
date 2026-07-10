import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_TTS_PROMPT_TEMPLATE,
  DEFAULT_TTS_STYLE_INSTRUCTIONS,
  DEFAULT_VOICE_SCRIPT_PROMPT,
} from '../src/voice-defaults.js';

// Male self-reference/endings that a female persona must never receive.
const BANNED_MALE_TOKENS = ['ครับ', 'ครับผม', 'ผม', 'ผมนะ', 'ผมว่า'];
// Canned hard-sell phrases the friend-to-friend tone must steer away from.
const BANNED_HARDSELL_PHRASES = [
  'ต้องจัด',
  'ห้ามพลาด',
  'ของมันต้องมี',
  'ตอบโจทย์มาก',
  'สุดปัง',
  'จัดด่วน',
  'รีบตำ',
  'คุ้มมาก',
];

test('default voice script prompt establishes a female persona and bans male endings', () => {
  const prompt = DEFAULT_VOICE_SCRIPT_PROMPT;
  assert.match(prompt, /ผู้หญิง/);
  // Each banned male token must be explicitly named as forbidden in the prompt,
  // so the model is instructed never to emit e.g. "...ต้องจัดตัวนี้เลยครับ".
  for (const token of BANNED_MALE_TOKENS) {
    assert.ok(
      prompt.includes(token),
      `prompt must explicitly forbid male token "${token}"`,
    );
  }
  // The forbidding must be framed as a prohibition, not as encouraged usage.
  assert.match(prompt, /ห้ามใช้คำลงท้ายหรือสรรพนามชาย/);
});

test('default voice script prompt asks for friend-to-friend tone, not an announcer or ad', () => {
  const prompt = DEFAULT_VOICE_SCRIPT_PROMPT;
  assert.match(prompt, /เพื่อน/); // friend-to-friend framing
  assert.match(prompt, /ไม่ใช่ผู้ประกาศ/);
  assert.match(prompt, /ไม่ใช่.*ขายของ/s);
  // Soft, optional CTA guidance (not a hard sell).
  assert.match(prompt, /ลองดูไว้ได้นะ/);
  // Grounding + no invented product features.
  assert.match(prompt, /ห้ามมโน/);
});

test('default voice script prompt lists the hard-sell phrases as things to avoid', () => {
  const prompt = DEFAULT_VOICE_SCRIPT_PROMPT;
  for (const phrase of BANNED_HARDSELL_PHRASES) {
    assert.ok(
      prompt.includes(phrase),
      `prompt must name hard-sell phrase "${phrase}" as avoid-unless-justified`,
    );
  }
  assert.match(prompt, /ห้ามใช้วลีขายของสำเร็จรูป/);
});

test('default TTS style instructions request a warm female friend delivery', () => {
  const style = DEFAULT_TTS_STYLE_INSTRUCTIONS;
  assert.match(style, /ผู้หญิง/);
  assert.match(style, /เพื่อน/);
  assert.match(style, /ไม่ใช่ผู้ประกาศ/);
  // Delivery direction must tell the model not to read the instruction aloud.
  assert.match(style, /ห้ามอ่านคำสั่ง/);
  // The prompt template embeds the style ahead of the {{script}} placeholder.
  assert.ok(DEFAULT_TTS_PROMPT_TEMPLATE.includes('{{script}}'));
  assert.ok(DEFAULT_TTS_PROMPT_TEMPLATE.startsWith(style));
});
