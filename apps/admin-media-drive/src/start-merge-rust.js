import config from './config.js';
import { MergeRustProcessManager, superviseMergeRust } from './merge-rust-bridge.js';

// Foreground merge-rust supervisor: launchd entrypoint for
// com.affiliate.admin-media-drive.merge-rust and `npm run start:merge-rust`.
//
// Exit-code contract (the plist uses KeepAlive/SuccessfulExit=false):
//   0 = nothing local to supervise (external MERGE_RUST_URL) or clean
//       SIGINT/SIGTERM stop — launchd leaves the agent stopped;
//   1 = the supervised service died or could not start — launchd restarts it.
async function main() {
  const manager = new MergeRustProcessManager(config.processor);
  let shuttingDown = false;
  const stop = async () => {
    shuttingDown = true;
    await manager.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    await superviseMergeRust(manager, { log: console.log });
  } catch (error) {
    if (shuttingDown) return;
    console.error(`merge-rust service failed: ${error?.message || 'failed'}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`merge-rust service failed: ${error?.message || 'failed'}`);
  process.exitCode = 1;
});
