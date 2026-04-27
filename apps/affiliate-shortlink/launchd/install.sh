#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="/Users/yok-macmini/Developer/shopping-affiliate/apps/affiliate-shortlink"
LAUNCH_AGENTS="/Users/yok-macmini/Library/LaunchAgents"
UID_VALUE="$(id -u)"

mkdir -p "$LAUNCH_AGENTS" "/Users/yok-macmini/Library/Logs"
cp "$BASE_DIR/launchd/com.yok.affiliate-shortlink.plist" "$LAUNCH_AGENTS/com.yok.affiliate-shortlink.plist"
cp "$BASE_DIR/launchd/com.yok.affiliate-shortlink.tunnel.plist" "$LAUNCH_AGENTS/com.yok.affiliate-shortlink.tunnel.plist"

plutil -lint "$LAUNCH_AGENTS/com.yok.affiliate-shortlink.plist" "$LAUNCH_AGENTS/com.yok.affiliate-shortlink.tunnel.plist"

pm2 stop affiliate-shortlink cloudflared-tunnel 2>/dev/null || true
pm2 delete affiliate-shortlink cloudflared-tunnel 2>/dev/null || true
pm2 save --force 2>/dev/null || true
launchctl bootout "gui/${UID_VALUE}" "$LAUNCH_AGENTS/pm2.yok-macmini.plist" 2>/dev/null || true
launchctl disable "gui/${UID_VALUE}/com.PM2" 2>/dev/null || true

launchctl enable "gui/${UID_VALUE}/com.yok.affiliate-shortlink"
launchctl enable "gui/${UID_VALUE}/com.yok.affiliate-shortlink.tunnel"
launchctl bootout "gui/${UID_VALUE}" "$LAUNCH_AGENTS/com.yok.affiliate-shortlink.plist" 2>/dev/null || true
launchctl bootout "gui/${UID_VALUE}" "$LAUNCH_AGENTS/com.yok.affiliate-shortlink.tunnel.plist" 2>/dev/null || true
launchctl bootstrap "gui/${UID_VALUE}" "$LAUNCH_AGENTS/com.yok.affiliate-shortlink.plist"
launchctl bootstrap "gui/${UID_VALUE}" "$LAUNCH_AGENTS/com.yok.affiliate-shortlink.tunnel.plist"
