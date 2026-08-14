from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo


def slot_key(page_id: str, interval_minutes: int, at: Optional[int] = None) -> str:
    epoch = int(at if at is not None else datetime.now(tz=timezone.utc).timestamp())
    width = max(1, int(interval_minutes)) * 60
    start = epoch - (epoch % width)
    return f"{page_id}:{start}"


def manual_slot_key(page_id: str, index: int = 0, at: Optional[int] = None) -> str:
    epoch = int(at if at is not None else datetime.now(tz=timezone.utc).timestamp())
    return f"manual:{page_id}:{epoch}:{int(index)}"


def catch_up_due(next_due_at: Optional[int], now: int, interval_minutes: int) -> bool:
    if next_due_at is None:
        return True
    return int(next_due_at) <= int(now)


def local_day_window(timezone_name: str, at: Optional[int] = None) -> tuple[int, int]:
    epoch = int(at if at is not None else datetime.now(tz=timezone.utc).timestamp())
    local_now = datetime.fromtimestamp(epoch, ZoneInfo(timezone_name))
    start = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)
    return int(start.timestamp()), int(end.timestamp())
