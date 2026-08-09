from __future__ import annotations

import os
import re
import stat
from pathlib import Path


class SecretError(RuntimeError):
    pass


def _secure_file(path: Path) -> None:
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
    except OSError as exc:
        raise SecretError("secret_file_missing") from exc
    if mode & 0o077:
        raise SecretError("secret_file_permissions_too_open")


def read_secret_file(path: Path) -> str:
    _secure_file(path)
    value = path.read_text(encoding="utf-8").strip()
    if not value:
        raise SecretError("secret_file_empty")
    return value


def read_env_value(path: Path, name: str) -> str:
    _secure_file(path)
    pattern = re.compile(r"^(?:export\s+)?" + re.escape(name) + r"\s*=\s*(.*)$")
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        match = pattern.match(raw_line.strip())
        if not match:
            continue
        value = match.group(1).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        if value:
            return value
    raise SecretError(f"secret_env_missing:{name}")


def discord_bot_token(env_file: Path) -> str:
    value = os.environ.get("DISCORD_BOT_TOKEN", "").strip()
    return value or read_env_value(env_file, "DISCORD_BOT_TOKEN")


def idbridge_service_auth(auth_file: Path) -> str:
    value = os.environ.get("IDBRIDGE_SERVICE_AUTH", "").strip()
    return value or read_secret_file(auth_file)


def redact_error(value: object, limit: int = 240) -> str:
    text = str(value or "").replace(chr(13), " ").replace(chr(10), " ")
    text = re.sub(
        r"(?i)(authorization)\s*[:=]\s*Bearer\s+[^\s,;}]+",
        r"\1=[REDACTED]",
        text,
    )
    text = re.sub(r"(?i)Bearer\s+[A-Za-z0-9._~-]+", "Bearer [REDACTED]", text)
    text = re.sub(
        r"(?i)(access[_-]?token|cookie|authorization|x-bridge-token|password|secret)\s*[:=]\s*[^\s,;}]+",
        r"\1=[REDACTED]",
        text,
    )
    return text[:limit]
