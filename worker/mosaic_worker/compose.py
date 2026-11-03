"""Merge tracks + edits + manual boxes into per-frame mask regions (spec 3.3, 3.5, 3.6).

Default is to mosaic everything. Only `visible` track ids (or groups listed in `visible`) are skipped.
Boxes in tracks.json and manual/*.json are final (already expanded): never expand again.
"""
from __future__ import annotations

import math
from collections import defaultdict
from typing import TypedDict

from .effects import normalize_effects, region_block
from .shapes import face_ellipse_box


class Region(TypedDict):
    id: str
    shape: str  # "rect" | "ellipse" | "polygon"
    box: list[int]
    points: list[list[int]] | None  # absolute integer coordinates, polygon only
    effect: dict
    block: int


def manual_block(w: int, h: int) -> int:
    return max(8, min(w, h) // 8)


def split_fragments(tracks_doc: dict, edits: dict) -> list[tuple[str, str, int, dict[int, list]]]:
    """Return [(fragmentId, trackId, blockSize, {frame: box})] with splits applied.

    split at frame F: `<id>a` gets frames < F and `<id>b` gets frames >= F.
    """
    splits = {s["trackId"]: int(s["frame"]) for s in edits.get("splits", [])}
    out = []
    for t in tracks_doc.get("tracks", []):
        block = int(t["blockSize"])
        frames = {int(f): b for f, b in t["frames"].items()}
        if t["id"] in splits:
            at = splits[t["id"]]
            out.append((t["id"] + "a", t["id"], block, {f: b for f, b in frames.items() if f < at}))
            out.append((t["id"] + "b", t["id"], block, {f: b for f, b in frames.items() if f >= at}))
        else:
            out.append((t["id"], t["id"], block, frames))
    return out


def visible_ids(edits: dict) -> set[str]:
    vis = set(edits.get("visible", []))
    for g in edits.get("groups", []):
        if g["id"] in vis:
            vis.update(g.get("trackIds", []))
    return vis


def effect_for(piece_id: str, track_id: str, edits: dict) -> dict:
    """Effect of one masked piece (spec 3.2): piece override, first group containing
    the track or piece (only that group is consulted; without an override there we fall
    through to the track override), track override, then the default."""
    fx = normalize_effects(edits or {})
    ov = fx["overrides"]
    if piece_id != track_id and piece_id in ov:  # split piece; an unsplit track is step 3
        return ov[piece_id]
    for g in (edits or {}).get("groups", []):
        ids = g.get("trackIds", [])
        if track_id in ids or piece_id in ids:
            if g["id"] in ov:
                return ov[g["id"]]
            break
    if track_id in ov:
        return ov[track_id]
    return fx["default"]


def _poly_points(shape_pts, D, A, B) -> list[list[int]] | None:
    """Map normalized polygon points (u, v) drawn on box D to frame box B.

    Linear box map from the anchor frame's propagated box A to B:
    P = B.xy + (P_drawn - A.xy) * (B.wh / A.wh), rounded half up. At B == A this is
    exactly the drawn polygon. Returns None for a degenerate A or B (caller uses rect).
    """
    if min(A[2], A[3], B[2], B[3]) <= 0:
        return None
    dx, dy, dw, dh = D
    sx, sy = B[2] / A[2], B[3] / A[3]
    out = []
    for u, v in shape_pts:
        px, py = dx + u * dw, dy + v * dh
        out.append([math.floor(B[0] + (px - A[0]) * sx + 0.5), math.floor(B[1] + (py - A[1]) * sy + 0.5)])
    return out


def _make_region(rid, box, block, effect, shape="rect", points=None) -> Region:
    return {"id": rid, "shape": shape, "box": [int(v) for v in box], "points": points, "effect": effect, "block": block}


def mask_regions(tracks_doc: dict, edits: dict, manual: list[dict]) -> dict[int, list[Region]]:
    """Return {frame: [Region, ...]} sorted by (x, y); frames without regions are absent."""
    edits = edits or {}
    vis = visible_ids(edits)
    per_frame: dict[int, list[Region]] = defaultdict(list)

    for frag_id, track_id, block, frames in split_fragments(tracks_doc, edits):
        if frag_id in vis:
            continue
        eff = effect_for(frag_id, track_id, edits)
        for f, box in frames.items():
            per_frame[f].append(
                _make_region(frag_id, face_ellipse_box(box), region_block(block, eff["strength"]), eff, "ellipse"))

    edit_by_id = {m["id"]: m for m in edits.get("manual", [])}

    def manual_shape(e):
        shape = e.get("shape", "rect")
        pts = e.get("points")
        if shape == "polygon" and pts:
            return "polygon", pts
        if shape == "ellipse":
            return "ellipse", None
        return "rect", None

    for doc in manual or []:
        e = edit_by_id.get(doc["id"], {})
        if e.get("deleted"):
            continue
        trim = e.get("trim")
        shape, pts = manual_shape(e)
        eff = effect_for(doc["id"], doc["id"], edits) if e else normalize_effects(edits)["default"]
        doc_frames = {int(f): b for f, b in doc.get("frames", {}).items()}
        # nearest anchor (frame distance, ties to the earlier anchor) that has a propagated box
        anchors = sorted(((int(a["frame"]), a["box"]) for a in e.get("anchors", []) if int(a["frame"]) in doc_frames),
                         key=lambda a: a[0])
        for f, box in doc_frames.items():
            if trim and not (trim[0] <= f <= trim[1]):
                continue
            x, y, w, h = (int(v) for v in box)
            points = None
            if shape == "polygon" and anchors:
                af, D = min(anchors, key=lambda a: (abs(a[0] - f), a[0]))
                points = _poly_points(pts, D, doc_frames[af], (x, y, w, h))
            r = _make_region(doc["id"], (x, y, w, h), region_block(manual_block(w, h), eff["strength"]), eff,
                             shape if (shape != "polygon" or points) else "rect", points)
            per_frame[f].append(r)

    # Propagation missing or failed: mask the drawn anchor frames as fixed boxes,
    # matching the web preview so a face covered there is never exposed in the output.
    doc_ids = {doc["id"] for doc in manual or []}
    for e in edits.get("manual", []):
        if e.get("deleted") or e["id"] in doc_ids:
            continue
        trim = e.get("trim")
        shape, pts = manual_shape(e)
        eff = effect_for(e["id"], e["id"], edits)
        for a in e.get("anchors", []):
            f = int(a["frame"])
            if trim and not (trim[0] <= f <= trim[1]):
                continue
            x, y, w, h = (int(v) for v in a["box"])
            points = _poly_points(pts, (x, y, w, h), (x, y, w, h), (x, y, w, h)) if shape == "polygon" else None
            r_shape = shape if (shape != "polygon" or points) else "rect"
            per_frame[f].append(_make_region(e["id"], (x, y, w, h), region_block(manual_block(w, h), eff["strength"]),
                                             eff, r_shape, points))

    return {f: sorted(rs, key=lambda r: (r["box"][0], r["box"][1])) for f, rs in per_frame.items()}
