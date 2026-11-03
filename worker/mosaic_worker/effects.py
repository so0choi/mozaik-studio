"""Effect parameters (spec 3.3) and per-region / background pixel operations (spec 4.2).

Integer results round half up (`int(x + 0.5)`), matching the web preview's Math.round.
"""
from __future__ import annotations

import math

import cv2
import numpy as np

from .shapes import shape_bitmap

EFFECT_TYPES = ("mosaic", "blur", "color")
DEFAULT_COLOR = "#000000"


def normalize_effect(eff: dict | None) -> dict:
    eff = eff if isinstance(eff, dict) else {}
    t = eff.get("type")
    s = eff.get("strength")
    c = eff.get("color")
    return {
        "type": t if t in EFFECT_TYPES else "mosaic",
        "strength": int(s) if isinstance(s, int) and not isinstance(s, bool) and 1 <= s <= 5 else 1,
        "color": c if isinstance(c, str) else DEFAULT_COLOR,
    }


def normalize_effects(edits: dict) -> dict:
    fx = (edits or {}).get("effects") or {}
    bg = fx.get("background")
    overrides = fx.get("overrides") or {}
    return {
        "default": normalize_effect(fx.get("default")),
        "background": normalize_effect(bg) if isinstance(bg, dict) and bg else None,
        "overrides": {k: normalize_effect(v) for k, v in overrides.items()},
    }


def strength_factor(s: int) -> float:
    return 1 + 0.5 * (s - 1)


def region_block(base: int, s: int) -> int:
    return int(base * strength_factor(s) + 0.5)


def region_sigma(w: int, h: int, s: int) -> float:
    return max(min(w, h) / 4, 2) * strength_factor(s)


def background_block(W: int, H: int, s: int) -> int:
    return int(max(8, min(W, H) // 40) * strength_factor(s) + 0.5)


def background_sigma(W: int, H: int, s: int) -> float:
    return (min(W, H) / 60) * strength_factor(s)


def pixelate(frame: np.ndarray, box, block: int) -> None:
    """Pixelate `box` in place on a block x block grid whose origin is the box top-left."""
    x, y, w, h = (int(v) for v in box[:4])
    fh, fw = frame.shape[:2]
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(fw, x + w), min(fh, y + h)
    if x1 <= x0 or y1 <= y0:
        return
    # grid origin stays at the (unclamped) box corner
    ox, oy = x0 - x, y0 - y
    rw, rh = x1 - x0, y1 - y0
    cols = -(-(ox + rw) // block)
    rows = -(-(oy + rh) // block)
    region = frame[y0:y1, x0:x1]
    padded = cv2.copyMakeBorder(region, oy, rows * block - oy - rh, ox, cols * block - ox - rw, cv2.BORDER_REPLICATE)
    small = cv2.resize(padded, (cols, rows), interpolation=cv2.INTER_AREA)
    big = cv2.resize(small, (cols * block, rows * block), interpolation=cv2.INTER_NEAREST)
    frame[y0:y1, x0:x1] = big[oy : oy + rh, ox : ox + rw]


def _hex_to_bgr(color: str) -> tuple[int, int, int]:
    c = color.lstrip("#")
    try:
        r, g, b = int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)
    except (ValueError, IndexError):
        r = g = b = 0
    return b, g, r


def shape_mask(region: dict, frame_w: int, frame_h: int) -> tuple[slice, slice, np.ndarray]:
    """Frame-clipped (rows, cols, bool mask). Only the frame-visible window of the box is rasterized."""
    x, y, w, h = (int(v) for v in region["box"][:4])
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(frame_w, x + w), min(frame_h, y + h)
    if x1 <= x0 or y1 <= y0:
        return slice(0, 0), slice(0, 0), np.zeros((0, 0), bool)
    pts = region.get("points")
    rel = [[px - x, py - y] for px, py in pts] if pts else None
    bm = shape_bitmap(region["shape"], w, h, rel, (x0 - x, y0 - y, x1 - x, y1 - y))
    return slice(y0, y1), slice(x0, x1), bm


def apply_region(src: np.ndarray, out: np.ndarray, region: dict) -> None:
    """Compute the region's effect from `src` and write it into `out` where the shape mask is set."""
    fh, fw = src.shape[:2]
    rows, cols, mask = shape_mask(region, fw, fh)
    if mask.size == 0:
        return
    x, y, w, h = (int(v) for v in region["box"][:4])
    eff = region["effect"]
    kind = eff["type"]
    if kind == "mosaic":
        res = src[rows, cols].copy()
        pixelate(res, (x - cols.start, y - rows.start, w, h), region["block"])
    elif kind == "blur":
        sigma = region_sigma(w, h, eff["strength"])
        m = math.ceil(3 * sigma)
        y0, y1 = max(0, rows.start - m), min(fh, rows.stop + m)
        x0, x1 = max(0, cols.start - m), min(fw, cols.stop + m)
        win = src[y0:y1, x0:x1]
        ww, wh = x1 - x0, y1 - y0
        f = max(1, int(sigma // 4))
        if f > 1:
            sw, sh = max(1, -(-ww // f)), max(1, -(-wh // f))
            small = cv2.resize(win, (sw, sh), interpolation=cv2.INTER_AREA)
            small = cv2.GaussianBlur(small, (0, 0), sigmaX=sigma / f, borderType=cv2.BORDER_REPLICATE)
            big = cv2.resize(small, (ww, wh), interpolation=cv2.INTER_LINEAR)
        else:
            big = cv2.GaussianBlur(win, (0, 0), sigmaX=sigma, borderType=cv2.BORDER_REPLICATE)
        res = big[rows.start - y0 : rows.stop - y0, cols.start - x0 : cols.stop - x0]
    elif kind == "color":
        res = np.empty_like(src[rows, cols])
        res[:] = _hex_to_bgr(eff["color"])
    else:
        raise ValueError(f"unknown effect type {kind!r}")
    target = out[rows, cols]
    target[mask] = res[mask]


def apply_background(src: np.ndarray, effect: dict) -> np.ndarray:
    """Effect over the whole frame; returns a new array."""
    fh, fw = src.shape[:2]
    kind, s = effect["type"], effect["strength"]
    if kind == "mosaic":
        out = src.copy()
        pixelate(out, (0, 0, fw, fh), background_block(fw, fh, s))
        return out
    if kind == "blur":
        sigma = background_sigma(fw, fh, s)
        sw, sh = max(1, fw // 4), max(1, fh // 4)
        small = cv2.resize(src, (sw, sh), interpolation=cv2.INTER_AREA)
        small = cv2.GaussianBlur(small, (0, 0), sigmaX=max(sigma / 4, 1e-3), borderType=cv2.BORDER_REPLICATE)
        return cv2.resize(small, (fw, fh), interpolation=cv2.INTER_LINEAR)
    if kind == "color":
        out = np.empty_like(src)
        out[:] = _hex_to_bgr(effect["color"])
        return out
    raise ValueError(f"unknown effect type {kind!r}")
