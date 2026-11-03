import json

import numpy as np
import pytest

from helpers import FIXTURES
from mosaic_worker.effects import shape_mask
from mosaic_worker.shapes import shape_bitmap


def _rows(bm):
    return ["".join("1" if v else "0" for v in r) for r in bm]


def test_matches_shared_shape_masks():
    cases = json.loads((FIXTURES / "shape-masks.json").read_text())
    assert len(cases) >= 5
    for c in cases:
        bm = shape_bitmap(c["shape"], c["w"], c["h"], c["points"], tuple(c["window"]) if c.get("window") else None)
        assert _rows(bm) == c["rows"], c["name"]


def test_ellipse_corners_excluded_center_included():
    bm = shape_bitmap("ellipse", 41, 31, None)
    assert bm.shape == (31, 41)
    assert not bm[0, 0] and not bm[0, 40] and not bm[30, 0] and not bm[30, 40]
    assert bm[15, 20]


def test_tiny_shape_falls_back_to_rect():
    region = {"box": [5, 5, 3, 3], "shape": "polygon", "points": [[6, 6], [6, 6], [6, 6]]}
    rows, cols, mask = shape_mask(region, 100, 100)
    assert mask.shape == (3, 3) and mask.all()
    assert shape_bitmap("ellipse", 3, 40, None).all()


def test_shape_mask_clipped_at_frame_edge():
    region = {"box": [-10, -10, 40, 40], "shape": "ellipse", "points": None}
    rows, cols, mask = shape_mask(region, 100, 100)
    assert (rows.start, rows.stop, cols.start, cols.stop) == (0, 30, 0, 30)
    full = shape_bitmap("ellipse", 40, 40, None)
    assert np.array_equal(mask, full[10:40, 10:40])
    assert not full[0, 0] and mask[0, 0]  # cut from the full ellipse, not rescaled
    # fully outside the frame -> empty
    assert shape_mask({"box": [200, 200, 10, 10], "shape": "rect", "points": None}, 100, 100)[2].size == 0


def test_polygon_points_are_absolute_in_shape_mask():
    region = {"box": [10, 20, 10, 10], "shape": "polygon", "points": [[10, 20], [20, 20], [10, 30], [20, 30]]}
    rows, cols, mask = shape_mask(region, 100, 100)
    assert _rows(mask) == _rows(shape_bitmap("polygon", 10, 10, [[0, 0], [10, 0], [0, 10], [10, 10]]))


def test_degenerate_polygon_masks_whole_box():
    assert shape_bitmap("polygon", 10, 10, [[1, 1], [5, 5]]).all()
    assert shape_bitmap("polygon", 10, 10, None).all()


def test_polygon_nonzero_fills_overlaps_and_double_traces():
    star = [[5, 0], [8, 10], [0, 4], [10, 4], [2, 10]]
    bm = shape_bitmap("polygon", 10, 10, star)
    assert bm[5, 5]  # pentagram centre: even-odd left it empty, nonzero fills it
    sq = [[1, 1], [9, 1], [9, 9], [1, 9]]
    assert _rows(shape_bitmap("polygon", 10, 10, sq + sq)) == _rows(shape_bitmap("polygon", 10, 10, sq))
    assert shape_bitmap("polygon", 10, 10, sq + sq)[5, 5]


def test_collinear_and_zero_area_polygons_fail_closed():
    assert shape_bitmap("polygon", 10, 10, [[1, 1], [5, 5], [9, 9]]).all()
    assert shape_bitmap("polygon", 10, 10, [[3, 3], [3, 3], [3, 3]]).all()
    # sliver with area < 1 px^2 that hits no pixel centre
    assert shape_bitmap("polygon", 10, 10, [[0, 0], [10, 0], [10, 0]]).all()


def test_polygon_without_covered_centres_but_intersecting_window_is_full():
    # positive area (> 1) but no pixel centre inside: thin diagonal sliver between centres
    pts = [[0, 0], [10, 10], [10, 11], [0, 1]]
    bm = shape_bitmap("polygon", 12, 12, pts)
    assert bm.any()


def test_window_matches_cropped_full_bitmap():
    for shape, pts in (("ellipse", None), ("polygon", [[5, 0], [18, 20], [0, 8], [20, 8], [2, 20]]), ("rect", None)):
        full = shape_bitmap(shape, 21, 21, pts)
        win = shape_bitmap(shape, 21, 21, pts, window=(3, 4, 15, 19))
        assert win.shape == (15, 12)
        assert np.array_equal(win, full[4:19, 3:15]), shape


def test_shape_mask_does_not_allocate_full_box(monkeypatch):
    import mosaic_worker.effects as fx
    seen = []
    orig = fx.shape_bitmap
    def spy(shape, w, h, points, window=None):
        seen.append(window)
        return orig(shape, w, h, points, window)
    monkeypatch.setattr(fx, "shape_bitmap", spy)
    rows, cols, mask = shape_mask({"box": [-10**6, -10**6, 2 * 10**6, 2 * 10**6], "shape": "ellipse", "points": None}, 50, 40)
    assert mask.shape == (40, 50)
    r2 = shape_mask({"box": [-10**6, -10**6, 2 * 10**6, 2 * 10**6], "shape": "rect", "points": None}, 50, 40)
    assert r2[2].shape == (40, 50) and r2[2].all()
    assert seen and all(w is not None for w in seen)


# ---- soft ellipse (blur on ellipse regions) ----
from mosaic_worker.compose import mask_regions  # noqa: E402
from mosaic_worker.effects import apply_region, normalize_effect  # noqa: E402
from mosaic_worker.shapes import SOFT_EDGE, face_ellipse_box, soft_ellipse_alpha, soft_extent  # noqa: E402


def test_soft_alpha_fixture_parity():
    doc = json.loads((FIXTURES / "soft-ellipse-alpha.json").read_text())
    assert len(doc["cases"]) >= 2
    for c in doc["cases"]:
        x, y, w, h = c["box"]
        for px, py, want in c["samples"]:
            a = soft_ellipse_alpha(w, h, (px - x, py - y, px - x + 1, py - y + 1))[0, 0]
            assert int(a * 255 + 0.5) == want, (c["name"], px, py)


def test_face_ellipse_geometry_from_stored_box():
    # stored (100, 50, 80, 60): c=(140, 80), a=46, b=34.5
    assert face_ellipse_box([100, 50, 80, 60]) == [94, 45, 93, 70]


def test_soft_core_equals_hard_ellipse_and_band_is_strict():
    w, h = 41, 31
    x0, y0, x1, y1 = soft_extent(w, h)
    a = soft_ellipse_alpha(w, h, (x0, y0, x1, y1))
    hard = shape_bitmap("ellipse", w, h, None)
    assert (a[-y0 : -y0 + h, -x0 : -x0 + w][hard] == 1.0).all()
    assert ((a > 0) & (a < 1)).any()
    # outside the enlarged extent's ellipse (r >= 1 + SOFT_EDGE) alpha is exactly 0
    rx, ry = w / 2, h / 2
    xs = np.arange(x0, x1)[None, :] + 0.5
    ys = np.arange(y0, y1)[:, None] + 0.5
    r = np.sqrt(((xs - rx) / rx) ** 2 + ((ys - ry) / ry) ** 2)
    assert (a[r >= 1 + SOFT_EDGE] == 0).all()
    assert (a[(r > 1) & (r < 1 + SOFT_EDGE)] < 1).all()


def test_safety_raw_box_fully_blurred():
    rng = np.random.default_rng(7)
    frame = rng.integers(0, 256, (400, 500, 3), dtype=np.uint8)
    for _ in range(40):
        w, h = int(rng.integers(8, 150)), int(rng.integers(8, 150))
        x, y = int(rng.integers(0, 500 - w)), int(rng.integers(0, 400 - h))
        # stored box = raw grown 25%; raw box = stored / 1.25, same centre
        rw, rh = w / 1.25, h / 1.25
        rx0, ry0 = x + (w - rw) / 2, y + (h - rh) / 2
        ex, ey, ew, eh = face_ellipse_box([x, y, w, h])
        x0, y0, x1, y1 = soft_extent(ew, eh)
        a = soft_ellipse_alpha(ew, eh, (x0, y0, x1, y1))
        for py in range(int(np.ceil(ry0)), int(np.floor(ry0 + rh))):
            for px in (int(np.ceil(rx0)), int(np.floor(rx0 + rw)) - 1):
                assert a[py - ey - y0, px - ex - x0] == 1.0, (x, y, w, h, px, py)
        # all four raw corners (the worst case for an ellipse)
        for px, py in ((np.ceil(rx0), np.ceil(ry0)), (np.floor(rx0 + rw) - 1, np.floor(ry0 + rh) - 1)):
            assert a[int(py) - ey - y0, int(px) - ex - x0] == 1.0


def test_blur_composite_core_blurred_outside_untouched():
    rng = np.random.default_rng(1)
    src = rng.integers(0, 256, (120, 120, 3), dtype=np.uint8)
    out = src.copy()
    region = {"id": "a", "shape": "ellipse", "box": [30, 30, 40, 40], "points": None, "block": 8,
              "effect": {"type": "blur", "strength": 1, "color": "#000000"}}
    apply_region(src, out, region)
    changed = (out != src).any(axis=2)
    assert changed[50, 50]
    assert not changed[:5].any() and not changed[:, :5].any()
    hard = shape_bitmap("ellipse", 40, 40, None)
    assert changed[30:70, 30:70][hard].mean() > 0.95  # blurred noise differs from src everywhere in the core


def test_rect_blur_unchanged_hard_edge():
    rng = np.random.default_rng(2)
    src = rng.integers(0, 256, (80, 80, 3), dtype=np.uint8)
    out = src.copy()
    region = {"id": "a", "shape": "rect", "box": [20, 20, 30, 30], "points": None, "block": 8,
              "effect": {"type": "blur", "strength": 1, "color": "#000000"}}
    apply_region(src, out, region)
    changed = (out != src).any(axis=2)
    assert not changed[:20].any() and not changed[50:].any() and not changed[:, :20].any() and not changed[:, 50:].any()


def test_default_effect_is_blur():
    assert normalize_effect(None)["type"] == "blur"
    assert normalize_effect({"type": "nope"})["type"] == "blur"
    assert normalize_effect({"type": "mosaic"})["type"] == "mosaic"
