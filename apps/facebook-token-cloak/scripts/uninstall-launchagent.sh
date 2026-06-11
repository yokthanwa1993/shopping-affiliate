#!/usr/bin/env bash
set -euo pipefail

LABEL="com.affiliate.facebook-token-cloak"
APP_DIR="/Users/yok-macmini/Developer/shopping-affiliate/apps/facebook-token-cloak"
USER_HOME="/Users/yok-macmini"
TARGET_PLIST="${USER_HOME}/Library/LaunchAgents/${LABEL}.plist"

"$APP_DIR/scripts/stop-launchagent.sh"

if [ -f "$TARGET_PLIST" ]; then
  rm -f "$TARGET_PLIST"
  printf 'Removed %s\n' "$TARGET_PLIST"
else
  printf '%s is already removed.\n' "$TARGET_PLIST"
fi
