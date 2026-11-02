"""Link track fragments of one face that the online tracker split (no ReID, geometry only).

A -> B is a candidate when B starts within LINK_MAX_GAP_SEC after A's last real detection,
near A's box, with a similar size and no scene cut in between. Only unambiguous 1:1 links
are kept; chains are followed into one track.
"""
from __future__ import annotations

from .review import CUT_SLACK
from .tracker import EXPAND_RATIO, Box, Track

# Values from the 23-min street vlog measurement (next-frame restarts: jump p90 ~0.98 side, size ratio p90 1.18).
LINK_MAX_DIST_SIDES = 1.0
LINK_MAX_SIZE_RATIO = 2.0
# In 100 hand-checked links every wrong one (another person) had a gap > 5 frames at 30 fps; most right ones had 1.
LINK_MAX_GAP_SEC = 1 / 6


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
