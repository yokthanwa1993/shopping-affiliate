from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class SpoolError(RuntimeError):
    pass


@dataclass(frozen=True)
class VideoFile:
    path: Path
    bytes: int
    sha256: str
    duration: float
    width: int
    height: int


class Spool:
    def __init__(self, root: Path, ffprobe_bin: str = "ffprobe"):
        self.root = root
        self.ffprobe_bin = ffprobe_bin
        self.root.mkdir(parents=True, exist_ok=True)

    def attempt_dir(self, attempt_id: str) -> Path:
        safe = "".join(ch for ch in attempt_id if ch.isalnum() or ch in "-_")[:80]
        if not safe:
            raise SpoolError("attempt_id_invalid")
        path = self.root / safe
        path.mkdir(parents=True, exist_ok=True)
        return path

    def download(self, attempt_id: str, url: str, filename: str = "source.mp4",
                 max_bytes: int = 512 * 1024 * 1024, timeout: int = 180) -> VideoFile:
        if not str(url).startswith("https://"):
            raise SpoolError("source_url_invalid")
        path = self.attempt_dir(attempt_id) / filename
        partial = path.with_suffix(path.suffix + ".part")
        request = Request(url, headers={"User-Agent": "VideoAffiliateLocalPublisher/0.1"})
        total = 0
        digest = hashlib.sha256()
        try:
            with urlopen(request, timeout=timeout) as response, partial.open("wb") as handle:
                content_type = str(response.headers.get("content-type") or "").lower()
                if "video" not in content_type and "octet-stream" not in content_type:
                    raise SpoolError("source_content_type_invalid")
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_bytes:
                        raise SpoolError("source_too_large")
                    digest.update(chunk)
                    handle.write(chunk)
                handle.flush()
                os.fsync(handle.fileno())
        except HTTPError as exc:
            partial.unlink(missing_ok=True)
            raise SpoolError(f"source_http_{exc.code}") from exc
        except (URLError, TimeoutError, OSError):
            partial.unlink(missing_ok=True)
            raise SpoolError("source_download_failed")
        except Exception:
            partial.unlink(missing_ok=True)
            raise
        if total < 100_000:
            partial.unlink(missing_ok=True)
            raise SpoolError("source_too_small")
        partial.replace(path)
        return self.inspect(path, expected_sha=digest.hexdigest())

    def inspect(self, path: Path, expected_sha: str = "") -> VideoFile:
        if not path.is_file() or path.stat().st_size < 100_000:
            raise SpoolError("video_file_invalid")
        try:
            proc = subprocess.run([
                self.ffprobe_bin, "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=codec_name,width,height:format=duration,format_name",
                "-of", "json", str(path),
            ], capture_output=True, text=True, timeout=30, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise SpoolError("ffprobe_failed") from exc
        if proc.returncode != 0:
            raise SpoolError("ffprobe_invalid_video")
        try:
            payload = json.loads(proc.stdout)
            stream = payload["streams"][0]
            fmt = payload["format"]
            duration = float(fmt.get("duration") or 0)
            width = int(stream.get("width") or 0)
            height = int(stream.get("height") or 0)
            format_name = str(fmt.get("format_name") or "")
        except Exception as exc:
            raise SpoolError("ffprobe_response_invalid") from exc
        if duration <= 0 or width <= 0 or height <= 0 or "mp4" not in format_name:
            raise SpoolError("video_contract_invalid")
        sha = expected_sha or self.sha256(path)
        return VideoFile(path=path, bytes=path.stat().st_size, sha256=sha,
                         duration=duration, width=width, height=height)

    def archive_source(self, content_id: int, source: VideoFile) -> VideoFile:
        content = int(content_id)
        sha = str(source.sha256 or "").strip().lower()
        if content <= 0 or len(sha) != 64 or any(ch not in "0123456789abcdef" for ch in sha):
            raise SpoolError("source_archive_identity_invalid")
        if not source.path.is_file() or source.path.stat().st_size != int(source.bytes):
            raise SpoolError("source_archive_input_invalid")

        archive_root = self.root.parent / "source-archive"
        archive_root.mkdir(parents=True, exist_ok=True)
        archive_root.chmod(0o700)
        target = archive_root / f"content_{content}_{sha}.mp4"
        if target.exists():
            if target.stat().st_size != int(source.bytes) or self.sha256(target) != sha:
                raise SpoolError("source_archive_integrity_failed")
            target.chmod(0o600)
            return VideoFile(
                path=target, bytes=source.bytes, sha256=sha,
                duration=source.duration, width=source.width, height=source.height,
            )

        partial = archive_root / f".{target.name}.{os.getpid()}.part"
        digest = hashlib.sha256()
        total = 0
        try:
            with source.path.open("rb") as reader, partial.open("wb") as writer:
                while True:
                    chunk = reader.read(1024 * 1024)
                    if not chunk:
                        break
                    writer.write(chunk)
                    digest.update(chunk)
                    total += len(chunk)
                writer.flush()
                os.fsync(writer.fileno())
            if total != int(source.bytes) or digest.hexdigest() != sha:
                raise SpoolError("source_archive_integrity_failed")
            partial.chmod(0o600)
            os.replace(partial, target)
        except SpoolError:
            partial.unlink(missing_ok=True)
            raise
        except OSError as exc:
            partial.unlink(missing_ok=True)
            raise SpoolError("source_archive_failed") from exc
        return VideoFile(
            path=target, bytes=source.bytes, sha256=sha,
            duration=source.duration, width=source.width, height=source.height,
        )

    @staticmethod
    def sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def cleanup(self, attempt_id: str) -> None:
        safe = "".join(ch for ch in attempt_id if ch.isalnum() or ch in "-_")[:80]
        if not safe:
            return
        path = self.root / safe
        shutil.rmtree(path, ignore_errors=True)

    def adopt(self, probe_id: str, attempt_id: str) -> Path:
        source = self.root / "".join(ch for ch in probe_id if ch.isalnum() or ch in "-_")[:80]
        target = self.root / "".join(ch for ch in attempt_id if ch.isalnum() or ch in "-_")[:80]
        if not source.is_dir() or target.exists():
            raise SpoolError("spool_adopt_invalid")
        source.replace(target)
        return target
