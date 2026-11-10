"""Drop held boxes whose picture no longer looks like the face the track last saw.

A hold keeps masking a box after the detector lost the face; if the content under it changed (the person
left, a hand moved in) the mask hides nothing. Compared with the nearest real detection of the same track
(grayscale NCC + HSV histogram), and kept anyway when a real detection overlaps it within HOLD_PROTECT_SEC.
Protection comes from the track's own real detections (not for a lead box, before its first real detection) or from
another track's real detection, unless that track already detects a face at the held frame: such a track masks the
face itself. A track with only a lead/held box at that frame does not cancel protection, since it may be the same
face reappearing.
"""
from __future__ import annotations

import cv2
import numpy as np

from .tracker import EXPAND_RATIO, Track

# measured 2026-11-10 on like-jennie/paris human label sheets: wrong masks 69->32 / 19->11 with all four rules,
# no labeled visible face exposed; unseen students/paris-ep5: visible faces unchanged.
HOLD_NCC_MIN = 0.4  # grayscale 24x24 normalized cross-correlation
HOLD_HIST_MIN = 0.7  # HSV 16x8 hist correlation (cv2.HISTCMP_CORREL)
HOLD_PROTECT_SEC = 0.25


def _raw_box(box):
    x, y, w, h = box
    rw, rh = w / EXPAND_RATIO_F, h / EXPAND_RATIO_F
    return int(x + (w - rw) / 2), int(y + (h - rh) / 2), max(2, int(rw)), max(2, int(rh))


EXPAND_RATIO_F = 1 + EXPAND_RATIO


def _features(frame, box):
    H, W = frame.shape[:2]
    x, y, w, h = _raw_box(box)
    x0, y0, x1, y1 = max(0, x), max(0, y), min(W, x + w), min(H, y + h)
    if x1 - x0 < 2 or y1 - y0 < 2:
        return None
    crop = frame[y0:y1, x0:x1]
    g = cv2.resize(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), (24, 24)).astype(np.float32).ravel()
    g = (g - g.mean()) / (g.std() + 1e-6)
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    hs = cv2.calcHist([hsv], [0, 1], None, [16, 8], [0, 180, 0, 256])
    hs = cv2.normalize(hs, hs).astype(np.float32)
    return g, hs


def hold_features(video_path, tracks) -> dict:
    by_frame: dict[int, list[tuple[str, tuple]]] = {}
    for t in tracks:
        for f, b in t.frames.items():
            by_frame.setdefault(f, []).append((t.id, b))
    out: dict = {}
    if not by_frame:
        return out
    cap = cv2.VideoCapture(str(video_path))
    last = max(by_frame)
    try:
        i = 0
        while i <= last:
            ok, frame = cap.read()
            if not ok:
                break
            for tid, b in by_frame.get(i, ()):
                feat = _features(frame, b)
                if feat is not None:
                    out[(tid, i)] = feat
            i += 1
    finally:
        cap.release()
    return out


def _overlaps(a, b) -> bool:
    return min(a[0] + a[2], b[0] + b[2]) > max(a[0], b[0]) and min(a[1] + a[3], b[1] + b[3]) > max(a[1], b[1])


def drop_unlike_holds(tracks, feats, fps, ncc_min=HOLD_NCC_MIN, hist_min=HOLD_HIST_MIN, protect_sec=HOLD_PROTECT_SEC) -> list[Track]:
    window = round(protect_sec * fps)
    real: dict[int, list] = {}
    for t in tracks:
        for f in t.scores:
            if f in t.frames:
                real.setdefault(f, []).append((t.id, t.frames[f]))
    scores_of = {t.id: t.scores for t in tracks}
    out: list[Track] = []
    for t in tracks:
        reals = sorted(f for f in t.scores if f in t.frames)
        if not reals:
            out.append(t)
            continue
        frames = dict(t.frames)
        for k, box in t.frames.items():
            if k in t.scores:
                continue
            # a lead box is always followed by its own first detection; letting that protect it exempted every lead
            # (like-jennie t491 1634-1639: a fast face entering, lead boxes on empty background)
            lead = k < reals[0]
            ref = min(reals, key=lambda r: abs(r - k))
            fk, fr = feats.get((t.id, k)), feats.get((t.id, ref))
            if fk is None or fr is None:
                continue
            ncc = float(np.dot(fk[0], fr[0]) / len(fk[0]))
            hc = cv2.compareHist(fk[1], fr[1], cv2.HISTCMP_CORREL)
            if ncc >= ncc_min or hc >= hist_min:
                continue
            # another track that already DETECTS a face at k masks it itself (like-jennie t491 1634-1639 was kept by
            # neighbouring face t397); a track with only a lead/held box at k may be the same face reappearing
            # (like-jennie 1183: t297's lead box there was offset, the face stayed exposed without protection)
            if any(
                _overlaps(rb, box)
                for f in range(k, k + window + 1)
                for owner, rb in real.get(f, ())
                if (owner == t.id and not lead) or (owner != t.id and k not in scores_of[owner])
            ):
                continue
            del frames[k]
        out.append(Track(t.id, frames, dict(t.scores), {f for f in frames if f not in t.scores}))
    return out
