#!/usr/bin/env bash
set -euo pipefail

LABEL="com.affiliate.facebook-token-cloak"
APP_DIR="/Users/yok-macmini/Developer/shopping-affiliate/apps/facebook-token-cloak"
USER_HOME="/Users/yok-macmini"
PLIST_NAME="${LABEL}.plist"
SOURCE_PLIST="${APP_DIR}/launchd/${PLIST_NAME}"
LAUNCH_AGENTS="${USER_HOME}/Library/LaunchAgents"
TARGET_PLIST="${LAUNCH_AGENTS}/${PLIST_NAME}"
UID_VALUE="$(id -u)"
DOMAIN="gui/${UID_VALUE}"
SERVICE_TARGET="${DOMAIN}/${LABEL}"

mkdir -p "$LAUNCH_AGENTS" "${USER_HOME}/Library/Logs"
if [ ! -f "$TARGET_PLIST" ]; then
  cp "$SOURCE_PLIST" "$TARGET_PLIST"
fi
plutil -lint "$TARGET_PLIST"

if launchctl print "$SERVICE_TARGET" >/dev/null 2>&1; then
  printf '%s is already bootstrapped.\n' "$SERVICE_TARGET"
else
  launchctl bootstrap "$DOMAIN" "$TARGET_PLIST"
  printf 'Bootstrapped %s from %s\n' "$SERVICE_TARGET" "$TARGET_PLIST"
fi

launchctl enable "$SERVICE_TARGET" 2>/dev/null || true

if launchctl print "$SERVICE_TARGET" 2>/dev/null | grep -q 'pid ='; then
  printf '%s is already running.\n' "$SERVICE_TARGET"
else
  launchctl kickstart "$SERVICE_TARGET"
  printf 'Started %s\n' "$SERVICE_TARGET"
fi
