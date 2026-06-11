#!/usr/bin/env bash
set -euo pipefail

LABEL="com.affiliate.facebook-token-cloak"
USER_HOME="/Users/yok-macmini"
TARGET_PLIST="${USER_HOME}/Library/LaunchAgents/${LABEL}.plist"
UID_VALUE="$(id -u)"
DOMAIN="gui/${UID_VALUE}"
SERVICE_TARGET="${DOMAIN}/${LABEL}"

if launchctl print "$SERVICE_TARGET" >/dev/null 2>&1; then
  if [ -f "$TARGET_PLIST" ]; then
    launchctl bootout "$DOMAIN" "$TARGET_PLIST"
  else
    launchctl bootout "$SERVICE_TARGET"
  fi
  printf 'Stopped %s\n' "$SERVICE_TARGET"
else
  printf '%s is not loaded.\n' "$SERVICE_TARGET"
fi
