#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-$HOME/.codex/tools/cloudflared/cloudflared}"
CONFIG_FILE="${CONFIG_FILE:-${APP_DIR}/cloudflared/config.yml}"

if [[ ! -x "${CLOUDFLARED_BIN}" ]]; then
  echo "cloudflared not found at ${CLOUDFLARED_BIN}" >&2
  exit 1
fi

if [[ ! -f "${CONFIG_FILE}" ]]; then
  echo "Missing config file: ${CONFIG_FILE}" >&2
  echo "Copy ${APP_DIR}/cloudflared/config.example.yml to ${CONFIG_FILE} and fill in tunnel details first." >&2
  exit 1
fi

exec "${CLOUDFLARED_BIN}" tunnel --config "${CONFIG_FILE}" run
