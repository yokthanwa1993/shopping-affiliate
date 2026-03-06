#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_DIR="$ROOT_DIR/src-tauri"
WORKER_DIR="$ROOT_DIR/worker"
KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY:-$HOME/.tauri/browsersaving-updater.key}"
KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
if [[ -z "$KEY_PASSWORD" && -f "$HOME/.tauri/browsersaving-updater.password" ]]; then
  KEY_PASSWORD="$(cat "$HOME/.tauri/browsersaving-updater.password")"
fi
NOTES_FILE="${BROWSERSAVING_UPDATE_NOTES_FILE:-}"
VERSION="${BROWSERSAVING_UPDATE_VERSION:-$(jq -r '.version' "$TAURI_DIR/tauri.conf.json")}"
GITHUB_REPO="${BROWSERSAVING_UPDATE_GITHUB_REPO:-yokthanwa1993/shopping-affiliate}"
GITHUB_TAG="${BROWSERSAVING_UPDATE_GITHUB_TAG:-browsersaving-v${VERSION}}"
GITHUB_TITLE="${BROWSERSAVING_UPDATE_GITHUB_TITLE:-BrowserSaving v${VERSION}}"
CREATE_GITHUB_RELEASE="${BROWSERSAVING_UPDATE_CREATE_GITHUB_RELEASE:-1}"
UPDATER_SOURCE="${BROWSERSAVING_UPDATE_SOURCE:-github}"

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

cleanup_dmg_state() {
  local volume
  for volume in "/Volumes/BrowserSaving" "/Volumes/BrowserSaving 1" "/Volumes/BrowserSaving 2"; do
    if [[ -d "$volume" ]]; then
      hdiutil detach "$volume" >/dev/null 2>&1 || true
    fi
  done
  rm -f "$TAURI_DIR"/target/release/bundle/macos/rw.*.BrowserSaving_*.dmg
}

cleanup_dmg_state

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
ASSET_URL="https://github.com/${GITHUB_REPO}/releases/download/${GITHUB_TAG}/${ARTIFACT_NAME}"
DMG_BASENAME="BrowserSaving_${VERSION}_$(uname -m).dmg"
DMG_FILE="$(find "$TAURI_DIR/target/release/bundle/dmg" -maxdepth 1 -name '*.dmg' | head -n 1)"
DMG_OBJECT_KEY=""
if [[ -n "$DMG_FILE" ]]; then
  DMG_OBJECT_KEY="updates/browsersaving/${VERSION}/${PLATFORM}/${DMG_BASENAME}"
fi
TMP_MANIFEST="$(mktemp)"
trap 'rm -f "$TMP_MANIFEST"' EXIT

export VERSION NOTES PUB_DATE PLATFORM OBJECT_KEY SIGNATURE ASSET_URL UPDATER_SOURCE
python3 - "$TMP_MANIFEST" <<'PY'
import json
import os
import sys

entry = {
    "signature": os.environ["SIGNATURE"],
}
if os.environ.get("UPDATER_SOURCE") == "github":
    entry["url"] = os.environ["ASSET_URL"]
else:
    entry["object_key"] = os.environ["OBJECT_KEY"]

manifest = {
    "version": os.environ["VERSION"],
    "notes": os.environ["NOTES"],
    "pub_date": os.environ["PUB_DATE"],
    "platforms": {
        os.environ["PLATFORM"]: entry
    },
}

with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump(manifest, fh, ensure_ascii=False, indent=2)
PY

if [[ "$UPDATER_SOURCE" != "github" ]]; then
  wrangler --cwd "$WORKER_DIR" r2 object put "browsersaving/${OBJECT_KEY}" \
    --file "$ARTIFACT" \
    --content-type "application/gzip" \
    --remote
fi

if [[ "$UPDATER_SOURCE" != "github" && -n "$DMG_FILE" && -n "$DMG_OBJECT_KEY" ]]; then
  wrangler --cwd "$WORKER_DIR" r2 object put "browsersaving/${DMG_OBJECT_KEY}" \
    --file "$DMG_FILE" \
    --content-type "application/x-apple-diskimage" \
    --remote
fi

wrangler --cwd "$WORKER_DIR" r2 object put "browsersaving/updates/latest.json" \
  --file "$TMP_MANIFEST" \
  --content-type "application/json" \
  --cache-control "no-store" \
  --remote

if [[ "$CREATE_GITHUB_RELEASE" == "1" ]]; then
  if gh release view "$GITHUB_TAG" --repo "$GITHUB_REPO" >/dev/null 2>&1; then
    gh release edit "$GITHUB_TAG" --repo "$GITHUB_REPO" --title "$GITHUB_TITLE" --notes "$NOTES"
  else
    gh release create "$GITHUB_TAG" --repo "$GITHUB_REPO" --title "$GITHUB_TITLE" --notes "$NOTES"
  fi

  gh release upload "$GITHUB_TAG" "$ARTIFACT" "$SIG_FILE" --repo "$GITHUB_REPO" --clobber
  if [[ -n "$DMG_FILE" ]]; then
    gh release upload "$GITHUB_TAG" "$DMG_FILE#${DMG_BASENAME}" --repo "$GITHUB_REPO" --clobber
  fi
fi

echo "Published BrowserSaving update"
echo "Version: $VERSION"
echo "Platform: $PLATFORM"
if [[ "$UPDATER_SOURCE" == "github" ]]; then
  echo "Updater asset: $ASSET_URL"
else
  echo "Updater artifact: $OBJECT_KEY"
fi
echo "Manifest: https://browsersaving-worker.yokthanwa1993-bc9.workers.dev/api/updates/manifest"
if [[ "$UPDATER_SOURCE" != "github" && -n "$DMG_OBJECT_KEY" ]]; then
  echo "Installer: https://browsersaving-worker.yokthanwa1993-bc9.workers.dev/api/updates/download?key=${DMG_OBJECT_KEY}"
fi
if [[ "$CREATE_GITHUB_RELEASE" == "1" ]]; then
  echo "GitHub release: https://github.com/${GITHUB_REPO}/releases/tag/${GITHUB_TAG}"
fi
