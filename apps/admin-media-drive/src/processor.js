import { execFile as nodeExecFile } from 'node:child_process';

const MAX_BUFFER = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const TRANSCODE_TIMEOUT_MS = 30 * 60_000;

function execFileCapture(bin, args, {
  execFileImpl = nodeExecFile,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(bin, args, { timeout: timeoutMs, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function firstLine(text) {
  return String(text || '').split(/\r?\n/).find(Boolean) || '';
}

export async function commandVersion(bin, {
  execFileImpl = nodeExecFile,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  try {
    const { stdout, stderr } = await execFileCapture(bin, ['-version'], { execFileImpl, timeoutMs });
    return { present: true, version: firstLine(stdout || stderr) };
  } catch (error) {
    return { present: false, version: '', error: error?.code || error?.message || 'not_found' };
  }
}

export function parseEncoderAvailability(output) {
  return {
    h264Videotoolbox: /\bh264_videotoolbox\b/.test(output),
    libx264: /\blibx264\b/.test(output),
  };
}

export async function listEncoderAvailability(ffmpegBin, {
  execFileImpl = nodeExecFile,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  try {
    const { stdout, stderr } = await execFileCapture(
      ffmpegBin,
      ['-hide_banner', '-encoders'],
      { execFileImpl, timeoutMs },
    );
    return { ok: true, ...parseEncoderAvailability(`${stdout}\n${stderr}`) };
  } catch {
    return { ok: false, h264Videotoolbox: false, libx264: false };
  }
}

export async function selectVideoEncoder({
  ffmpegBin = 'ffmpeg',
  preference = 'auto',
  platform = process.platform,
  execFileImpl = nodeExecFile,
} = {}) {
  const normalized = String(preference || 'auto').trim().toLowerCase();
  const availability = await listEncoderAvailability(ffmpegBin, { execFileImpl });

  if (normalized === 'libx264') {
    return {
      selected: 'libx264',
      preference: normalized,
      availability,
      reason: 'forced_libx264',
    };
  }

  if (
    (normalized === 'h264_videotoolbox' || (normalized === 'auto' && platform === 'darwin'))
    && availability.h264Videotoolbox
  ) {
    return {
      selected: 'h264_videotoolbox',
      preference: normalized,
      availability,
      reason: normalized === 'h264_videotoolbox' ? 'forced_available' : 'macos_available',
    };
  }

  return {
    selected: 'libx264',
    preference: normalized,
    availability,
    reason: normalized === 'h264_videotoolbox' ? 'videotoolbox_unavailable' : 'fallback_libx264',
  };
}

export const SCALE_FILTER = [
  [
    "scale=w='if(gte(iw,ih),min(1280,iw),min(720,iw))'",
    "h='if(gte(iw,ih),min(720,ih),min(1280,ih))'",
    'force_original_aspect_ratio=decrease',
  ].join(':'),
  'scale=trunc(iw/2)*2:trunc(ih/2)*2',
  'format=yuv420p',
].join(',');

export function buildScaleFilter() {
  return SCALE_FILTER;
}

export function buildFfmpegArgs({ inputPath, outputPath, encoder = 'libx264' }) {
  const videoArgs = encoder === 'h264_videotoolbox'
    ? ['-c:v', 'h264_videotoolbox', '-allow_sw', '1', '-b:v', '2500k', '-maxrate', '3000k', '-bufsize', '6000k']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high'];

  return [
    '-hide_banner',
    '-y',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-dn',
    '-sn',
    '-vf', buildScaleFilter(),
    ...videoArgs,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-f', 'mp4',
    outputPath,
  ];
}

export async function probeMedia(inputPath, {
  ffprobeBin = 'ffprobe',
  execFileImpl = nodeExecFile,
} = {}) {
  const { stdout } = await execFileCapture(ffprobeBin, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    inputPath,
  ], { execFileImpl });
  return JSON.parse(stdout || '{}');
}

export async function runFfmpeg({
  ffmpegBin = 'ffmpeg',
  inputPath,
  outputPath,
  encoder,
  execFileImpl = nodeExecFile,
}) {
  const args = buildFfmpegArgs({ inputPath, outputPath, encoder });
  await execFileCapture(ffmpegBin, args, {
    execFileImpl,
    timeoutMs: TRANSCODE_TIMEOUT_MS,
  });
  return { outputPath, args };
}

export class NativeFfmpegProcessor {
  constructor({
    ffmpegBin = 'ffmpeg',
    ffprobeBin = 'ffprobe',
    videoEncoder = 'auto',
    execFileImpl = nodeExecFile,
    platform = process.platform,
  } = {}) {
    this.ffmpegBin = ffmpegBin;
    this.ffprobeBin = ffprobeBin;
    this.videoEncoder = videoEncoder;
    this.execFileImpl = execFileImpl;
    this.platform = platform;
    this.inputMode = 'file';
  }

  async health() {
    const [ffmpeg, ffprobe, encoder] = await Promise.all([
      commandVersion(this.ffmpegBin, { execFileImpl: this.execFileImpl }),
      commandVersion(this.ffprobeBin, { execFileImpl: this.execFileImpl }),
      selectVideoEncoder({
        ffmpegBin: this.ffmpegBin,
        preference: this.videoEncoder,
        platform: this.platform,
        execFileImpl: this.execFileImpl,
      }),
    ]);

    return {
      ffmpeg,
      ffprobe,
      encoder: {
        preference: encoder.preference,
        selected: encoder.selected,
        reason: encoder.reason,
        h264VideotoolboxAvailable: encoder.availability.h264Videotoolbox,
        libx264Available: encoder.availability.libx264,
      },
    };
  }

  async processVideo({ inputPath, outputPath }) {
    await probeMedia(inputPath, {
      ffprobeBin: this.ffprobeBin,
      execFileImpl: this.execFileImpl,
    });
    const encoder = await selectVideoEncoder({
      ffmpegBin: this.ffmpegBin,
      preference: this.videoEncoder,
      platform: this.platform,
      execFileImpl: this.execFileImpl,
    });
    await runFfmpeg({
      ffmpegBin: this.ffmpegBin,
      inputPath,
      outputPath,
      encoder: encoder.selected,
      execFileImpl: this.execFileImpl,
    });
    return { outputPath, encoder: encoder.selected };
  }
}

export default NativeFfmpegProcessor;
