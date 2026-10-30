"""Thumbnails collected during the detection pass, so the video is decoded only once (eng review E5).

Per track: the best `score x area` detection crop (20% margin, 160px wide) and a crop every
2 seconds (at most 8 evenly picked).
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from .detect import Detection

THUMB_WIDTH = 160
MARGIN = 0.20
SAMPLE_INTERVAL_SEC = 2
MAX_SAMPLES = 8


def crop_thumb(frame: np.ndarray, box) -> bytes | None:
    x, y, w, h = box
    mx, my = w * MARGIN, h * MARGIN
    x0, y0 = max(0, int(round(x - mx))), max(0, int(round(y - my)))
    x1, y1 = min(frame.shape[1], int(round(x + w + mx))), min(frame.shape[0], int(round(y + h + my)))
    if x1 - x0 < 2 or y1 - y0 < 2:
        return None
    crop = frame[y0:y1, x0:x1]
    th = max(1, round(THUMB_WIDTH * crop.shape[0] / crop.shape[1]))
    crop = cv2.resize(crop, (THUMB_WIDTH, th), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 88])
    return buf.tobytes() if ok else None


class ThumbCollector:
    def __init__(self, fps: int):
        self.interval = max(1, SAMPLE_INTERVAL_SEC * fps)
        self._best: dict[str, tuple[float, np.ndarray, tuple]] = {}
        self._samples: dict[str, list[bytes]] = {}
        self._last_sample: dict[str, int] = {}

    def observe(self, frame_idx: int, frame: np.ndarray, assigned: dict[str, Detection]) -> None:
        for tid, det in assigned.items():
            x, y, w, h = det.box
            rank = det.score * w * h
            best = self._best.get(tid)
            if best is None or rank > best[0]:
                # keep only the small padded crop, not the whole frame
                self._best[tid] = (rank, frame[max(0, y - h) : y + 2 * h, max(0, x - w) : x + 2 * w].copy(), (x - max(0, x - w), y - max(0, y - h), w, h))
            last = self._last_sample.get(tid)
            if last is None or frame_idx - last >= self.interval:
                jpg = crop_thumb(frame, det.box)
                if jpg:
                    self._samples.setdefault(tid, []).append(jpg)
                    self._last_sample[tid] = frame_idx

    def write(self, track_ids: list[str], job_dir: Path) -> dict[str, dict]:
        """Write jpgs under job_dir/thumbs; returns {trackId: {"thumb": rel, "samples": [rel]}}."""
        out_dir = Path(job_dir) / "thumbs"
        out_dir.mkdir(parents=True, exist_ok=True)
        result: dict[str, dict] = {}
        for tid in track_ids:
            entry = {"thumb": None, "samples": []}
            best = self._best.get(tid)
            if best is not None:
                jpg = crop_thumb(best[1], best[2])
                if jpg:
                    (out_dir / f"{tid}.jpg").write_bytes(jpg)
                    entry["thumb"] = f"thumbs/{tid}.jpg"
            samples = self._samples.get(tid, [])
            if len(samples) > MAX_SAMPLES:
                idx = np.linspace(0, len(samples) - 1, MAX_SAMPLES).round().astype(int)
                samples = [samples[i] for i in idx]
            for n, jpg in enumerate(samples):
                (out_dir / f"{tid}_s{n}.jpg").write_bytes(jpg)
                entry["samples"].append(f"thumbs/{tid}_s{n}.jpg")
            result[tid] = entry
        return result
