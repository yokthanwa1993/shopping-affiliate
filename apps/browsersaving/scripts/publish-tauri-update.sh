#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_DIR="$ROOT_DIR/src-tauri"
WORKER_DIR="$ROOT_DIR/worker"
KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY:-$HOME/.tauri/browsersaving-updater.key}"
KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
NOTES_FILE="${BROWSERSAVING_UPDATE_NOTES_FILE:-}"
VERSION="${BROWSERSAVING_UPDATE_VERSION:-$(jq -r '.version' "$TAURI_DIR/tauri.conf.json")}"

if [[ -n "$NOTES_FILE" ]]; then
  NOTES="$(cat "$NOTES_FILE")"
else
  NOTES="${BROWSERSAVING_UPDATE_NOTES:-BrowserSaving ${VERSION}}"
fi

if [[ ! -f "$KEY_PATH" ]]; then
  echo "Missing updater private key: $KEY_PATH" >&2
  exit 1
fi

case "$(uname -m)" in
  arm64|aarch64)
    PLATFORM="darwin-aarch64"
    ;;
  x86_64)
    PLATFORM="darwin-x86_64"
    ;;
  *)
    echo "Unsupported architecture for updater publish: $(uname -m)" >&2
    exit 1
    ;;
esac

export TAURI_SIGNING_PRIVATE_KEY="$KEY_PATH"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$KEY_PASSWORD"

cd "$ROOT_DIR"
bun run tauri:build

ARTIFACT="$(find "$TAURI_DIR/target/release/bundle/macos" -maxdepth 1 -name '*.app.tar.gz' | head -n 1)"
if [[ -z "$ARTIFACT" ]]; then
  echo "Updater artifact not found (.app.tar.gz)" >&2
  exit 1
fi

SIG_FILE="${ARTIFACT}.sig"
if [[ ! -f "$SIG_FILE" ]]; then
  echo "Updater signature file not found: $SIG_FILE" >&2
  exit 1
fi

ARTIFACT_NAME="$(basename "$ARTIFACT")"
OBJECT_KEY="updates/browsersaving/${VERSION}/${PLATFORM}/${ARTIFACT_NAME}"
PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SIGNATURE="$(tr -d '\n' < "$SIG_FILE")"
TMP_MANIFEST="$(mktemp)"
trap 'rm -f "$TMP_MANIFEST"' EXIT

export VERSION NOTES PUB_DATE PLATFORM OBJECT_KEY SIGNATURE
python3 - "$TMP_MANIFEST" <<'PY'
import json
import os
import sys

manifest = {
    "version": os.environ["VERSION"],
    "notes": os.environ["NOTES"],
    "pub_date": os.environ["PUB_DATE"],
    "platforms": {
        os.environ["PLATFORM"]: {
            "signature": os.environ["SIGNATURE"],
            "object_key": os.environ["OBJECT_KEY"],
        }
    },
}

with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump(manifest, fh, ensure_ascii=False, indent=2)
PY

wrangler --cwd "$WORKER_DIR" r2 object put "browsersaving/${OBJECT_KEY}" \
  --file "$ARTIFACT" \
  --content-type "application/gzip" \
  --remote

wrangler --cwd "$WORKER_DIR" r2 object put "browsersaving/updates/latest.json" \
  --file "$TMP_MANIFEST" \
  --content-type "application/json" \
  --cache-control "no-store" \
  --remote

echo "Published BrowserSaving update"
echo "Version: $VERSION"
echo "Platform: $PLATFORM"
echo "Artifact: $OBJECT_KEY"
echo "Manifest: https://browsersaving-worker.yokthanwa1993-bc9.workers.dev/api/updates/manifest"
