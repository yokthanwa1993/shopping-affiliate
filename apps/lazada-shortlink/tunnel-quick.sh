#!/usr/bin/env bash
set -euo pipefail

APP_URL="${APP_URL:-http://127.0.0.1:8800}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-$HOME/.codex/tools/cloudflared/cloudflared}"

if [[ ! -x "${CLOUDFLARED_BIN}" ]]; then
  echo "cloudflared not found at ${CLOUDFLARED_BIN}" >&2
  exit 1
fi

exec "${CLOUDFLARED_BIN}" tunnel --url "${APP_URL}"
