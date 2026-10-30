"""Manual box propagation with CSRT (spec 3.6, 4.6)."""
from __future__ import annotations

import json
from pathlib import Path

import cv2

from .normalize import load_meta
from .status import atomic_write_json
from .tracker import expand_box, to_segments

MAX_SECONDS = 10
TRACK_SHORT_SIDE = 720  # CSRT runs on frames scaled to this short side (speed)
CHUNK = 30  # backward pass decodes this many frames at a time


def _scaled(frame, scale):
    if scale >= 1.0:
        return frame
    return cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)


def _make_tracker():
    if hasattr(cv2, "TrackerCSRT_create"):
        return cv2.TrackerCSRT_create()
    return cv2.legacy.TrackerCSRT_create()


class _Pass:
    """One CSRT pass; feed frames one by one."""

    def __init__(self, first_small, box_small):
        self.t = _make_tracker()
        self.t.init(first_small, tuple(int(round(v)) for v in box_small))
        self.alive = True

    def step(self, small):
        ok, box = self.t.update(small)
        if not ok:
            self.alive = False
            return None
        return box


def _frames_forward(cap, start, end):
    cap.set(cv2.CAP_PROP_POS_FRAMES, start)
    for f in range(start, end + 1):
        ok, img = cap.read()
        if not ok:
            return
        yield f, img


def _frames_backward(cap, start, end):
    """Yield frames start, start-1, ..., end (end <= start) using chunked forward decoding."""
    hi = start
    while hi >= end:
        lo = max(end, hi - CHUNK + 1)
        chunk = list(_frames_forward(cap, lo, hi))
        for f, img in reversed(chunk):
            yield f, img
        if len(chunk) < hi - lo + 1:
            return
        hi = lo - 1


def propagate(job_dir: Path, manual_id: str, anchor: dict, other_anchors: list[int]) -> dict:
    job_dir = Path(job_dir)
    meta = load_meta(job_dir)
    af = int(anchor["frame"])
    ax, ay, aw, ah = (float(v) for v in anchor["box"])
    limit = round(MAX_SECONDS * meta.fps)
    others = [int(a) for a in other_anchors if int(a) != af]
    lo_anchor = max((a for a in others if a < af), default=None)
    hi_anchor = min((a for a in others if a > af), default=None)
    lo = max(0, af - limit, (lo_anchor + 1) if lo_anchor is not None else 0)
    hi = min(meta.frame_count - 1, af + limit, (hi_anchor - 1) if hi_anchor is not None else meta.frame_count)

    scale = min(1.0, TRACK_SHORT_SIDE / min(meta.width, meta.height))
    size = (meta.width, meta.height)
    new: dict[int, tuple] = {}

    def record(f, box):
        eb = expand_box(box, size=size)
        if eb is not None:
            new[f] = eb

    cap = cv2.VideoCapture(str(job_dir / "normalized.mp4"))
    try:
        record(af, (ax, ay, aw, ah))
        for direction in (1, -1):
            gen = _frames_forward(cap, af, hi) if direction == 1 else _frames_backward(cap, af, lo)
            tracker = None
            for f, img in gen:
                small = _scaled(img, scale)
                if tracker is None:
                    tracker = _Pass(small, (ax * scale, ay * scale, max(2.0, aw * scale), max(2.0, ah * scale)))
                    continue
                box = tracker.step(small)
                if box is None:
                    break
                x, y, w, h = (v / scale for v in box)
                if w < 2 or h < 2 or x + w <= 0 or y + h <= 0 or x >= meta.width or y >= meta.height:
                    break  # left the frame
                record(f, (x, y, w, h))
    finally:
        cap.release()

    path = job_dir / "manual" / f"{manual_id}.json"
    frames: dict[int, list] = {}
    if path.exists():
        old = json.loads(path.read_text(encoding="utf-8"))
        frames = {int(f): b for f, b in old.get("frames", {}).items()}
    # re-anchor: replace only what lies between the new anchor's reach and the nearest other anchors
    frames = {f: b for f, b in frames.items() if not (lo <= f <= hi)}
    frames.update({f: list(b) for f, b in new.items()})
    doc = {
        "id": manual_id,
        "frames": {str(f): list(b) for f, b in sorted(frames.items())},
        "segments": to_segments(frames),
    }
    atomic_write_json(path, doc)
    return doc
