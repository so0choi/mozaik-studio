"""Scene cut detection during the analysis pass (HSV histogram distance between frames).

Used only to decide which track endings need human review: a track that ended at a cut
ended because the shot changed, not because the detector lost a face that is still there.
Measured: a fixed 0.5 threshold found 3 of 9 real cuts (real 0.39-0.67, busiest non-cut 0.21);
a ratio to the neighbours alone also fired on subtitles/brightness (gray diff 1-17 vs >= 46 for cuts).
Cuts also drive trim_holds_at_cuts, linking, bridging and cover_leading. A false cut trims the hold of a face that
is still there and hides that gap from review, so all three conditions must hold. A missed cut is not free either:
the last shot's held box (up to 0.5 s) stays over the next shot, and leading boxes reach back across it.

Dark footage (stage video, 2026-11-05): real cuts had gray diff 11.5-24.5, so the gray floor missed them and a held
face box stayed over the next shot. Stage lighting changes there also reach gray 10-17.6, so the floor cannot simply
be lowered. Rescue: a frame that passes both histogram tests but fails the gray floor is still a cut when the frame
structure changed (zero-mean normalized correlation of 128x72 gray < CUT_RESCUE_NCC). Measured on that video:
lighting changes 0.645-0.936, missed cuts 0.007-0.678 (6 of 8 below 0.6). Flat frames (fades to black) have no
structure to compare and are never rescued.
"""
from __future__ import annotations

import cv2
import numpy as np

CUT_MIN_DISTANCE = 0.25  # Bhattacharyya distance floor (largest non-cut seen was ~0.21)
CUT_RATIO = 4.0  # distance must stand out from the median of the surrounding frames
CUT_MIN_GRAY_DIFF = 25.0  # mean abs diff of 64x64 gray frames (0-255); rejects subtitles/brightness
CUT_RESCUE_NCC = 0.6  # below this structural correlation a gray-floor failure is still a cut; <= -1 disables
STRUCT_SIZE = (128, 72)
STRUCT_MIN_STD = 4.0  # gray std below this = flat frame, no structure to compare


class SceneCuts:
    def __init__(self, fps: int = 30):
        self.w = max(1, round(fps / 2))  # neighbour window on each side, in frames
        self.cuts: set[int] = set()  # complete only after finish()
        self._prev = None
        self._prev_gray = None
        self._prev_z = None
        self._entries: list[tuple[int, float, float, float | None]] = []  # (idx, hist distance, gray diff, ncc)
        self._next = 0  # first entry not decided yet

    def observe(self, idx: int, frame: np.ndarray) -> None:
        small = cv2.resize(frame, (64, 64))
        hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [16, 16], [0, 180, 0, 256])
        cv2.normalize(hist, hist)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32)
        z = _structure(frame)
        if self._prev is not None:
            d = cv2.compareHist(self._prev, hist, cv2.HISTCMP_BHATTACHARYYA)
            ncc = float((z * self._prev_z).mean()) if z is not None and self._prev_z is not None else None
            self._entries.append((idx, float(d), float(np.abs(gray - self._prev_gray).mean()), ncc))
            while self._next + self.w < len(self._entries):
                self._decide(self._next)
                self._next += 1
            if self._next > self.w:  # keep only the w entries before the next undecided one
                del self._entries[0]
                self._next -= 1
        self._prev, self._prev_gray, self._prev_z = hist, gray, z

    def finish(self) -> None:
        """Decide the frames still waiting for future neighbours (the video ended)."""
        while self._next < len(self._entries):
            self._decide(self._next)
            self._next += 1

    def _decide(self, p: int) -> None:
        idx, d, gray, ncc = self._entries[p]
        if d < CUT_MIN_DISTANCE:
            return
        if gray < CUT_MIN_GRAY_DIFF and (ncc is None or ncc >= CUT_RESCUE_NCC):
            return
        near = [e[1] for e in self._entries[max(0, p - self.w) : p] + self._entries[p + 1 : p + 1 + self.w]]
        if near and d < CUT_RATIO * float(np.median(near)):
            return
        self.cuts.add(idx)


def _structure(frame: np.ndarray) -> np.ndarray | None:
    """Zero-mean, unit-variance 128x72 gray frame; None for a flat frame."""
    g = cv2.cvtColor(cv2.resize(frame, STRUCT_SIZE, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float32)
    sd = float(g.std())
    if sd < STRUCT_MIN_STD:
        return None
    return (g - g.mean()) / sd
