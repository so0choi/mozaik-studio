"""Queue loop: `python -m mosaic_worker.main`.

Queues (spec 3.2) are checked in priority order propagate > render > analyze (E3) so a short manual
propagation is never stuck behind a long analysis. A message is moved atomically to
`processing:worker` (LMOVE, the non-blocking form of BLMOVE) and removed once handled; messages still
in `processing:worker` at startup are put back on their queue (E1).
"""
from __future__ import annotations

import json
import logging
import os
import re
import signal
import time
from pathlib import Path

import redis

from . import jobs as jobs_mod
from . import propagate as propagate_mod
from . import render as render_mod
from .status import (
    MSG_ANALYZE_FAILED, MSG_PROPAGATE_FAILED, MSG_RENDER_FAILED,
    StatusWriter, UserFacingError, job_dir_of,
)

log = logging.getLogger("mosaic_worker")

Q_ANALYZE, Q_RENDER, Q_PROPAGATE = "queue:analyze", "queue:render", "queue:propagate"
PRIORITY = [Q_PROPAGATE, Q_RENDER, Q_ANALYZE]
PROCESSING = "processing:worker"
PROCESSING_SRC = "processing:worker:src"  # raw message -> queue it came from
POLL_SEC = 0.5
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class Worker:
    def __init__(self, r, data_dir: Path):
        self.r = r
        self.data_dir = Path(data_dir)
        self.status = StatusWriter(r, self.data_dir)
        self._detector = None
        self.stop = False

    # ------------------------------------------------------------------ queue plumbing
    def requeue_processing(self) -> int:
        """Put unfinished messages from a previous (crashed) run back on their queues."""
        n = 0
        for raw in reversed(self.r.lrange(PROCESSING, 0, -1)):
            queue = self.r.hget(PROCESSING_SRC, raw) or self._infer_queue(raw)
            self.r.rpush(queue, raw)  # right end = next to be consumed
            self.r.lrem(PROCESSING, 1, raw)
            self.r.hdel(PROCESSING_SRC, raw)
            n += 1
            log.warning("requeued unfinished message to %s: %s", queue, raw)
        return n

    def _infer_queue(self, raw: str) -> str:
        try:
            msg = json.loads(raw)
        except ValueError:
            return Q_ANALYZE
        if "manualId" in msg:
            return Q_PROPAGATE
        state = self.r.hget(f"job:{msg.get('jobId')}:status", "state")
        return Q_RENDER if state == "rendering" else Q_ANALYZE

    def pop_next(self):
        for q in PRIORITY:
            raw = self.r.lmove(q, PROCESSING, "RIGHT", "LEFT")
            if raw is not None:
                self.r.hset(PROCESSING_SRC, raw, q)
                return q, raw
        return None

    def run_once(self) -> bool:
        item = self.pop_next()
        if item is None:
            return False
        queue, raw = item
        try:
            self.handle(queue, raw)
        except Exception:  # noqa: BLE001  one bad message must not stop the loop
            log.exception("unhandled error for %s %s", queue, raw)
        finally:
            self.r.lrem(PROCESSING, 1, raw)
            self.r.hdel(PROCESSING_SRC, raw)
        return True

    def handle(self, queue: str, raw: str) -> None:
        try:
            msg = json.loads(raw)
            job_id = msg["jobId"]
        except (ValueError, KeyError, TypeError):
            log.error("dropping malformed message on %s: %r", queue, raw)
            return
        if not isinstance(job_id, str) or not SAFE_ID.match(job_id):
            log.error("dropping message with invalid jobId: %r", job_id)
            return
        job_dir = job_dir_of(job_id, self.data_dir)
        if not job_dir.is_dir():
            log.error("unknown jobId %s on %s, skipping", job_id, queue)
            return
        {Q_ANALYZE: self.do_analyze, Q_RENDER: self.do_render, Q_PROPAGATE: self.do_propagate}[queue](job_id, job_dir, msg)

    # ------------------------------------------------------------------ handlers
    def detector(self):
        if self._detector is None:
            from .detect import FaceDetector

            self._detector = FaceDetector()
        return self._detector

    def do_analyze(self, job_id: str, job_dir: Path, msg: dict) -> None:
        self.status.set(job_id, "normalizing", 0)
        try:
            jobs_mod.run_analyze(job_dir, lambda s, p: self.status.set(job_id, s, p), detector_factory=self.detector)
            self.status.set(job_id, "ready", 100)
        except UserFacingError as e:
            self.status.set(job_id, "failed", 0, str(e))
        except Exception:  # noqa: BLE001
            log.exception("analyze failed for %s", job_id)
            self.status.set(job_id, "failed", 0, MSG_ANALYZE_FAILED)

    def do_render(self, job_id: str, job_dir: Path, msg: dict) -> None:
        self.status.set(job_id, "rendering", 0)
        try:
            render_mod.render(job_dir, lambda s, p: self.status.set(job_id, s, p))
            self.status.set(job_id, "rendered", 100)
        except UserFacingError as e:
            self.status.set(job_id, "ready", 100, str(e))
        except Exception:  # noqa: BLE001
            log.exception("render failed for %s", job_id)
            self.status.set(job_id, "ready", 100, MSG_RENDER_FAILED)

    def do_propagate(self, job_id: str, job_dir: Path, msg: dict) -> None:
        manual_id = msg.get("manualId")
        if not isinstance(manual_id, str) or not SAFE_ID.match(manual_id):
            log.error("invalid manualId %r", manual_id)
            return
        self.status.set_manual(job_id, manual_id, "tracking")
        try:
            propagate_mod.propagate(job_dir, manual_id, msg["anchor"], msg.get("otherAnchors", []))
            self.status.set_manual(job_id, manual_id, "done")
        except Exception:  # noqa: BLE001
            log.exception("propagate failed for %s/%s", job_id, manual_id)
            self.status.set_manual(job_id, manual_id, "failed")

    # ------------------------------------------------------------------ loop
    def run_forever(self) -> None:
        self.requeue_processing()
        log.info("worker started, data dir %s", self.data_dir)
        while not self.stop:
            try:
                if not self.run_once():
                    time.sleep(POLL_SEC)
            except redis.exceptions.ConnectionError:
                log.exception("redis connection lost, retrying")
                time.sleep(2)


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s")
    r = redis.Redis.from_url(os.environ.get("REDIS_URL", "redis://localhost:6379/0"), decode_responses=True)
    worker = Worker(r, Path(os.environ.get("DATA_DIR", "/data")))

    def _stop(*_):
        worker.stop = True

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    worker.run_forever()


if __name__ == "__main__":
    main()
