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
        bm = shape_bitmap(c["shape"], c["w"], c["h"], c["points"])
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
