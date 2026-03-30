#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STDOUT_LOG_PATH="${PROJECT_ROOT}/server.log"
STDERR_LOG_PATH="${PROJECT_ROOT}/server.err.log"
PYTHON_BIN="${PYTHON_BIN:-python3}"
CDP_PORT="${CDP_PORT:-9222}"
PYTHON_BIN_DIR="$(cd "$(dirname "${PYTHON_BIN}")" 2>/dev/null && pwd || true)"

"${PROJECT_ROOT}/launch-chrome-cdp.sh"

export PREWARM_BROWSER=0
export BROWSER_SESSION="${BROWSER_SESSION:-lazada-shortlink-cdp}"
export CDP_URL="${CDP_URL:-http://127.0.0.1:${CDP_PORT}}"
export CHROME_PROFILE_NAME="${CHROME_PROFILE_NAME:-CHEARB}"
if [[ -n "${PYTHON_BIN_DIR}" ]]; then
  export PATH="${PYTHON_BIN_DIR}:${PATH}"
fi

cd "${PROJECT_ROOT}"

"${PYTHON_BIN}" server.py >"${STDOUT_LOG_PATH}" 2>"${STDERR_LOG_PATH}"
