#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
launchctl print "gui/$(id -u)/com.affiliate.credential-vault"
