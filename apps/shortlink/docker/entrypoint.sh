#!/bin/sh
set -eu

APP_DIR=/app
HOME_DIR=${HOME:-/home/shortlink}
DISPLAY_NUM=${SHORTLINK_DISPLAY:-:1}
VNC_PORT=${SHORTLINK_VNC_PORT:-8443}
HTTP_PORT=${SHORTLINK_HTTP_PORT:-3000}
WIDTH=${SHORTLINK_WIDTH:-1440}
HEIGHT=${SHORTLINK_HEIGHT:-900}
USER_DATA_DIR=${SHORTLINK_USER_DATA_DIR:-/data/user-data}
APP_MAIN=${SHORTLINK_MAIN:-main.js}
READY_GRACE_SECONDS=${SHORTLINK_READY_GRACE_SECONDS:-120}
MAX_UNHEALTHY_CHECKS=${SHORTLINK_MAX_UNHEALTHY_CHECKS:-6}
RUNTIME_DIR=/tmp/runtime-shortlink
VNC_DIR="${HOME_DIR}/.vnc"
CERT_PATH="${VNC_DIR}/selfsigned.crt"
KEY_PATH="${VNC_DIR}/selfsigned.key"
XSTARTUP_PATH="${VNC_DIR}/xstartup"
KASM_CONFIG_PATH="${VNC_DIR}/kasmvnc.yaml"
KASM_PASSWORD_FILE="${HOME_DIR}/.kasmpasswd"
KASM_USERNAME=${KASM_USERNAME:-shortlink}
KASM_PASSWORD=${KASM_PASSWORD:-shortlink}
DE_SELECTED_MARKER="${VNC_DIR}/.de-was-selected"

mkdir -p "${VNC_DIR}" "${USER_DATA_DIR}" "${RUNTIME_DIR}"
chmod 700 "${RUNTIME_DIR}"
touch "${DE_SELECTED_MARKER}" "${HOME_DIR}/.Xauthority"

if [ ! -f "${CERT_PATH}" ] || [ ! -f "${KEY_PATH}" ]; then
  openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout "${KEY_PATH}" \
    -out "${CERT_PATH}" \
    -days 3650 \
    -subj "/CN=shortlink-kasm" >/dev/null 2>&1
fi

if [ ! -f "${KASM_PASSWORD_FILE}" ] || ! grep -q "^${KASM_USERNAME}:" "${KASM_PASSWORD_FILE}" 2>/dev/null; then
  printf '%s\n%s\n' "${KASM_PASSWORD}" "${KASM_PASSWORD}" | \
    kasmvncpasswd -u "${KASM_USERNAME}" -w "${KASM_PASSWORD_FILE}" >/dev/null 2>&1
fi

cat > "${XSTARTUP_PATH}" <<EOF
#!/bin/sh
export DISPLAY=${DISPLAY_NUM}
export XDG_RUNTIME_DIR=${RUNTIME_DIR}
mkdir -p "\${XDG_RUNTIME_DIR}"
chmod 700 "\${XDG_RUNTIME_DIR}"
openbox-session >/tmp/openbox.log 2>&1 &
cd ${APP_DIR}
exec dbus-run-session ${APP_DIR}/node_modules/.bin/electron ${APP_DIR}/${APP_MAIN} \
  --no-sandbox \
  --ozone-platform=x11 \
  --enable-unsafe-swiftshader \
  --user-data-dir=${USER_DATA_DIR}
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

rm -f "${VNC_DIR}"/*.pid "${VNC_DIR}"/*.log "${VNC_DIR}"/*.sock >/dev/null 2>&1 || true

kasmvncserver "${DISPLAY_NUM}" \
  -config "${KASM_CONFIG_PATH}" \
  -interface 0.0.0.0 \
  -geometry "${WIDTH}x${HEIGHT}" \
  -depth 24 \
  -httpd /usr/share/kasmvnc/www \
  -websocketPort "${VNC_PORT}" \
  -sslOnly \
  -KasmPasswordFile "${KASM_PASSWORD_FILE}" \
  -DisableBasicAuth=1 \
  -cert "${CERT_PATH}" \
  -key "${KEY_PATH}" \
  -xstartup "${XSTARTUP_PATH}" \
  SecurityTypes=None

START_TS=$(date +%s)
UNHEALTHY_CHECKS=0

while true; do
  if ! pgrep -u "$(id -u)" -f "electron.*${APP_MAIN}" >/dev/null 2>&1; then
    echo "electron process exited"
    exit 1
  fi
  if ! pgrep -u "$(id -u)" Xvnc >/dev/null 2>&1; then
    echo "kasmvnc process exited"
    exit 1
  fi

  STATUS_JSON=""
  if STATUS_JSON=$(curl -fsS --max-time 5 "http://127.0.0.1:${HTTP_PORT}/livez" 2>/dev/null); then
    if printf '%s' "${STATUS_JSON}" | grep -q '"server":true' && printf '%s' "${STATUS_JSON}" | grep -q '"webview":true'; then
      UNHEALTHY_CHECKS=0
    elif [ $(( $(date +%s) - START_TS )) -ge "${READY_GRACE_SECONDS}" ]; then
      UNHEALTHY_CHECKS=$((UNHEALTHY_CHECKS + 1))
      echo "shortlink livez unhealthy (${UNHEALTHY_CHECKS}/${MAX_UNHEALTHY_CHECKS})"
      echo "${STATUS_JSON}"
      if [ "${UNHEALTHY_CHECKS}" -ge "${MAX_UNHEALTHY_CHECKS}" ]; then
        echo "shortlink livez unhealthy for too long"
        exit 1
      fi
    fi
  elif [ $(( $(date +%s) - START_TS )) -ge "${READY_GRACE_SECONDS}" ]; then
    UNHEALTHY_CHECKS=$((UNHEALTHY_CHECKS + 1))
    echo "shortlink livez request failed (${UNHEALTHY_CHECKS}/${MAX_UNHEALTHY_CHECKS})"
    if [ "${UNHEALTHY_CHECKS}" -ge "${MAX_UNHEALTHY_CHECKS}" ]; then
      echo "shortlink livez unavailable for too long"
      exit 1
    fi
  fi

  sleep 10
done
