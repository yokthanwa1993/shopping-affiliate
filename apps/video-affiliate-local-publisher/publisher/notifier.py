from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Iterable, Tuple


class Notifier:
    def __init__(self, helper: Path = Path.home() / ".hermes/scripts/notif_card.py"):
        self.helper = helper

    def send(self, title: str, color: str, fields: Iterable[Tuple[str, str, bool]]) -> bool:
        if not self.helper.is_file():
            return False
        command = ["/usr/bin/python3", str(self.helper), "--profile", "echo",
                   "--title", title[:120], "--color", color]
        for name, value, inline in fields:
            field = f"{name[:80]}:{value[:800]}" + (":inline" if inline else "")
            command.extend(["--field", field])
        proc = subprocess.run(command, capture_output=True, text=True, timeout=30, check=False)
        return proc.returncode == 0
