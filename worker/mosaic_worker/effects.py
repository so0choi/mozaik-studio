"""Effect parameters (spec 3.3). Parameter math only; pixel operations live elsewhere.

Integer results round half up (`int(x + 0.5)`), matching the web preview's Math.round.
"""
from __future__ import annotations

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
        "background": normalize_effect(bg) if bg else None,
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
