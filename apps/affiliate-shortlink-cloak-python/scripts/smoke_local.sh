#!/usr/bin/env bash
# Local smoke check: run the test suite (never launches a browser).
# Prefers pytest if installed, else falls back to stdlib unittest.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

export PYTHONPATH="src"

if python3 -c "import pytest" >/dev/null 2>&1; then
  echo "== running pytest =="
  python3 -m pytest -q
else
  echo "== pytest not found, running unittest discover =="
  python3 -m unittest discover -s tests -p 'test_*.py' -v
fi

echo
echo "== import + helper sanity =="
python3 - <<'PY'
from affiliate_shortlink_cloak_python import server
status, body = server.build_health("/tmp/x", 8811)
assert status == 200 and body["port"] == 8811, body
print("health OK:", body["app"], body["backend"], "port", body["port"])
PY
