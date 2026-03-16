#!/bin/sh
set -eu

envsubst '${VITE_SERVER_URL} ${VITE_BROWSERSAVING_API_URL} ${VITE_COMMENT_TOKEN_SERVICE_URL} ${VITE_REMOTE_LAUNCHER_URL}' \
  < /opt/browsersaving/runtime-config.template.js \
  > /usr/share/nginx/html/runtime-config.js
