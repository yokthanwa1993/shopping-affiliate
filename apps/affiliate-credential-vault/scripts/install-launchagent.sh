#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cp launchd/com.affiliate.credential-vault.plist "$HOME/Library/LaunchAgents/"
plutil -lint "$HOME/Library/LaunchAgents/com.affiliate.credential-vault.plist"
