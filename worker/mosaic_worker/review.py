"""review.json: low confidence, gap and crossing items (spec 3.4)."""
from __future__ import annotations

from .tracker import Track, iou

LOW_SCORE = 0.6
LOW_MIN_FRAMES = 15
CROSS_IOU = 0.1


def _runs(frames: list[int]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for f in sorted(frames):
        if out and f == out[-1][1] + 1:
            out[-1] = (out[-1][0], f)
        else:
            out.append((f, f))
    return out


def _union(boxes):
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    x1 = max(b[0] + b[2] for b in boxes)
    y1 = max(b[1] + b[3] for b in boxes)
    return [int(x0), int(y0), int(x1 - x0), int(y1 - y0)]


def _low_confidence(track: Track) -> list[tuple[int, int]]:
    real = sorted(f for f in track.scores if f in track.frames and f not in track.held)
    n = LOW_MIN_FRAMES
    if len(real) < n:
        return []
    marked: set[int] = set()
    window = sum(track.scores[f] for f in real[:n])
    for i in range(len(real) - n + 1):
        if i:
            window += track.scores[real[i + n - 1]] - track.scores[real[i - 1]]
        if window / n < LOW_SCORE:
            marked.update(real[i : i + n])
    return [(a, b) for a, b in _runs(list(marked)) if b - a + 1 >= n]


def build_review(tracks: list[Track], fps: int) -> dict:
    raw: list[dict] = []  # {type, trackIds, start, end, box}

    def add(kind, ids, a, b, boxes_at):
        mid = (a + b) // 2
        raw.append({"type": kind, "trackIds": ids, "start": a, "end": b, "box": _union(boxes_at(mid))})

    by_id = {t.id: t for t in tracks}
    for t in tracks:
        for a, b in _low_confidence(t):
            add("low_confidence", [t.id], a, b, lambda m, t=t: [t.frames[min(t.frames, key=lambda f: abs(f - m))]])
        for a, b in _runs([f for f in t.held if f in t.frames]):
            add("gap", [t.id], a, b, lambda m, t=t: [t.frames[min(t.frames, key=lambda f: abs(f - m))]])

    per_frame: dict[int, list[tuple[str, tuple]]] = {}
    for t in tracks:
        for f, box in t.frames.items():
            per_frame.setdefault(f, []).append((t.id, box))
    pair_frames: dict[tuple[str, str], list[int]] = {}
    for f, lst in per_frame.items():
        for i in range(len(lst)):
            for j in range(i + 1, len(lst)):
                if iou(lst[i][1], lst[j][1]) > CROSS_IOU:
                    key = tuple(sorted((lst[i][0], lst[j][0])))
                    pair_frames.setdefault(key, []).append(f)
    for (ia, ib), frames in pair_frames.items():
        for a, b in _runs(frames):
            add(
                "crossing", [ia, ib], a, b,
                lambda m, ia=ia, ib=ib: [by_id[ia].frames[m], by_id[ib].frames[m]] if m in by_id[ia].frames and m in by_id[ib].frames
                else [by_id[ia].frames[min(by_id[ia].frames, key=lambda f: abs(f - m))]],
            )

    # merge neighbours of the same kind and tracks that are within 1 second of each other
    raw.sort(key=lambda r: (r["type"], r["trackIds"], r["start"]))
    merged: list[dict] = []
    for r in raw:
        last = merged[-1] if merged else None
        if last and last["type"] == r["type"] and last["trackIds"] == r["trackIds"] and r["start"] - last["end"] <= fps:
            last["end"] = max(last["end"], r["end"])
            last["box"] = _union([last["box"], r["box"]])
        else:
            merged.append(dict(r))
    merged.sort(key=lambda r: (r["start"], r["type"], r["trackIds"]))
    items = [
        {
            "id": f"r{i}", "type": r["type"], "trackIds": r["trackIds"],
            "startFrame": r["start"], "endFrame": r["end"], "box": r["box"],
        }
        for i, r in enumerate(merged, 1)
    ]
    return {"items": items}
