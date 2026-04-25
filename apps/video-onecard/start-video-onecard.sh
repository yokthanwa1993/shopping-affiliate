#!/bin/zsh

set -euo pipefail

APP_DIR="/Users/yok-macmini/Developer/shopping-affiliate/apps/video-onecard"
ELECTRON_BIN="$APP_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
ELECTRON_PLIST="$APP_DIR/node_modules/electron/dist/Electron.app/Contents/Info.plist"
ENTRYPOINT="$APP_DIR/electron.js"

if [[ ! -x "$ELECTRON_BIN" ]]; then
  echo "Missing Electron binary at $ELECTRON_BIN" >&2
  exit 1
fi

if [[ "$(uname -s)" == "Darwin" && -f "$ELECTRON_PLIST" && -x /usr/libexec/PlistBuddy ]]; then
  /usr/libexec/PlistBuddy -c "Set :LSUIElement true" "$ELECTRON_PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$ELECTRON_PLIST" 2>/dev/null \
    || true
fi

cd "$APP_DIR"
exec "$ELECTRON_BIN" "$ENTRYPOINT"
