#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

from publisher.config import load_config
from publisher.publisher import PublisherEngine
from publisher.security import redact_error


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--page-id", required=True)
    parser.add_argument("--count", type=int, default=3)
    args = parser.parse_args()
    count = max(1, min(args.count, 20))
    engine = PublisherEngine(load_config(args.config))
    completed = []
    for index in range(1, count + 1):
        print(f"[{index}/{count}] เริ่ม resolve + download + avatar compose", flush=True)
        try:
            result = engine.run_page(args.page_id, shadow=True, trigger="manual")
        except Exception as exc:
            print(f"[{index}/{count}] ERROR {redact_error(exc)}", flush=True)
            return 1
        if not result.get("ok"):
            print(f"[{index}/{count}] BLOCKED {result.get('reason') or result.get('state')}", flush=True)
            return 2
        completed.append({
            "attempt_id": result.get("attempt_id"),
            "studio_content_id": result.get("studio_content_id"),
            "state": result.get("state"),
            "source_bytes": result.get("source_bytes"),
            "source_sha256": result.get("source_sha256"),
            "output_path": result.get("output_path"),
        })
        print(
            f"[{index}/{count}] OK content={result.get('studio_content_id')} "
            f"state={result.get('state')} bytes={result.get('source_bytes')}",
            flush=True,
        )
    report = args.config.parent / "shadow-last.json"
    report.write_text(json.dumps({"ok": True, "count": len(completed), "items": completed}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[DONE] shadow={len(completed)}/{count} report={report}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
