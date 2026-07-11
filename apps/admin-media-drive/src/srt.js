/**
 * SRT parsing + validation for the subtitle fail-closed gate.
 *
 * The gate only ever renders text that came out of the merge-rust pipeline's
 * `final_subtitles.srt` — it never invents or rewrites subtitle text. Parsing
 * is tolerant of CRLF/BOM and missing index lines; validation is strict and
 * throws `SrtError` with a sanitized machine-readable `category`.
 */

export class SrtError extends Error {
  constructor(category, detail = '') {
    super(category);
    this.name = 'SrtError';
    this.category = category;
    this.detail = String(detail || '').slice(0, 300);
  }
}

const TIME_LINE_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function toMs(h, m, s, frac) {
  const ms = Number(String(frac).padEnd(3, '0').slice(0, 3));
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + ms;
}

/** Format milliseconds as an SRT timestamp (HH:MM:SS,mmm). */
export function formatSrtTimestampMs(totalMs) {
  const ms = Math.max(0, Math.round(Number(totalMs) || 0));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rem = ms % 1000;
  const pad = (v, n = 2) => String(v).padStart(n, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(rem, 3)}`;
}

/** Strip inline markup (basic HTML tags + ASS override blocks) but keep text. */
function stripMarkup(text) {
  return String(text || '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .trim();
}

/**
 * Parse SRT text into cues: `[{ index, startMs, endMs, text }]`.
 * Never throws on sloppy formatting — blocks without a valid time line are
 * skipped. Use `validateCuesForBurn` for the strict gate checks.
 */
export function parseSrt(rawText) {
  const text = String(rawText || '').replace(/^﻿/, '');
  const blocks = text.split(/\r?\n\s*\r?\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((l) => l.trim());
    const timeLineIdx = lines.findIndex((l) => TIME_LINE_RE.test(l));
    if (timeLineIdx === -1) continue;
    const match = TIME_LINE_RE.exec(lines[timeLineIdx]);
    const startMs = toMs(match[1], match[2], match[3], match[4]);
    const endMs = toMs(match[5], match[6], match[7], match[8]);
    const textLines = lines
      .slice(timeLineIdx + 1)
      .map(stripMarkup)
      .filter(Boolean);
    cues.push({
      index: cues.length + 1,
      startMs,
      endMs,
      text: textLines.join('\n'),
    });
  }
  return cues;
}

/**
 * Strict validation for the burn/verification path.
 *
 * Returns a NEW sorted cue array with end times clamped to the video duration
 * (timings may be shortened, never extended, and text is never altered).
 * Throws SrtError with one of:
 *   subtitle_srt_empty | subtitle_cue_count_exceeded | subtitle_cue_text_empty
 *   | subtitle_cue_invalid_timing | subtitle_cue_beyond_duration
 */
export function validateCuesForBurn(cues, {
  maxCues = 240,
  videoDurationMs = null,
  startSlackMs = 1500,
  minVisibleMs = 80,
} = {}) {
  const list = Array.isArray(cues) ? [...cues] : [];
  if (!list.length) throw new SrtError('subtitle_srt_empty');
  if (list.length > maxCues) {
    throw new SrtError('subtitle_cue_count_exceeded', `${list.length}>${maxCues}`);
  }
  list.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const out = [];
  for (const cue of list) {
    const text = String(cue.text || '').trim();
    if (!text) throw new SrtError('subtitle_cue_text_empty', `cue#${cue.index}`);
    if (!Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs)
      || cue.startMs < 0 || cue.endMs <= cue.startMs) {
      throw new SrtError('subtitle_cue_invalid_timing', `cue#${cue.index}`);
    }
    let endMs = cue.endMs;
    if (videoDurationMs !== null && Number.isFinite(videoDurationMs)) {
      if (cue.startMs > videoDurationMs + startSlackMs) {
        throw new SrtError('subtitle_cue_beyond_duration', `cue#${cue.index}`);
      }
      endMs = Math.min(endMs, videoDurationMs);
      if (endMs - cue.startMs < minVisibleMs) {
        // Fully (or almost fully) past the end of the video after clamping.
        throw new SrtError('subtitle_cue_beyond_duration', `cue#${cue.index}`);
      }
    }
    out.push({ index: cue.index, startMs: cue.startMs, endMs, text });
  }
  return out;
}

/** sha256-friendly canonical text of the cues actually burned (for artifacts). */
export function canonicalCueText(cues) {
  return cues
    .map((c) => `${c.index}|${c.startMs}|${c.endMs}|${c.text.replace(/\n/g, '\\n')}`)
    .join('\n');
}

export default parseSrt;
