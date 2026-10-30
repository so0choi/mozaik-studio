"""Scene cut detection during the analysis pass (HSV histogram distance between frames).

Used only to decide which track endings need human review: a track that ends at a cut
ended because the shot changed, not because the detector lost a face that is still there.
"""
from __future__ import annotations

import cv2
import numpy as np

CUT_DISTANCE = 0.5  # Bhattacharyya distance; p99 of normal frame-to-frame motion was ~0.2


class SceneCuts:
    def __init__(self, threshold: float = CUT_DISTANCE):
        self.threshold = threshold
        self.cuts: set[int] = set()
        self._prev = None

    def observe(self, idx: int, frame: np.ndarray) -> None:
        hsv = cv2.cvtColor(cv2.resize(frame, (64, 64)), cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [16, 16], [0, 180, 0, 256])
        cv2.normalize(hist, hist)
        if self._prev is not None and cv2.compareHist(self._prev, hist, cv2.HISTCMP_BHATTACHARYYA) > self.threshold:
            self.cuts.add(idx)
        self._prev = hist
