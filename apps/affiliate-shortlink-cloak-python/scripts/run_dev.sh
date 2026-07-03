#!/usr/bin/env bash
# Run the Python CloakBrowser shortlink prototype (test-only, port 8811).
# Not production: no LaunchAgent, no tunnel, does not touch port 8810.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-8811}"
export PROFILE_ROOT="${PROFILE_ROOT:-$HOME/.affiliate-shortlink-cloak-python/profiles}"

echo "starting affiliate-shortlink-cloak-python on $HOST:$PORT"
echo "profileRoot=$PROFILE_ROOT"

PYTHONPATH=src exec python3 -m affiliate_shortlink_cloak_python.server
