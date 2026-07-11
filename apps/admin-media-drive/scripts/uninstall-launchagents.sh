#!/bin/bash
# Stop and remove the admin-media-drive LaunchAgents. Leaves the app files,
# .env, SQLite index, and logs untouched.
set -uo pipefail

TARGET_DIR="${HOME}/Library/LaunchAgents"
GUI_DOMAIN="gui/$(id -u)"
LABELS=(
  "com.affiliate.admin-media-drive.api"
  "com.affiliate.admin-media-drive.worker"
  "com.affiliate.admin-media-drive.merge-rust"
)

for label in "${LABELS[@]}"; do
  launchctl bootout "${GUI_DOMAIN}/${label}" 2>/dev/null \
    && echo "uninstall-launchagents: stopped ${label}" \
    || echo "uninstall-launchagents: ${label} was not running"
  if [ -f "${TARGET_DIR}/${label}.plist" ]; then
    rm -f "${TARGET_DIR}/${label}.plist"
    echo "uninstall-launchagents: removed ${TARGET_DIR}/${label}.plist"
  fi
done
echo "uninstall-launchagents: done"
