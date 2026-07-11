#!/bin/bash
# Status of the admin-media-drive LaunchAgents + local API/processor health.
# Read-only; prints no secrets.
set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUI_DOMAIN="gui/$(id -u)"
PORT="${PORT:-3100}"
LABELS=(
  "com.affiliate.admin-media-drive.merge-rust"
  "com.affiliate.admin-media-drive.api"
  "com.affiliate.admin-media-drive.worker"
)
# Note: the merge-rust agent showing "not running" with last exit code 0 is
# expected only when MERGE_RUST_URL is external (non-loopback).

for label in "${LABELS[@]}"; do
  echo "== ${label}"
  if launchctl print "${GUI_DOMAIN}/${label}" >/dev/null 2>&1; then
    launchctl print "${GUI_DOMAIN}/${label}" 2>/dev/null \
      | grep -E "state = |pid = |last exit code" \
      | sed 's/^[[:space:]]*/  /'
  else
    echo "  not loaded"
  fi
done

echo "== python venv"
if [ -x "${APP_DIR}/.venv/bin/python3" ]; then
  "${APP_DIR}/.venv/bin/python3" -c 'import PIL; print(f"  Pillow {PIL.__version__} OK")' 2>/dev/null \
    || echo "  venv present but Pillow import FAILED (re-run scripts/setup-python-venv.sh)"
else
  echo "  MISSING (${APP_DIR}/.venv) - subtitle gate fails closed until setup-python-venv.sh runs"
fi

echo "== http://127.0.0.1:${PORT}/api/health"
curl -sf --max-time 5 "http://127.0.0.1:${PORT}/api/health" | head -c 600 || echo "  API not reachable"
echo
echo "== http://127.0.0.1:${PORT}/api/processor/health"
curl -sf --max-time 15 "http://127.0.0.1:${PORT}/api/processor/health" | head -c 900 || echo "  processor health not reachable"
echo
echo "== logs: ~/Library/Logs/admin-media-drive/{api,worker,merge-rust}.log / .err.log"
