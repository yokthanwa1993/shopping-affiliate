#!/usr/bin/env bash
set -euo pipefail

PORT="${CDP_PORT:-9222}"
CHROME_PROFILE_NAME="${CHROME_PROFILE_NAME:-CHEARB}"
CHROME_PROFILE_DIR="${CHROME_PROFILE_DIR:-}"
CHROME_USER_DATA_DIR="${CHROME_USER_DATA_DIR:-$HOME/Library/Application Support/Google/Chrome}"
CHROME_CANDIDATES=(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  "${HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
)
START_URLS=(
  "https://www.lazada.co.th/"
  "https://adsense.lazada.co.th/index.htm#/"
)

test_cdp_ready() {
  curl -fsS "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1
}

find_chrome_bin() {
  local candidate
  for candidate in "${CHROME_CANDIDATES[@]}"; do
    if [[ -x "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  return 1
}

resolve_profile_dir() {
  if [[ -n "${CHROME_PROFILE_DIR}" ]]; then
    printf '%s\n' "${CHROME_PROFILE_DIR}"
    return 0
  fi

  local local_state="${CHROME_USER_DATA_DIR}/Local State"
  [[ -f "${local_state}" ]] || return 1

  local info_json
  info_json="$(plutil -extract profile.info_cache json -o - "${local_state}" 2>/dev/null || true)"
  [[ -n "${info_json}" ]] || return 1

  printf '%s' "${info_json}" | CHROME_PROFILE_NAME="${CHROME_PROFILE_NAME}" perl -0ne '
    my $target = $ENV{CHROME_PROFILE_NAME} // q{};
    while (/"([^"]+)":\{[^{}]*"name":"([^"]+)"/g) {
      if ($2 eq $target) {
        print $1;
        exit 0;
      }
    }
    exit 1;
  '
}

CHROME_BIN="$(find_chrome_bin || true)"
if [[ -z "${CHROME_BIN}" ]]; then
  echo "Chrome not found in standard macOS locations" >&2
  exit 1
fi

PROFILE_DIR="$(resolve_profile_dir || true)"
if [[ -z "${PROFILE_DIR}" ]]; then
  echo "Chrome profile '${CHROME_PROFILE_NAME}' not found under ${CHROME_USER_DATA_DIR}" >&2
  exit 1
fi

if ! test_cdp_ready; then
  "${CHROME_BIN}" \
    --remote-debugging-port="${PORT}" \
    --user-data-dir="${CHROME_USER_DATA_DIR}" \
    --profile-directory="${PROFILE_DIR}" \
    --no-first-run \
    --no-default-browser-check \
    --new-window \
    "${START_URLS[@]}" \
    >/dev/null 2>&1 &
fi

for _ in $(seq 1 20); do
  if test_cdp_ready; then
    echo "CDP ready on 127.0.0.1:${PORT} using profile '${CHROME_PROFILE_NAME}' (${PROFILE_DIR})"
    exit 0
  fi
  sleep 1
done

echo "Chrome CDP endpoint did not start on port ${PORT} for profile '${CHROME_PROFILE_NAME}' (${PROFILE_DIR}). If Chrome is already running, close it and try again." >&2
exit 1
