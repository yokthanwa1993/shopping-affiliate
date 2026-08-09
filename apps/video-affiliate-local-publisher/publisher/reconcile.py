from __future__ import annotations

from typing import Any, Dict, List

from .ledger import Ledger


class Reconciler:
    """Fail-closed recovery classifier. It never retries a Facebook post."""

    def __init__(self, ledger: Ledger):
        self.ledger = ledger

    def pending(self) -> Dict[str, List[Dict[str, Any]]]:
        return {
            "unknown_post_outcomes": self.ledger.attempts_in_states(["post_outcome_unknown"]),
            "comment_only_retries": self.ledger.attempts_in_states(["post_success_comment_failed"]),
        }

    def assert_no_unknown_outcomes(self) -> None:
        if self.ledger.attempts_in_states(["post_outcome_unknown"]):
            raise RuntimeError("post_outcome_unknown_requires_live_readback")
