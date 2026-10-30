"""Merge tracks + edits + manual boxes into per-frame mask boxes (spec 3.3, 3.5, 3.6).

Default is to mosaic everything. Only `visible` track ids (or groups listed in `visible`) are skipped.
Boxes in tracks.json and manual/*.json are final (already expanded): never expand again.
"""
from __future__ import annotations

from collections import defaultdict

MaskBox = tuple[int, int, int, int, int]  # x, y, w, h, block


def manual_block(w: int, h: int) -> int:
    return max(8, min(w, h) // 8)


def split_fragments(tracks_doc: dict, edits: dict) -> list[tuple[str, int, dict[int, list], int]]:
    """Return [(fragmentId, blockSize, {frame: box}, ...)] with splits applied.

    split at frame F: `<id>a` gets frames < F and `<id>b` gets frames >= F.
    """
    splits = {s["trackId"]: int(s["frame"]) for s in edits.get("splits", [])}
    out = []
    for t in tracks_doc.get("tracks", []):
        block = int(t["blockSize"])
        frames = {int(f): b for f, b in t["frames"].items()}
        if t["id"] in splits:
            at = splits[t["id"]]
            out.append((t["id"] + "a", block, {f: b for f, b in frames.items() if f < at}))
            out.append((t["id"] + "b", block, {f: b for f, b in frames.items() if f >= at}))
        else:
            out.append((t["id"], block, frames))
    return out


def visible_ids(edits: dict) -> set[str]:
    vis = set(edits.get("visible", []))
    for g in edits.get("groups", []):
        if g["id"] in vis:
            vis.update(g.get("trackIds", []))
    return vis


def mask_boxes(tracks_doc: dict, edits: dict, manual: list[dict]) -> dict[int, list[MaskBox]]:
    """Return {frame: [(x, y, w, h, block), ...]} sorted by (x, y); frames without boxes are absent."""
    edits = edits or {}
    vis = visible_ids(edits)
    per_frame: dict[int, list[MaskBox]] = defaultdict(list)

    for frag_id, block, frames in split_fragments(tracks_doc, edits):
        if frag_id in vis:
            continue
        for f, (x, y, w, h) in frames.items():
            per_frame[f].append((int(x), int(y), int(w), int(h), block))

    edit_by_id = {m["id"]: m for m in edits.get("manual", [])}
    for doc in manual or []:
        e = edit_by_id.get(doc["id"], {})
        if e.get("deleted"):
            continue
        trim = e.get("trim")
        for f, (x, y, w, h) in doc.get("frames", {}).items():
            f = int(f)
            if trim and not (trim[0] <= f <= trim[1]):
                continue
            per_frame[f].append((int(x), int(y), int(w), int(h), manual_block(int(w), int(h))))

    return {f: sorted(boxes, key=lambda b: (b[0], b[1])) for f, boxes in per_frame.items()}
