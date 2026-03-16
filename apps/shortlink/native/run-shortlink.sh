#!/usr/bin/env bash
set -euo pipefail

ACCOUNT_KEY="${SHORTLINK_ACCOUNT_KEY:-${1:-}}"
if [[ -z "${ACCOUNT_KEY}" ]]; then
  echo "SHORTLINK_ACCOUNT_KEY is required" >&2
  exit 1
fi

APP_DIR="${SHORTLINK_APP_DIR:-/home/yok/shortlink-native/electron}"
STATE_ROOT="${SHORTLINK_STATE_ROOT:-/home/yok/shortlink-native/state}"
STATE_DIR="${STATE_ROOT}/${ACCOUNT_KEY}"
LOG_DIR="${STATE_DIR}/logs"
VNC_DIR="${STATE_DIR}/.vnc"
RUNTIME_DIR="${STATE_DIR}/runtime"
XSTARTUP_PATH="${VNC_DIR}/xstartup"
KASM_CONFIG_PATH="${VNC_DIR}/kasmvnc.yaml"
KASM_PASSWORD_FILE="${STATE_DIR}/.kasmpasswd"
XAUTHORITY_FILE="${STATE_DIR}/.Xauthority"
CERT_PATH="${VNC_DIR}/selfsigned.crt"
KEY_PATH="${VNC_DIR}/selfsigned.key"

DISPLAY_NUM="${SHORTLINK_DISPLAY:-:43}"
DISPLAY_ID="${DISPLAY_NUM#:}"
VNC_PORT="${SHORTLINK_VNC_PORT:-8443}"
HTTP_PORT="${SHORTLINK_HTTP_PORT:-3000}"
WIDTH="${SHORTLINK_WIDTH:-1440}"
HEIGHT="${SHORTLINK_HEIGHT:-900}"
APP_MAIN="${SHORTLINK_MAIN:-main.js}"
USER_DATA_DIR="${SHORTLINK_USER_DATA_DIR:-${STATE_DIR}/user-data}"
READY_GRACE_SECONDS="${SHORTLINK_READY_GRACE_SECONDS:-120}"
MAX_UNHEALTHY_CHECKS="${SHORTLINK_MAX_UNHEALTHY_CHECKS:-6}"
KASM_USERNAME="${KASM_USERNAME:-shortlink}"
KASM_PASSWORD="${KASM_PASSWORD:-shortlink}"
OPENBOX_LOG="${LOG_DIR}/openbox.log"
ELECTRON_LOG="${LOG_DIR}/electron.log"
HOSTNAME_SHORT="$(hostname -s)"

mkdir -p "${STATE_DIR}" "${LOG_DIR}" "${VNC_DIR}" "${RUNTIME_DIR}" "${USER_DATA_DIR}"
chmod 700 "${RUNTIME_DIR}"
touch "${XAUTHORITY_FILE}"

if [[ ! -f "${CERT_PATH}" || ! -f "${KEY_PATH}" ]]; then
  openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout "${KEY_PATH}" \
    -out "${CERT_PATH}" \
    -days 3650 \
    -subj "/CN=shortlink-${ACCOUNT_KEY}" >/dev/null 2>&1
fi

if [[ ! -f "${KASM_PASSWORD_FILE}" ]] || ! grep -q "^${KASM_USERNAME}:" "${KASM_PASSWORD_FILE}" 2>/dev/null; then
  printf '%s\n%s\n' "${KASM_PASSWORD}" "${KASM_PASSWORD}" | \
    kasmvncpasswd -u "${KASM_USERNAME}" -w "${KASM_PASSWORD_FILE}" >/dev/null 2>&1
fi

cat > "${XSTARTUP_PATH}" <<EOF
#!/bin/sh
export DISPLAY=${DISPLAY_NUM}
export XAUTHORITY=${XAUTHORITY_FILE}
export XDG_RUNTIME_DIR=${RUNTIME_DIR}
mkdir -p "\${XDG_RUNTIME_DIR}"
chmod 700 "\${XDG_RUNTIME_DIR}"
openbox-session >>${OPENBOX_LOG} 2>&1 &
cd ${APP_DIR}
exec dbus-run-session ${APP_DIR}/node_modules/.bin/electron ${APP_DIR}/${APP_MAIN} \
  --no-sandbox \
  --ozone-platform=x11 \
  --enable-unsafe-swiftshader \
  --user-data-dir=${USER_DATA_DIR} >>${ELECTRON_LOG} 2>&1
EOF
chmod +x "${XSTARTUP_PATH}"

cat > "${KASM_CONFIG_PATH}" <<EOF
desktop:
  resolution:
    width: ${WIDTH}
    height: ${HEIGHT}
  allow_resize: true
  pixel_depth: 24
network:
  protocol: http
  interface: 0.0.0.0
  websocket_port: ${VNC_PORT}
  ssl:
    pem_certificate: ${CERT_PATH}
    pem_key: ${KEY_PATH}
    require_ssl: true
server:
  http:
    httpd_directory: /usr/share/kasmvnc/www
    headers:
      - Cross-Origin-Embedder-Policy=require-corp
      - Cross-Origin-Opener-Policy=same-origin
  advanced:
    kasm_password_file: ${KASM_PASSWORD_FILE}
command_line:
  prompt: false
EOF

cleanup() {
  kasmvncserver -kill "${DISPLAY_NUM}" >/dev/null 2>&1 || true
}

trap cleanup INT TERM EXIT

pkill -f "${APP_DIR}/${APP_MAIN}.*${USER_DATA_DIR}" >/dev/null 2>&1 || true
kasmvncserver -kill "${DISPLAY_NUM}" >/dev/null 2>&1 || true
rm -f "${VNC_DIR}"/*.pid "${VNC_DIR}"/*.log "${VNC_DIR}"/*.sock "/tmp/.X${DISPLAY_ID}-lock" "/tmp/.X11-unix/X${DISPLAY_ID}" >/dev/null 2>&1 || true

export DISPLAY="${DISPLAY_NUM}"
export XAUTHORITY="${XAUTHORITY_FILE}"
export SHORTLINK_HTTP_PORT="${HTTP_PORT}"

kasmvncserver "${DISPLAY_NUM}" \
  -config "${KASM_CONFIG_PATH}" \
  -interface 0.0.0.0 \
  -geometry "${WIDTH}x${HEIGHT}" \
  -depth 24 \
  -desktop "${HOSTNAME_SHORT}:${DISPLAY_ID} (${ACCOUNT_KEY})" \
  -httpd /usr/share/kasmvnc/www \
  -websocketPort "${VNC_PORT}" \
  -sslOnly \
  -KasmPasswordFile "${KASM_PASSWORD_FILE}" \
  -DisableBasicAuth=1 \
  -cert "${CERT_PATH}" \
  -key "${KEY_PATH}" \
  -xstartup "${XSTARTUP_PATH}" \
  -auth "${XAUTHORITY_FILE}" \
  -rfbport 5901 \
  -AcceptSetDesktopSize 1 \
  SecurityTypes=None

START_TS=$(date +%s)
UNHEALTHY_CHECKS=0

while true; do
  if ! pgrep -u "$(id -u)" -f "Xvnc ${DISPLAY_NUM} .*websocketPort ${VNC_PORT}" >/dev/null 2>&1; then
    echo "kasmvnc process exited" >&2
    exit 1
  fi

  if ! pgrep -u "$(id -u)" -f "electron.*${APP_MAIN}.*${USER_DATA_DIR}" >/dev/null 2>&1; then
    echo "electron process exited" >&2
    exit 1
  fi

  STATUS_JSON=""
  if STATUS_JSON=$(curl -fsS --max-time 5 "http://127.0.0.1:${HTTP_PORT}/livez" 2>/dev/null); then
    if grep -q '"server":true' <<<"${STATUS_JSON}" && grep -q '"webview":true' <<<"${STATUS_JSON}"; then
      UNHEALTHY_CHECKS=0
    elif (( $(date +%s) - START_TS >= READY_GRACE_SECONDS )); then
      UNHEALTHY_CHECKS=$((UNHEALTHY_CHECKS + 1))
      echo "shortlink livez unhealthy (${UNHEALTHY_CHECKS}/${MAX_UNHEALTHY_CHECKS}): ${STATUS_JSON}" >&2
      if (( UNHEALTHY_CHECKS >= MAX_UNHEALTHY_CHECKS )); then
        exit 1
      fi
    fi
  elif (( $(date +%s) - START_TS >= READY_GRACE_SECONDS )); then
    UNHEALTHY_CHECKS=$((UNHEALTHY_CHECKS + 1))
    echo "shortlink livez request failed (${UNHEALTHY_CHECKS}/${MAX_UNHEALTHY_CHECKS})" >&2
    if (( UNHEALTHY_CHECKS >= MAX_UNHEALTHY_CHECKS )); then
      exit 1
    fi
  fi

  sleep 10
done
