import config from './config.js';
import { openDb } from './db.js';
import { DiscordService } from './discord.js';
import { NativeFfmpegProcessor } from './processor.js';
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
  const processor = new NativeFfmpegProcessor(config.processor);
  const service = new ProcessingService({
    cfg: config,
    db,
    discord,
    processor,
  });

  try {
    const connected = await discord.connect();
    if (!connected) {
      console.error(`admin-media-drive processor: Discord not ready - ${discord.error}`);
      process.exitCode = 1;
      return;
    }

    do {
      const job = await service.runNext();
      if (job) {
        console.log(`admin-media-drive processor: job ${job.id} ${job.status}`);
      } else {
        console.log('admin-media-drive processor: no queued jobs');
      }
      if (once) break;
      await sleep(config.processor.pollMs);
    } while (true);
  } finally {
    db.close();
    discord.client.destroy();
  }
}

main().catch((error) => {
  console.error(`admin-media-drive processor: ${error?.message || 'failed'}`);
  process.exitCode = 1;
});
