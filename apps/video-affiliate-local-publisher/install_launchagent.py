#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import plistlib
import shutil
import subprocess
from pathlib import Path

LABEL = "com.affiliate.video-affiliate-local-publisher"
APP_ROOT = Path(__file__).resolve().parent
HOME = Path.home()
APP_SUPPORT = HOME / "Library/Application Support/VideoAffiliatePublisher"
LOG_ROOT = HOME / "Library/Logs/VideoAffiliatePublisher"
CONFIG = APP_SUPPORT / "config.json"
PLIST = HOME / "Library/LaunchAgents" / f"{LABEL}.plist"


def main() -> int:
    parser = argparse.ArgumentParser(description="Install the local publisher LaunchAgent")
    parser.add_argument("--enable-writes", action="store_true")
    parser.add_argument("--enable-scheduler", action="store_true")
    args = parser.parse_args()
    APP_SUPPORT.mkdir(parents=True, exist_ok=True)
    LOG_ROOT.mkdir(parents=True, exist_ok=True)
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    if not CONFIG.exists():
        shutil.copy2(APP_ROOT / "config.example.json", CONFIG)
        CONFIG.chmod(0o600)
    python = shutil.which("python3") or "/usr/bin/python3"
    environment = {
        "HOME": str(HOME),
        "PYTHONUNBUFFERED": "1",
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    }
    if args.enable_writes:
        environment["PUBLISHER_ALLOW_WRITES"] = "I_UNDERSTAND_EXTERNAL_SIDE_EFFECTS"
    if args.enable_scheduler:
        environment["PUBLISHER_SCHEDULER_ENABLED"] = "true"
    payload = {
        "Label": LABEL,
        "ProgramArguments": [python, str(APP_ROOT / "main.py"), "--config", str(CONFIG), "serve"],
        "WorkingDirectory": str(APP_ROOT),
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 10,
        "ProcessType": "Background",
        "StandardOutPath": str(LOG_ROOT / "publisher.log"),
        "StandardErrorPath": str(LOG_ROOT / "publisher.err.log"),
        "EnvironmentVariables": environment,
    }
    with PLIST.open("wb") as handle:
        plistlib.dump(payload, handle, sort_keys=False)
    domain = f"gui/{os.getuid()}"
    subprocess.run(["launchctl", "bootout", domain, str(PLIST)], capture_output=True, check=False)
    boot = subprocess.run(["launchctl", "bootstrap", domain, str(PLIST)], capture_output=True, text=True, check=False)
    if boot.returncode != 0:
        print(json.dumps({"ok": False, "error": "launchctl_bootstrap_failed"}))
        return 1
    print(json.dumps({
        "ok": True, "label": LABEL, "config_created": CONFIG.exists(),
        "writes_gate": bool(args.enable_writes),
        "scheduler_gate": bool(args.enable_scheduler),
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
