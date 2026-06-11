#!/usr/bin/env bash
set -euo pipefail

LABEL="com.affiliate.facebook-token-cloak"
UID_VALUE="$(id -u)"
SERVICE_TARGET="gui/${UID_VALUE}/${LABEL}"

printf '$ launchctl print %s\n' "$SERVICE_TARGET"
launchctl print "$SERVICE_TARGET" || true

printf '\n$ lsof -nP -iTCP:8820 -sTCP:LISTEN\n'
if command -v lsof >/dev/null 2>&1; then
  lsof -nP -iTCP:8820 -sTCP:LISTEN || true
else
  printf 'lsof not found\n'
fi

printf '\n$ pgrep -fl "facebook-token-cloak|node .*bin/start.js"\n'
pgrep -fl 'facebook-token-cloak|node .*bin/start.js' || true
