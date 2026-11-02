"""Scene cut detection during the analysis pass (HSV histogram distance between frames).

Used only to decide which track endings need human review: a track that ended at a cut
ended because the shot changed, not because the detector lost a face that is still there.
Measured: a fixed 0.5 threshold found 3 of 9 real cuts (real 0.39-0.67, busiest non-cut 0.21);
a ratio to the neighbours alone also fired on subtitles/brightness (gray diff 1-17 vs >= 46 for cuts).
A missed cut is safe (the gap stays reviewable); a false cut is not, so all three conditions must hold.
"""
from __future__ import annotations

import cv2
import numpy as np

CUT_MIN_DISTANCE = 0.25  # Bhattacharyya distance floor (largest non-cut seen was ~0.21)
CUT_RATIO = 4.0  # distance must stand out from the median of the surrounding frames
CUT_MIN_GRAY_DIFF = 25.0  # mean abs diff of 64x64 gray frames (0-255); rejects subtitles/brightness


class SceneCuts:
    def __init__(self, fps: int = 30):
        self.w = max(1, round(fps / 2))  # neighbour window on each side, in frames
        self.cuts: set[int] = set()  # complete only after finish()
        self._prev = None
        self._prev_gray = None
        self._entries: list[tuple[int, float, float]] = []  # (idx, hist distance, gray diff)
        self._next = 0  # first entry not decided yet

    def observe(self, idx: int, frame: np.ndarray) -> None:
        small = cv2.resize(frame, (64, 64))
        hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [16, 16], [0, 180, 0, 256])
        cv2.normalize(hist, hist)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32)
        if self._prev is not None:
            d = cv2.compareHist(self._prev, hist, cv2.HISTCMP_BHATTACHARYYA)
            self._entries.append((idx, float(d), float(np.abs(gray - self._prev_gray).mean())))
            while self._next + self.w < len(self._entries):
                self._decide(self._next)
                self._next += 1
            if self._next > self.w:  # keep only the w entries before the next undecided one
                del self._entries[0]
                self._next -= 1
        self._prev, self._prev_gray = hist, gray

    def finish(self) -> None:
        """Decide the frames still waiting for future neighbours (the video ended)."""
        while self._next < len(self._entries):
            self._decide(self._next)
            self._next += 1

    def _decide(self, p: int) -> None:
        idx, d, gray = self._entries[p]
        if d < CUT_MIN_DISTANCE or gray < CUT_MIN_GRAY_DIFF:
            return
        near = [e[1] for e in self._entries[max(0, p - self.w) : p] + self._entries[p + 1 : p + 1 + self.w]]
        if near and d < CUT_RATIO * float(np.median(near)):
            return
        self.cuts.add(idx)
