"""Job status: Redis hash `job:{id}:status` mirrored to `status.json` (spec 3.2, E2)."""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path


class UserFacingError(Exception):
    """An error whose message is shown to the end user (Korean sentence)."""


MSG_CONVERT_FAILED = "영상을 변환하지 못했습니다. 다른 파일로 다시 시도해 주세요."
MSG_LIMIT = "30분 이하, 4K 이하 영상만 지원합니다."
MSG_ANALYZE_FAILED = "영상을 분석하지 못했습니다. 다른 파일로 다시 시도해 주세요."
MSG_RENDER_FAILED = "영상을 렌더링하지 못했습니다. 잠시 후 다시 시도해 주세요."
MSG_PROPAGATE_FAILED = "추적에 실패했습니다. 구간을 직접 지정해 주세요."


def data_dir() -> Path:
    return Path(os.environ.get("DATA_DIR", "/data"))


def job_dir_of(job_id: str, base: Path | None = None) -> Path:
    return (base or data_dir()) / "jobs" / job_id


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def atomic_write_json(path: Path, doc) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


class StatusWriter:
    """Writes job status to Redis and to /data/jobs/{id}/status.json."""

    def __init__(self, redis_client, base_dir: Path | None = None):
        self.r = redis_client
        self.base = base_dir or data_dir()

    def set(self, job_id: str, state: str, progress: int | None = None, error: str | None = None) -> None:
        job_dir = job_dir_of(job_id, self.base)
        fields = {
            "state": state,
            "progress": int(progress if progress is not None else (100 if state in ("ready", "rendered") else 0)),
            "error": error or "",
            "updatedAt": now_iso(),
        }
        self.r.hset(f"job:{job_id}:status", mapping=fields)
        if job_dir.is_dir():
            atomic_write_json(job_dir / "status.json", fields)

    def set_manual(self, job_id: str, manual_id: str, state: str) -> None:
        self.r.hset(f"job:{job_id}:manual:{manual_id}", mapping={"state": state, "updatedAt": now_iso()})
