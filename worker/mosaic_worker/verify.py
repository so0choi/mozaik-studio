"""Second-look check that flags tracks which may not be faces (food, hands, textures).

YuNet scores some textures 0.6-0.85 on the full frame. Re-running it on an enlarged
square crop around the box separates them: on a labelled 35s phone recording every
real face (incl. occluded / eating faces at 0.61 on the full frame) scored >= 0.84,
while 24 of 26 non-face tracks scored < 0.6.

It is only a HINT shown to the reviewer (tracks.json `suspect`), never an automatic
unmask: on a crowded street vlog the same check failed many real profile, motion-blurred
and small faces. Runs inside the single decoding pass, so no extra seeking.
`keep()` is False for a suspect; confident or never-judged tracks are never suspect.
"""
from __future__ import annotations

import os
from typing import Callable

import cv2
import numpy as np

from .detect import Detection, default_model_path

CONFIDENT = 0.9  # no non-face reached 0.84 on the full frame in the labelled sample
MAX_CHECKS_PER_TRACK = 6
CROP_CONTEXT = 1.0  # crop side = longest box side x (1 + context)
CROP_SIDE = 320
CROP_DET_THRESHOLD = 0.3


def default_min_score() -> float:
    return float(os.environ.get("VERIFY_MIN_SCORE", "0.6"))


def square_crops(frame: np.ndarray, box, side: int = CROP_SIDE) -> tuple[np.ndarray, np.ndarray]:
    """Two views of the same square region: clamped to the frame, and zero-padded past the edge.

    Each one misses a different kind of face (padding hurts tiny partial faces, clamping
    squashes faces at the frame edge), so callers take the better score.
    """
    h, w = frame.shape[:2]
    x, y, bw, bh = box
    cx, cy = x + bw / 2, y + bh / 2
    s = max(1, int(max(bw, bh) * (1 + CROP_CONTEXT)))
    x0, y0 = int(cx - s / 2), int(cy - s / 2)

    cx0, cy0, cx1, cy1 = max(0, x0), max(0, y0), min(w, x0 + s), min(h, y0 + s)
    clamped = cv2.resize(frame[cy0:cy1, cx0:cx1], (side, side))

    padded_src = cv2.copyMakeBorder(frame, s, s, s, s, cv2.BORDER_CONSTANT, value=(0, 0, 0))
    padded = cv2.resize(padded_src[y0 + s : y0 + 2 * s, x0 + s : x0 + 2 * s], (side, side))
    return clamped, padded


class CropScorer:
    """Best YuNet score for a face centred in the enlarged crop (either crop variant)."""

    def __init__(self):
        self._det = cv2.FaceDetectorYN.create(
            str(default_model_path()), "", (CROP_SIDE, CROP_SIDE), CROP_DET_THRESHOLD, 0.3, 50
        )

    def __call__(self, frame: np.ndarray, box) -> float:
        best = 0.0
        for crop in square_crops(frame, box):
            _, faces = self._det.detect(crop)
            for r in faces if faces is not None else []:
                fx, fy = r[0] + r[2] / 2, r[1] + r[3] / 2
                if abs(fx - CROP_SIDE / 2) < CROP_SIDE * 0.25 and abs(fy - CROP_SIDE / 2) < CROP_SIDE * 0.25:
                    best = max(best, float(r[-1]))
        return best


class TrackVerifier:
    def __init__(self, min_score: float | None = None, crop_score: Callable[[np.ndarray, tuple], float] | None = None):
        self.min_score = default_min_score() if min_score is None else min_score
        self._crop_score = crop_score
        self._confident: set[str] = set()
        self._best: dict[str, float] = {}
        self._checks: dict[str, int] = {}

    def _scorer(self):
        if self._crop_score is None:
            self._crop_score = CropScorer()
        return self._crop_score

    def observe(self, frame: np.ndarray, assigned: dict[str, Detection]) -> None:
        """Feed the detections the tracker assigned on this frame (Tracker.update's return)."""
        if self.min_score <= 0:
            return
        for tid, det in assigned.items():
            if tid in self._confident:
                continue
            if det.score >= CONFIDENT:
                self._confident.add(tid)
                continue
            if self._best.get(tid, 0.0) >= self.min_score or self._checks.get(tid, 0) >= MAX_CHECKS_PER_TRACK:
                continue
            self._checks[tid] = self._checks.get(tid, 0) + 1
            self._best[tid] = max(self._best.get(tid, 0.0), self._scorer()(frame, det.box))

    def keep(self, track_id: str) -> bool:
        if self.min_score <= 0 or track_id in self._confident:
            return True
        if track_id not in self._checks:
            return True  # never judged: keep rather than risk exposing a face
        return self._best.get(track_id, 0.0) >= self.min_score
