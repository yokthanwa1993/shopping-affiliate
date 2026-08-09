from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .spool import Spool, VideoFile


class AvatarError(RuntimeError):
    pass


class AvatarClient:
    def __init__(self, base_url: str, spool: Spool):
        self.base_url = base_url.rstrip("/")
        self.spool = spool

    def compose(self, source_url: str, avatar_url: str, output_path: Path,
                similarity: float = 0.30, blend: float = 0.10,
                timeout: int = 420, poll_seconds: float = 2.0) -> VideoFile:
        body = json.dumps({
            "video_url": source_url,
            "avatar_video_url": avatar_url,
            "chromakey_similarity": float(similarity),
            "chromakey_blend": float(blend),
        }).encode("utf-8")
        request = Request(self.base_url + "/avatar-compose/start", data=body, method="POST",
                          headers={"Content-Type": "application/json"})
        try:
            with urlopen(request, timeout=30) as response:
                payload = json.loads(response.read(1024 * 1024))
        except HTTPError as exc:
            raise AvatarError(f"avatar_start_http_{exc.code}") from exc
        except (URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise AvatarError("avatar_start_failed") from exc
        job_id = str(payload.get("job_id") or "").strip() if isinstance(payload, dict) else ""
        if not job_id:
            raise AvatarError("avatar_job_id_missing")
        deadline = time.monotonic() + timeout
        result_url = self.base_url + "/avatar-compose/result/" + job_id
        while time.monotonic() < deadline:
            try:
                with urlopen(Request(result_url), timeout=45) as response:
                    status = int(response.status)
                    content_type = str(response.headers.get("content-type") or "").lower()
                    data = response.read(512 * 1024 * 1024)
            except HTTPError as exc:
                if exc.code == 202:
                    time.sleep(poll_seconds)
                    continue
                raise AvatarError(f"avatar_result_http_{exc.code}") from exc
            except (URLError, TimeoutError) as exc:
                raise AvatarError("avatar_result_failed") from exc
            if status == 202:
                time.sleep(poll_seconds)
                continue
            if status != 200 or "video/mp4" not in content_type:
                raise AvatarError("avatar_result_invalid")
            if len(data) < 100_000:
                raise AvatarError("avatar_output_too_small")
            output_path.parent.mkdir(parents=True, exist_ok=True)
            partial = output_path.with_suffix(output_path.suffix + ".part")
            partial.write_bytes(data)
            partial.replace(output_path)
            return self.spool.inspect(output_path)
        raise AvatarError("avatar_job_timeout")
