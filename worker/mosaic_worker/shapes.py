"""Pure shape rasterizer shared (by rule) with the web preview's shapes.ts.

A pixel (i, j) of the box is included when its center (i + 0.5, j + 0.5) is inside the shape.
No OpenCV: the same rule is implemented in TypeScript and checked against
contracts/fixtures/shape-masks.json.

- rect: every pixel.
- ellipse: ((px - w/2) / (w/2))^2 + ((py - h/2) / (h/2))^2 <= 1.
- polygon: nonzero winding (a superset of even-odd: overlaps and double-traced loops are filled).
  For each non-horizontal edge (x1,y1)->(x2,y2) and xi = x1 + (py - y1) * (x2 - x1) / (y2 - y1):
  y1 <= py < y2 (upward) and px < xi adds +1; y2 <= py < y1 (downward) and px < xi adds -1.
  A pixel is inside when its winding number is not 0.
- A box with w < 4 or h < 4 is always rect, so a tiny shape can never collapse and expose a face.
- A polygon with fewer than 3 points, or |shoelace area| < 1 px^2, is rect (never less masked).
- A polygon whose rasterized mask is empty while its point bounding box intersects the rasterized
  region is rect for that region (fail closed).
- `window` rasterizes only a sub-rectangle of the box with the same per-pixel result as cropping
  the full bitmap, so callers never allocate a huge, mostly off-frame box.
"""
from __future__ import annotations

import numpy as np

MIN_SHAPE_SIZE = 4


def _shoelace_area(points) -> float:
    a = 0.0
    n = len(points)
    for k in range(n):
        x1, y1 = points[k]
        x2, y2 = points[(k + 1) % n]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2


def shape_bitmap(
    shape: str,
    w: int,
    h: int,
    points: list[list[int]] | None,
    window: tuple[int, int, int, int] | None = None,
) -> np.ndarray:
    """Bool bitmap relative to the box origin; `points` are relative to the box origin.

    `window` = (x0, y0, x1, y1) in box-relative coords (default: the whole box); only that part is
    rasterized and the result has shape (y1 - y0, x1 - x0)."""
    w, h = int(w), int(h)
    if w <= 0 or h <= 0:
        return np.zeros((max(h, 0), max(w, 0)), bool)
    x0, y0, x1, y1 = (0, 0, w, h) if window is None else (int(v) for v in window)
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(w, x1), min(h, y1)
    if x1 <= x0 or y1 <= y0:
        return np.zeros((max(y1 - y0, 0), max(x1 - x0, 0)), bool)
    full = np.ones((y1 - y0, x1 - x0), bool)
    if shape == "rect" or w < MIN_SHAPE_SIZE or h < MIN_SHAPE_SIZE:
        return full
    px = (np.arange(x0, x1, dtype=np.float64) + 0.5)[None, :]
    py = (np.arange(y0, y1, dtype=np.float64) + 0.5)[:, None]
    if shape == "ellipse":
        rx, ry = w / 2, h / 2
        return ((px - rx) / rx) ** 2 + ((py - ry) / ry) ** 2 <= 1.0
    if shape == "polygon":
        if not points or len(points) < 3 or _shoelace_area(points) < 1:
            return full
        winding = np.zeros((y1 - y0, x1 - x0), np.int32)
        n = len(points)
        for k in range(n):
            ax, ay = points[k]
            bx, by = points[(k + 1) % n]
            if ay == by:
                continue
            xi = ax + (py - ay) * (bx - ax) / (by - ay)  # (rows, 1)
            right = px < xi
            if ay < by:
                winding += ((ay <= py) & (py < by) & right).astype(np.int32)
            else:
                winding -= ((by <= py) & (py < ay) & right).astype(np.int32)
        inside = winding != 0
        if not inside.any():
            xs = [p[0] for p in points]
            ys = [p[1] for p in points]
            if min(xs) < x1 and max(xs) > x0 and min(ys) < y1 and max(ys) > y0:
                return full
        return inside
    return full  # unknown shape: mask the whole box
