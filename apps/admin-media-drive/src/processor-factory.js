import { MergeRustPipelineProcessor } from './merge-rust-bridge.js';
import { NativeFfmpegProcessor } from './processor.js';

export function createProcessor(cfg) {
  const processorCfg = cfg?.processor || {};
  if (processorCfg.mode === 'ffmpeg') {
    return new NativeFfmpegProcessor(processorCfg);
  }
  return new MergeRustPipelineProcessor({
    namespaceId: cfg?.namespaceId || 'admin',
    processorConfig: processorCfg,
  });
}

export default createProcessor;
