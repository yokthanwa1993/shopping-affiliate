#!/usr/bin/env bash
set -euo pipefail

LABEL="com.affiliate.facebook-token-cloak"
APP_DIR="/Users/yok-macmini/Developer/shopping-affiliate/apps/facebook-token-cloak"
USER_HOME="/Users/yok-macmini"
PLIST_NAME="${LABEL}.plist"
SOURCE_PLIST="${APP_DIR}/launchd/${PLIST_NAME}"
LAUNCH_AGENTS="${USER_HOME}/Library/LaunchAgents"
TARGET_PLIST="${LAUNCH_AGENTS}/${PLIST_NAME}"
LOG_DIR="${USER_HOME}/Library/Logs"

usage() {
  printf 'Usage: %s [--start]\n' "$0"
}

START_AFTER_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --start) START_AFTER_INSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

mkdir -p "$LAUNCH_AGENTS" "$LOG_DIR"
cp "$SOURCE_PLIST" "$TARGET_PLIST"

# BrowserSaving-style profile archive sync needs a local bridge key, but the key must never live in git.
# Prefer an exported ACCOUNTS_BRIDGE_API_KEY, otherwise reuse the existing local bridge key from the
# aff-developer env file when present. Only writes to the user's runtime LaunchAgent plist.
ENV_FILE="${USER_HOME}/.hermes/profiles/aff-developer/.env"
if [ -z "${ACCOUNTS_BRIDGE_API_KEY:-}" ] && [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
  ACCOUNTS_BRIDGE_API_KEY="${ACCOUNTS_BRIDGE_API_KEY:-${FACEBOOK_TOKEN_CLOAK_API_KEY:-}}"
fi
if [ -n "${ACCOUNTS_BRIDGE_API_KEY:-}" ]; then
  TARGET_PLIST="$TARGET_PLIST" ACCOUNTS_BRIDGE_API_KEY="$ACCOUNTS_BRIDGE_API_KEY" python3 - <<'PYENV'
import os, plistlib, pathlib
pl=pathlib.Path(os.environ['TARGET_PLIST'])
data=plistlib.loads(pl.read_bytes())
env=data.setdefault('EnvironmentVariables', {})
env['ACCOUNTS_BRIDGE_API_KEY']=os.environ['ACCOUNTS_BRIDGE_API_KEY']
pl.write_bytes(plistlib.dumps(data, sort_keys=False))
PYENV
  printf 'Accounts Bridge profile sync key: present=yes\n'
else
  printf 'Accounts Bridge profile sync key: present=no (sync will skip until configured)\n'
fi
plutil -lint "$TARGET_PLIST"

printf 'Installed %s\n' "$TARGET_PLIST"
printf 'Install does not start the service by default.\n'
printf 'Start: npm --prefix %s run launchd:start\n' "$APP_DIR"
printf 'Status: npm --prefix %s run launchd:status\n' "$APP_DIR"
printf 'Stop: npm --prefix %s run launchd:stop\n' "$APP_DIR"
printf 'Uninstall: npm --prefix %s run launchd:uninstall\n' "$APP_DIR"

if [ "$START_AFTER_INSTALL" -eq 1 ]; then
  "$APP_DIR/scripts/start-launchagent.sh"
fi
