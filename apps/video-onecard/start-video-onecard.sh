#!/bin/zsh

set -euo pipefail

APP_DIR="/Users/yok-macmini/Developer/shopping-affiliate/apps/video-onecard"
ELECTRON_BIN="$APP_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
ENTRYPOINT="$APP_DIR/electron.js"

if [[ ! -x "$ELECTRON_BIN" ]]; then
  echo "Missing Electron binary at $ELECTRON_BIN" >&2
  exit 1
fi

cd "$APP_DIR"
exec "$ELECTRON_BIN" "$ENTRYPOINT"
