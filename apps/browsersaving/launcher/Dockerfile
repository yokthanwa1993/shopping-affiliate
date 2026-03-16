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
  iproute2 \
  openbox \
  procps \
  tar \
  xauth \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google.gpg \
  && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
  && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
  && apt-get update \
  && apt-get install -y google-chrome-stable nodejs \
  && curl -fsSL -o /tmp/kasmvnc.deb "${KASMVNC_DEB_URL}" \
  && apt-get install -y /tmp/kasmvnc.deb \
  && rm -f /tmp/kasmvnc.deb \
  && rm -rf /var/lib/apt/lists/*

RUN useradd -ms /bin/bash browser \
  && mkdir -p /data/sessions /app \
  && chown -R browser:browser /data /app

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .
RUN chown -R browser:browser /app /data \
  && chmod +x /app/docker-egress-entrypoint.sh

ENV PORT=8080
ENV SESSION_ROOT=/data/sessions
ENV WORKER_URL=https://browsersaving-worker.yokthanwa1993-bc9.workers.dev
ENV SESSION_PATH_PREFIX=/kasm
ENV DISPLAY_START=20
ENV DISPLAY_END=99
ENV KASM_PORT_START=8620
ENV KASM_PORT_END=8699
ENV CHROME_BIN=/usr/bin/google-chrome
ENV VNC_BIN=/usr/bin/vncserver
ENV SESSION_WIDTH=1440
ENV SESSION_HEIGHT=900

EXPOSE 8080

ENTRYPOINT ["/app/docker-egress-entrypoint.sh"]
CMD []
