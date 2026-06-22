#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.affiliate.credential-vault.plist" 2>/dev/null || true
launchctl kickstart "gui/$(id -u)/com.affiliate.credential-vault"
