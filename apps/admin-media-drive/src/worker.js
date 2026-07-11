import config from './config.js';
import { openDb } from './db.js';
import { DiscordService } from './discord.js';
import { createProcessor } from './processor-factory.js';
import { createSubtitleGate } from './subtitle-gate.js';
import { ProcessingService } from './processing-service.js';

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main() {
  const once = String(process.env.PROCESS_ONCE || '').trim() === '1';
  const db = openDb(config.dbPath);
  const discord = new DiscordService(config.discord);
  const processor = createProcessor(config);
  const service = new ProcessingService({
    cfg: config,
    db,
    discord,
    processor,
    subtitleGate: createSubtitleGate(config),
  });
  // Jobs stuck in 'processing' from a crashed worker run are re-queued once
  // they are clearly older than any legitimately running pipeline.
  const staleAfterMs = (config.processor.mergeRustJobTimeoutMs || 3_600_000) + 10 * 60_000;

  try {
    const connected = await discord.connect();
    if (!connected) {
      console.error(`admin-media-drive processor: Discord not ready - ${discord.error}`);
      process.exitCode = 1;
      return;
    }

    do {
      const recovered = db.recoverStaleProcessingJobs(config.namespaceId, {
        olderThanMs: staleAfterMs,
      });
      if (recovered > 0) {
        console.log(`admin-media-drive processor: re-queued ${recovered} stale processing job(s)`);
      }
      try {
        const job = await service.runNext();
        if (job) {
          console.log(`admin-media-drive processor: job ${job.id} ${job.status}`);
        } else {
          console.log('admin-media-drive processor: no queued jobs');
        }
      } catch (error) {
        // A failed job is recorded on the row (status=failed + error_category);
        // the long-lived worker moves on to the next queued job instead of
        // crash-looping under launchd KeepAlive.
        const jobId = error?.job?.id ? ` job ${error.job.id}` : '';
        console.error(`admin-media-drive processor:${jobId} failed - ${error?.message || 'processing_failed'}`);
        if (once) {
          process.exitCode = 1;
        }
      }
      if (once) break;
      await sleep(config.processor.pollMs);
    } while (true);
  } finally {
    if (processor?.close) await processor.close();
    db.close();
    discord.client.destroy();
  }
}

main().catch((error) => {
  console.error(`admin-media-drive processor: ${error?.message || 'failed'}`);
  process.exitCode = 1;
});
