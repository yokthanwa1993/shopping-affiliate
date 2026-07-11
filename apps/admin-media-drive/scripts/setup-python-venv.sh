#!/bin/bash
# Create/refresh the managed Python venv used by the subtitle gate.
# - Installs Pillow into apps/admin-media-drive/.venv ONLY (no global pip
#   mutation, no --user installs).
# - The gate uses SUBTITLE_PYTHON_BIN (default: <app>/.venv/bin/python3) and
#   fails closed with a sanitized category when this venv is missing.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${APP_DIR}/.venv"
PYTHON_BIN="${PYTHON3:-python3}"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "setup-python-venv: '$PYTHON_BIN' not found (set PYTHON3=/path/to/python3)" >&2
  exit 78
fi

echo "setup-python-venv: creating venv at $VENV_DIR"
"$PYTHON_BIN" -m venv "$VENV_DIR"
"$VENV_DIR/bin/pip" install --quiet --upgrade pip
"$VENV_DIR/bin/pip" install --quiet "pillow>=10,<12"

"$VENV_DIR/bin/python3" - <<'PYEOF'
import PIL
import PIL.Image
import PIL.ImageDraw
import PIL.ImageFont
print(f"setup-python-venv: Pillow {PIL.__version__} OK")
PYEOF

echo "setup-python-venv: done. Subtitle gate python: $VENV_DIR/bin/python3"
