FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ARG NODE_MAJOR=20
ARG KASMVNC_DEB_URL=https://github.com/kasmtech/KasmVNC/releases/download/v1.3.3/kasmvncserver_jammy_1.3.3_amd64.deb

RUN apt-get update && apt-get install -y \
  ca-certificates \
  curl \
  dbus-x11 \
  fonts-noto \
  fonts-noto-color-emoji \
  gnupg \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcairo2 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libexpat1 \
  libfontconfig1 \
  libgbm1 \
  libglib2.0-0 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libpango-1.0-0 \
  libpangocairo-1.0-0 \
  libu2f-udev \
  libuuid1 \
  libx11-6 \
  libx11-xcb1 \
  libxcb-dri3-0 \
  libxcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxkbcommon0 \
  libxrandr2 \
  libxshmfence1 \
  libxss1 \
  libxtst6 \
  openbox \
  openssl \
  procps \
  xauth \
  && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
  && apt-get update \
  && apt-get install -y nodejs \
  && curl -fsSL -o /tmp/kasmvnc.deb "${KASMVNC_DEB_URL}" \
  && apt-get install -y /tmp/kasmvnc.deb \
  && rm -f /tmp/kasmvnc.deb \
  && rm -rf /var/lib/apt/lists/*

RUN useradd -u 1000 -ms /bin/bash shortlink \
  && mkdir -p /app /data \
  && chown -R shortlink:shortlink /app /data

USER shortlink
WORKDIR /app

COPY --chown=shortlink:shortlink electron/package.json ./package.json
RUN npm install

COPY --chown=shortlink:shortlink electron/main.js ./main.js
COPY --chown=shortlink:shortlink electron/main-neezs.js ./main-neezs.js
COPY --chown=shortlink:shortlink electron/icons ./icons
COPY --chown=shortlink:shortlink docker/entrypoint.sh /app/entrypoint.sh

RUN chmod +x /app/entrypoint.sh

ENV SHORTLINK_MAIN=main.js
ENV SHORTLINK_VNC_PORT=8443
ENV SHORTLINK_HTTP_PORT=3000
ENV SHORTLINK_DISPLAY=:1
ENV SHORTLINK_WIDTH=1440
ENV SHORTLINK_HEIGHT=900
ENV SHORTLINK_USER_DATA_DIR=/data/user-data

EXPOSE 3000 8443

CMD ["/app/entrypoint.sh"]
