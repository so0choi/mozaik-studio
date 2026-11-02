"""Pure shape rasterizer shared (by rule) with the web preview's shapes.ts.

A pixel (i, j) of the box is included when its center (i + 0.5, j + 0.5) is inside the shape.
No OpenCV: the same rule is implemented in TypeScript and checked against
contracts/fixtures/shape-masks.json.

- rect: every pixel.
- ellipse: ((px - w/2) / (w/2))^2 + ((py - h/2) / (h/2))^2 <= 1.
- polygon: even-odd. For each edge (x1,y1)-(x2,y2) with (y1 > py) != (y2 > py), the edge toggles
  inside-ness when px < x1 + (py - y1) * (x2 - x1) / (y2 - y1).
- A box with w < 4 or h < 4 is always rect, so a tiny shape can never collapse and expose a face.
- A polygon with fewer than 3 points is rect (never less masked).
"""
from __future__ import annotations

import numpy as np

MIN_SHAPE_SIZE = 4


def shape_bitmap(shape: str, w: int, h: int, points: list[list[int]] | None) -> np.ndarray:
    """(h, w) bool bitmap relative to the box origin; `points` are relative to the box origin."""
    w, h = int(w), int(h)
    if w <= 0 or h <= 0:
        return np.zeros((max(h, 0), max(w, 0)), bool)
    full = np.ones((h, w), bool)
    if shape == "rect" or w < MIN_SHAPE_SIZE or h < MIN_SHAPE_SIZE:
        return full
    px = (np.arange(w, dtype=np.float64) + 0.5)[None, :]
    py = (np.arange(h, dtype=np.float64) + 0.5)[:, None]
    if shape == "ellipse":
        rx, ry = w / 2, h / 2
        return ((px - rx) / rx) ** 2 + ((py - ry) / ry) ** 2 <= 1.0
    if shape == "polygon":
        if not points or len(points) < 3:
            return full
        inside = np.zeros((h, w), bool)
        n = len(points)
        for k in range(n):
            x1, y1 = points[k]
            x2, y2 = points[(k + 1) % n]
            if y1 == y2:
                continue
            crosses = (y1 > py) != (y2 > py)  # (h, 1)
            xi = x1 + (py - y1) * (x2 - x1) / (y2 - y1)  # (h, 1)
            inside ^= crosses & (px < xi)
        return inside
    return full  # unknown shape: mask the whole box
