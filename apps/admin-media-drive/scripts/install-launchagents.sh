#!/bin/bash
# Install + start the admin-media-drive LaunchAgents (api on 127.0.0.1:3100 +
# processing worker + local merge-rust supervisor). Idempotent: re-running
# replaces the installed plists and restarts the agents. Run as the login user
# (not root, no sudo).
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_SRC_DIR="${APP_DIR}/launchd"
TARGET_DIR="${HOME}/Library/LaunchAgents"
GUI_DOMAIN="gui/$(id -u)"
# merge-rust first so the pipeline service is already warming up (cargo may
# compile on first boot) while the api/worker agents come online.
LABELS=(
  "com.affiliate.admin-media-drive.merge-rust"
  "com.affiliate.admin-media-drive.api"
  "com.affiliate.admin-media-drive.worker"
)

if [ ! -f "${APP_DIR}/.env" ]; then
  echo "install-launchagents: ${APP_DIR}/.env missing." >&2
  echo "  cp .env.example .env  # then fill DISCORD_BOT_TOKEN etc. locally" >&2
  exit 78
fi
if [ ! -x "${APP_DIR}/.venv/bin/python3" ]; then
  echo "install-launchagents: WARNING - managed Python venv missing." >&2
  echo "  The subtitle gate will fail closed (subtitle_python_missing) until you run:" >&2
  echo "  bash ${APP_DIR}/scripts/setup-python-venv.sh" >&2
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "install-launchagents: WARNING - cargo not in PATH." >&2
  echo "  The merge-rust supervisor needs cargo unless MERGE_RUST_BIN is set in .env." >&2
fi

mkdir -p "$TARGET_DIR" "${HOME}/Library/Logs/admin-media-drive"

for label in "${LABELS[@]}"; do
  src="${PLIST_SRC_DIR}/${label}.plist"
  dst="${TARGET_DIR}/${label}.plist"
  if [ ! -f "$src" ]; then
    echo "install-launchagents: missing template $src" >&2
    exit 66
  fi
  plutil -lint "$src" >/dev/null

  # Stop any previous instance before replacing the plist.
  launchctl bootout "${GUI_DOMAIN}/${label}" 2>/dev/null || true
  cp "$src" "$dst"
  # launchd tears the old job down asynchronously; an immediate re-bootstrap
  # of the same label can fail transiently (EIO "Input/output error").
  # Retry briefly instead of dying halfway through the agent list.
  bootstrapped=0
  bootstrap_err=""
  for _attempt in 1 2 3 4 5; do
    if bootstrap_err=$(launchctl bootstrap "$GUI_DOMAIN" "$dst" 2>&1); then
      bootstrapped=1
      break
    fi
    sleep 2
  done
  if [ "$bootstrapped" -ne 1 ]; then
    echo "install-launchagents: failed to bootstrap ${label}: ${bootstrap_err}" >&2
    exit 69 # EX_UNAVAILABLE
  fi
  launchctl enable "${GUI_DOMAIN}/${label}"
  echo "install-launchagents: installed + started ${label}"
done

echo "install-launchagents: done. Check with: bash ${APP_DIR}/scripts/status-launchagents.sh"
