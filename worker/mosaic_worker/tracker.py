"""ByteTrack-style two-stage IoU tracker with constant-velocity prediction and gap-hold.

No appearance features, no ReID (spec 2). Boxes are expanded 25% once, in `finish()`.
"""
from __future__ import annotations

import math
import statistics
from dataclasses import dataclass, field

from .detect import Detection

HIGH_SCORE = 0.6
IOU_THRESHOLD = 0.3
JUMP_DIAG_RATIO = 0.5
HOLD_GROWTH = 1.05
EXPAND_RATIO = 0.25
VEL_ALPHA = 0.5

Box = tuple[int, int, int, int]


@dataclass
class Track:
    id: str
    frames: dict[int, Box]
    scores: dict[int, float]
    held: set[int] = field(default_factory=set)


def iou(a, b) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    iw = min(ax + aw, bx + bw) - max(ax, bx)
    ih = min(ay + ah, by + bh) - max(ay, by)
    if iw <= 0 or ih <= 0:
        return 0.0
    inter = iw * ih
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def expand_box(box, ratio: float = EXPAND_RATIO, size: tuple[int, int] | None = None) -> Box | None:
    """Expand around the center by `ratio`, clamp to (width, height). None if nothing is left."""
    x, y, w, h = box
    cx, cy = x + w / 2, y + h / 2
    nw, nh = w * (1 + ratio), h * (1 + ratio)
    x0, y0 = round(cx - nw / 2), round(cy - nh / 2)
    x1, y1 = x0 + round(nw), y0 + round(nh)
    if size is not None:
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(size[0], x1), min(size[1], y1)
    if x1 - x0 < 1 or y1 - y0 < 1:
        return None
    return (x0, y0, x1 - x0, y1 - y0)


def to_segments(frames) -> list[list[int]]:
    out: list[list[int]] = []
    for f in sorted(frames):
        if out and f == out[-1][1] + 1:
            out[-1][1] = f
        else:
            out.append([f, f])
    return out


def block_size(track: Track, divisor: int = 8, min_block: int = 8) -> int:
    shorts = [min(b[2], b[3]) for b in track.frames.values()]
    if not shorts:
        return min_block
    return max(min_block, int(statistics.median(shorts)) // divisor)


class _Active:
    def __init__(self, tid: str, det: Detection, frame_idx: int):
        x, y, w, h = det.box
        self.id = tid
        self.cx, self.cy = x + w / 2, y + h / 2
        self.w, self.h = float(w), float(h)  # last real size (used for matching)
        self.hw, self.hh = float(w), float(h)  # displayed size while held (grows)
        self.vx = self.vy = 0.0
        self.last_real_frame = frame_idx
        self.last_real_c = (self.cx, self.cy)
        self.miss = 0
        self.frames: dict[int, tuple] = {frame_idx: tuple(float(v) for v in det.box)}
        self.scores: dict[int, float] = {frame_idx: det.score}
        self.held: set[int] = set()

    def predicted_box(self):
        pcx, pcy = self.cx + self.vx, self.cy + self.vy
        return (pcx - self.w / 2, pcy - self.h / 2, self.w, self.h), (pcx, pcy)


class Tracker:
    def __init__(self, fps: int, frame_size: tuple[int, int] | None = None):
        self.fps = fps
        self.hold_frames = max(1, round(0.5 * fps))
        self.frame_size = frame_size  # (width, height); enables clamping in finish()
        self._active: list[_Active] = []
        self._done: list[_Active] = []
        self._next = 1

    # ------------------------------------------------------------------ matching
    def _match(self, tracks, dets, preds):
        """Greedy IoU matching. Returns (pairs, unmatched track idx, unmatched det idx)."""
        cand = []
        for ti, tr in enumerate(tracks):
            pbox, (pcx, pcy) = preds[tr.id]
            diag = math.hypot(tr.w, tr.h)
            for di, det in enumerate(dets):
                x, y, w, h = det.box
                if math.hypot(x + w / 2 - pcx, y + h / 2 - pcy) > JUMP_DIAG_RATIO * diag:
                    continue  # forced split
                v = iou(pbox, det.box)
                if v >= IOU_THRESHOLD:
                    cand.append((v, ti, di))
        cand.sort(key=lambda c: -c[0])
        used_t, used_d, pairs = set(), set(), []
        for _, ti, di in cand:
            if ti in used_t or di in used_d:
                continue
            used_t.add(ti)
            used_d.add(di)
            pairs.append((ti, di))
        return pairs, [i for i in range(len(tracks)) if i not in used_t], [i for i in range(len(dets)) if i not in used_d]

    def update(self, frame_idx: int, dets: list[Detection]) -> dict[str, Detection]:
        """Feed one frame (call for every frame, also with no detections).

        Returns {track_id: Detection} for tracks matched or created on this frame.
        """
        preds = {tr.id: tr.predicted_box() for tr in self._active}
        assigned: dict[str, Detection] = {}

        high = [d for d in dets if d.score >= HIGH_SCORE]
        low = [d for d in dets if d.score < HIGH_SCORE]

        pairs1, un_t, un_high = self._match(self._active, high, preds)
        matched: list[tuple[_Active, Detection]] = [(self._active[ti], high[di]) for ti, di in pairs1]

        rest = [self._active[i] for i in un_t]
        pairs2, un_t2, un_low = self._match(rest, low, preds)
        matched += [(rest[ti], low[di]) for ti, di in pairs2]
        unmatched_tracks = [rest[i] for i in un_t2]
        new_dets = [high[i] for i in un_high] + [low[i] for i in un_low]

        for tr, det in matched:
            self._apply(tr, frame_idx, det)
            assigned[tr.id] = det

        survivors = [tr for tr, _ in matched]
        for tr in unmatched_tracks:
            tr.miss += 1
            if tr.miss > self.hold_frames:
                self._done.append(tr)
                continue
            tr.cx += tr.vx
            tr.cy += tr.vy
            tr.hw *= HOLD_GROWTH
            tr.hh *= HOLD_GROWTH
            tr.frames[frame_idx] = (tr.cx - tr.hw / 2, tr.cy - tr.hh / 2, tr.hw, tr.hh)
            tr.held.add(frame_idx)
            survivors.append(tr)

        for det in new_dets:
            tr = _Active(f"t{self._next}", det, frame_idx)
            self._next += 1
            survivors.append(tr)
            assigned[tr.id] = det

        self._active = survivors
        return assigned

    @staticmethod
    def _apply(tr: _Active, frame_idx: int, det: Detection) -> None:
        x, y, w, h = det.box
        ncx, ncy = x + w / 2, y + h / 2
        dt = max(1, frame_idx - tr.last_real_frame)
        vx, vy = (ncx - tr.last_real_c[0]) / dt, (ncy - tr.last_real_c[1]) / dt
        tr.vx = VEL_ALPHA * tr.vx + (1 - VEL_ALPHA) * vx
        tr.vy = VEL_ALPHA * tr.vy + (1 - VEL_ALPHA) * vy
        tr.cx, tr.cy = ncx, ncy
        tr.w = tr.hw = float(w)
        tr.h = tr.hh = float(h)
        tr.last_real_frame = frame_idx
        tr.last_real_c = (ncx, ncy)
        tr.miss = 0
        tr.frames[frame_idx] = (float(x), float(y), float(w), float(h))
        tr.scores[frame_idx] = det.score

    def finish(self) -> list[Track]:
        everything = self._done + self._active
        self._done, self._active = [], []
        everything.sort(key=lambda t: int(t.id[1:]))
        out: list[Track] = []
        for tr in everything:
            frames: dict[int, Box] = {}
            held: set[int] = set()
            for f in sorted(tr.frames):
                box = expand_box(tr.frames[f], EXPAND_RATIO, self.frame_size)
                if box is None:
                    continue  # box left the frame entirely
                frames[f] = box
                if f in tr.held:
                    held.add(f)
            if not frames:
                continue
            scores = {f: s for f, s in tr.scores.items() if f in frames}
            out.append(Track(tr.id, frames, scores, held))
        return out
