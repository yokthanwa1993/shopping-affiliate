#!/bin/bash
# LaunchAgent entrypoint for admin-media-drive (api | worker | merge-rust).
# - loads the login PATH via the plist's `zsh -lc` wrapper, so node/ffmpeg/cargo
#   resolve the same way they do in an interactive shell;
# - rotates oversized logs at (re)start so launchd logs stay bounded;
# - never prints or exports secrets: .env is loaded by the app itself (dotenv)
#   from the app working directory. GOOGLE_APPLICATION_CREDENTIALS in .env must
#   be a PATH to the service-account JSON, never the JSON body.
set -euo pipefail

APP_DIR="/Users/yok-macmini/Developer/shopping-affiliate/apps/admin-media-drive"
LOG_DIR="${HOME}/Library/Logs/admin-media-drive"
ROLE="${1:-api}"
MAX_LOG_BYTES=$((10 * 1024 * 1024))

mkdir -p "$LOG_DIR"

rotate_log() {
  local file="$1"
  if [ -f "$file" ]; then
    local size
    size=$(stat -f%z "$file" 2>/dev/null || echo 0)
    if [ "$size" -gt "$MAX_LOG_BYTES" ]; then
      mv -f "$file" "${file}.1"
    fi
  fi
}
rotate_log "$LOG_DIR/${ROLE}.log"
rotate_log "$LOG_DIR/${ROLE}.err.log"

cd "$APP_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "admin-media-drive launchd: node not found in PATH" >&2
  exit 78 # EX_CONFIG
fi
if [ ! -f "$APP_DIR/.env" ]; then
  echo "admin-media-drive launchd: $APP_DIR/.env missing - create it from .env.example" >&2
  exit 78
fi

case "$ROLE" in
  api)
    exec node src/server.js
    ;;
  worker)
    # The worker polls queued jobs one at a time. The merge-rust service is
    # owned by the dedicated merge-rust LaunchAgent; the worker only spawns it
    # as a per-job fallback when the local service is down (empty or loopback
    # MERGE_RUST_URL).
    exec node src/worker.js
    ;;
  merge-rust)
    # Foreground supervisor for the locally owned merge-rust service (cargo
    # run or MERGE_RUST_BIN). Exits 0 when MERGE_RUST_URL is external
    # (non-loopback) so KeepAlive/SuccessfulExit=false leaves the agent
    # stopped; exits 1 on crash so launchd restarts it.
    if ! command -v cargo >/dev/null 2>&1; then
      echo "admin-media-drive launchd: warning - cargo not in PATH; merge-rust auto-start needs cargo unless MERGE_RUST_BIN is set in .env" >&2
    fi
    exec node src/start-merge-rust.js
    ;;
  *)
    echo "admin-media-drive launchd: unknown role '$ROLE' (expected api|worker|merge-rust)" >&2
    exit 64 # EX_USAGE
    ;;
esac
