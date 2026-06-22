#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.affiliate.credential-vault.plist" 2>/dev/null || true
