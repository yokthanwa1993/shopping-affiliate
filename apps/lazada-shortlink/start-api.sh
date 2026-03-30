#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_BIN="${VENV_BIN:-$HOME/.codex/venvs/lazada-shortlink/bin}"
PYTHON_BIN="${PYTHON_BIN:-$VENV_BIN/python}"

export PATH="${VENV_BIN}:${PATH}"
export PREWARM_BROWSER="${PREWARM_BROWSER:-1}"
export BROWSER_HEADED="${BROWSER_HEADED:-1}"
export BROWSER_PROFILE="${BROWSER_PROFILE:-CHEARB}"
export BROWSER_SESSION="${BROWSER_SESSION:-lazada-shortlink-chearb-headed}"

cd "${APP_DIR}"

exec "${PYTHON_BIN}" -u server.py
