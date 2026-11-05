"""Link track fragments of one face that the online tracker split (no ReID, geometry only).

A -> B is a candidate when B starts within LINK_MAX_GAP_SEC after A's last real detection,
near A's box, with a similar size and no scene cut in between. Only unambiguous 1:1 links
are kept; chains are followed into one track.
"""
from __future__ import annotations

from bisect import bisect_left, bisect_right

from .review import CUT_SLACK
from .tracker import EXPAND_RATIO, Box, Track

# Values from the 23-min street vlog measurement (next-frame restarts: jump p90 ~0.98 side, size ratio p90 1.18).
LINK_MAX_DIST_SIDES = 1.0
LINK_MAX_SIZE_RATIO = 2.0
# In 100 hand-checked links every wrong one (another person) had a gap > 5 frames at 30 fps; most right ones had 1.
LINK_MAX_GAP_SEC = 1 / 6


# Bridging (not merging): a partly occluded profile can drop below the detector threshold for ~1 s, so the
# track's hold (0.5 s) runs out before a new track for the same face starts. Measured: 13 such gaps in a
# 115 s video, 984 in a 23-min street vlog (median 10 frames). Identities stay separate; we only keep the
# uncovered frames masked.
BRIDGE_MAX_SEC = 1.5
BRIDGE_MAX_DIST_SIDES = 2.0
BRIDGE_MAX_SIZE_RATIO = 3.0


def _centre(box: Box) -> tuple[float, float]:
    return box[0] + box[2] / 2, box[1] + box[3] / 2


def _is_candidate(a: Track, b: Track, max_gap: int, cuts) -> bool:
    if not a.scores or not b.scores:
        return False
    a_last, b_first = max(a.scores), min(b.scores)
    if not (a_last < b_first <= a_last + max_gap):
        return False
    if a_last not in a.frames or b_first not in b.frames:
        return False
    abox, bbox = a.frames[a_last], b.frames[b_first]
    side = max(abox[2], abox[3]) / (1 + EXPAND_RATIO)  # boxes are expanded; gate uses the raw face size
    bc = _centre(bbox)
    refs = [_centre(abox)]
    if b_first in a.frames:
        refs.append(_centre(a.frames[b_first]))
    dist = min(((bc[0] - r[0]) ** 2 + (bc[1] - r[1]) ** 2) ** 0.5 for r in refs)
    if dist > LINK_MAX_DIST_SIDES * side:
        return False
    if max(bbox[2] / abox[2], abox[2] / bbox[2]) > LINK_MAX_SIZE_RATIO:
        return False
    return not any(a_last - CUT_SLACK < c <= b_first + CUT_SLACK for c in cuts)


def _union(a: Box, b: Box) -> Box:
    x0, y0 = min(a[0], b[0]), min(a[1], b[1])
    x1, y1 = max(a[0] + a[2], b[0] + b[2]), max(a[1] + a[3], b[1] + b[3])
    return (x0, y0, x1 - x0, y1 - y0)


def _merge(acc: Track, part: Track) -> Track:
    frames = dict(acc.frames)
    for f, box in part.frames.items():
        # masked area must never shrink where both tracks cover a frame
        frames[f] = _union(frames[f], box) if f in frames else box
    scores = {**acc.scores, **part.scores}
    return Track(acc.id, frames, scores, {f for f in frames if f not in scores})


def link_fragments(tracks: list[Track], fps: int, cuts=frozenset()) -> tuple[list[Track], dict[str, list[str]]]:
    """Returns (linked tracks sorted by numeric id, {kept_id: [part ids in time order]})."""
    max_gap = max(1, round(LINK_MAX_GAP_SEC * fps))
    by_id = {t.id: t for t in tracks}
    succ: dict[str, list[str]] = {t.id: [] for t in tracks}
    pred: dict[str, list[str]] = {t.id: [] for t in tracks}
    starts: dict[int, list[Track]] = {}  # first real frame -> tracks, so each A only looks at its gap window
    for t in tracks:
        if t.scores:
            starts.setdefault(min(t.scores), []).append(t)
    for a in tracks:
        if not a.scores:
            continue
        a_last = max(a.scores)
        for f in range(a_last + 1, a_last + max_gap + 1):
            for b in starts.get(f, []):
                if b is not a and _is_candidate(a, b, max_gap, cuts):
                    succ[a.id].append(b.id)
                    pred[b.id].append(a.id)
    nxt = {a: s[0] for a, s in succ.items() if len(s) == 1 and len(pred[s[0]]) == 1}
    linked_to = set(nxt.values())

    out: list[Track] = []
    groups: dict[str, list[str]] = {}
    for t in tracks:
        if t.id in linked_to:
            continue
        acc, parts = t, [t.id]
        while parts[-1] in nxt:
            part = by_id[nxt[parts[-1]]]
            acc = _merge(acc, part)
            parts.append(part.id)
        out.append(acc)
        groups[t.id] = parts
    out.sort(key=lambda t: int(t.id[1:]))
    return out, {t.id: groups[t.id] for t in out}


def trim_holds_at_cuts(tracks: list[Track], cuts) -> list[Track]:
    """Drop held frames that lie after a scene cut following the track's last real detection."""
    if not cuts:
        return tracks
    cut_list = sorted(cuts)
    out: list[Track] = []
    for t in tracks:
        reals = sorted(t.scores)
        drop: set[int] = set()
        for f in t.frames:
            if f in t.scores:
                continue
            i = bisect_left(reals, f)  # reals[i - 1] = last real detection before f
            if i == 0:
                continue
            c = bisect_right(cut_list, reals[i - 1])  # first cut after that detection
            if c < len(cut_list) and cut_list[c] <= f:
                drop.add(f)
        if not drop:
            out.append(t)
            continue
        frames = {f: b for f, b in t.frames.items() if f not in drop}
        out.append(Track(t.id, frames, dict(t.scores), {f for f in frames if f not in t.scores}))
    return out


def bridge_gaps(tracks: list[Track], fps: int, cuts=frozenset(), skip=frozenset()) -> list[Track]:
    """Fill uncovered frames between a track's coverage and a nearby later track's first detection (held frames)."""
    max_gap = round(BRIDGE_MAX_SEC * fps)
    firsts = [(min(t.scores), t) for t in tracks if t.scores and t.id not in skip]
    out: list[Track] = []
    for a in tracks:
        if not a.scores or a.id in skip or not a.frames:
            out.append(a)
            continue
        lr, last = max(a.scores), max(a.frames)
        if lr not in a.frames:
            out.append(a)
            continue
        abox = a.frames[lr]
        side = max(abox[2], abox[3]) / (1 + EXPAND_RATIO)
        ac = _centre(abox)
        best = None
        for s, b in firsts:
            if b is a or not (last + 1 < s <= lr + max_gap) or s not in b.frames:
                continue
            bbox = b.frames[s]
            bc = _centre(bbox)
            dist = ((bc[0] - ac[0]) ** 2 + (bc[1] - ac[1]) ** 2) ** 0.5
            if dist > BRIDGE_MAX_DIST_SIDES * side:
                continue
            if max(bbox[2] / abox[2], abox[2] / bbox[2]) > BRIDGE_MAX_SIZE_RATIO:
                continue
            if any(lr - CUT_SLACK < c <= s + CUT_SLACK for c in cuts):
                continue
            if best is None or (s, dist) < best[:2]:
                best = (s, dist, bbox)
        if best is None:
            out.append(a)
            continue
        s, _, bbox = best
        w, h = max(abox[2], bbox[2]), max(abox[3], bbox[3])
        bc = _centre(bbox)
        frames = dict(a.frames)
        for f in range(last + 1, s):
            t = (f - lr) / (s - lr)
            cx, cy = ac[0] + (bc[0] - ac[0]) * t, ac[1] + (bc[1] - ac[1]) * t
            frames[f] = (round(cx - w / 2), round(cy - h / 2), w, h)
        out.append(Track(a.id, frames, dict(a.scores), {f for f in frames if f not in a.scores}))
    return out


def cover_inner_holds(tracks: list[Track], cuts=frozenset(), skip=frozenset()) -> list[Track]:
    """Widen held frames that sit between two real detections of the same track.

    A held box is extrapolated from the last real detection; when that detection was
    partial (face half behind an occluder) or the camera pans, the guess drifts off the
    face. Once the next detection is known, each held frame between them is widened to
    cover both neighbouring detections (masks only grow; never across a cut).
    """
    out: list[Track] = []
    for t in tracks:
        reals = sorted(f for f in t.scores if f in t.frames)
        if t.id in skip or len(reals) < 2:
            out.append(t)
            continue
        frames = dict(t.frames)
        changed = False
        for p, n in zip(reals, reals[1:]):
            if n - p < 2 or any(p - CUT_SLACK < c <= n + CUT_SLACK for c in cuts):
                continue
            span = _union(t.frames[p], t.frames[n])
            for f in range(p + 1, n):
                if f in frames and f not in t.scores:
                    frames[f] = _union(frames[f], span)
                    changed = True
        out.append(Track(t.id, frames, dict(t.scores), {f for f in frames if f not in t.scores}) if changed else t)
    return out


LEAD_SEC = 0.5  # same as the tracker's hold after the last detection


def cover_leading(tracks: list[Track], fps: int, cuts=frozenset(), skip=frozenset()) -> list[Track]:
    """Hold each track's first detected box for up to LEAD_SEC BEFORE that detection.

    A face is often visible a few frames before the detector first fires (entering the frame, turning
    toward the camera, motion blur); nothing covered those frames. Never reaches back past a cut (a cut
    index is the first frame of the new shot) or before frame 0. Existing frames are kept as they are.
    """
    lead = max(1, round(LEAD_SEC * fps))
    out: list[Track] = []
    for t in tracks:
        if t.id in skip or not t.scores:
            out.append(t)
            continue
        s = min(t.scores)
        if s not in t.frames:
            out.append(t)
            continue
        start = max(0, s - lead, max((c for c in cuts if c <= s), default=0))
        missing = [f for f in range(start, s) if f not in t.frames]
        if not missing:
            out.append(t)
            continue
        frames = dict(t.frames)
        for f in missing:
            frames[f] = t.frames[s]
        out.append(Track(t.id, frames, dict(t.scores), {f for f in frames if f not in t.scores}))
    return out
