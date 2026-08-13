from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .config import load_config, safe_config_summary
from .ledger import Ledger
from .publisher import PublisherEngine
from .security import redact_error
from .server import PublisherHTTPServer


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Mac mini local organic Page publisher")
    result.add_argument("--config", type=Path, default=None)
    commands = result.add_subparsers(dest="command", required=True)
    commands.add_parser("migrate")
    commands.add_parser("status")
    run = commands.add_parser("run-once")
    run.add_argument("--page-id", required=True)
    run.add_argument("--write", action="store_true", help="Requires both write gates and operator approval")
    retry = commands.add_parser("retry-comment")
    retry.add_argument("--attempt-id", required=True)
    reconcile = commands.add_parser("reconcile-attempt")
    reconcile.add_argument("--attempt-id", required=True)
    resolve = commands.add_parser("resolve-no-post")
    resolve.add_argument("--attempt-id", required=True)
    resolve.add_argument("--evidence-code", required=True)
    commands.add_parser("serve")
    return result


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    try:
        config = load_config(args.config)
        if args.command == "migrate":
            ledger = Ledger(config.ledger_db)
            for page in config.pages:
                ledger.sync_page(page)
            print(json.dumps({"ok": True, "config": safe_config_summary(config)}, ensure_ascii=False))
            return 0
        if args.command == "resolve-no-post":
            if not config.writes_enabled:
                raise RuntimeError("external_writes_disabled")
            ledger = Ledger(config.ledger_db)
            ledger.resolve_unknown_no_post(args.attempt_id, args.evidence_code)
            print(json.dumps({
                "ok": True,
                "attempt_id": args.attempt_id,
                "state": "failed_pre_post",
                "evidence_code": args.evidence_code,
            }, ensure_ascii=False))
            return 0
        engine = PublisherEngine(config)
        if args.command == "status":
            print(json.dumps({"ok": True, "config": safe_config_summary(config), "status": engine.status()}, ensure_ascii=False))
            return 0
        if args.command == "run-once":
            result = engine.run_page(args.page_id, shadow=not args.write, trigger="manual")
            print(json.dumps(result, ensure_ascii=False))
            return 0 if result.get("ok") else 2
        if args.command == "retry-comment":
            result = engine.retry_comment(args.attempt_id)
            print(json.dumps(result, ensure_ascii=False))
            return 0
        if args.command == "reconcile-attempt":
            result = engine.reconcile_attempt(args.attempt_id)
            print(json.dumps(result, ensure_ascii=False))
            return 0
        if args.command == "serve":
            PublisherHTTPServer(engine).serve_forever()
            return 0
        return 2
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        print(json.dumps({"ok": False, "error": redact_error(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
